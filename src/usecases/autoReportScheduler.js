import { config } from "../config.js";
import {
  claimIdleAutoReport,
  ensureAutoReportBaseline,
  markAutoReportPosted,
} from "../gateways/internal/appGateway.js";
import { createReportRun } from "../gateways/internal/reportGateway.js";
import { enqueueReportJob, waitForReportJobResult } from "../reportJobQueue.js";
import { materializeReportArtifacts, validateReportArtifacts } from "../shared/reportArtifacts.js";
import { loadAttachments, buildMetricsLine } from "../channels/discord/responders/reportProgress.js";
import { findActiveSkill, loadActiveSkills } from "../skillWhitelist.js";

async function resolveAutoReportSkill() {
  const configured = await findActiveSkill(config.autoReportSkill);
  if (configured) {
    return configured;
  }

  const activeSkills = await loadActiveSkills();
  if (activeSkills.length === 0) {
    throw new Error("활성화된 리포트 스킬이 없다.");
  }
  return activeSkills[0];
}

function isSendableTextChannel(channel) {
  return Boolean(channel) && typeof channel.send === "function" && !channel.isThread?.();
}

async function resolveAutoReportChannel(client) {
  if (config.autoReportChannelId) {
    const channel = await client.channels.fetch(config.autoReportChannelId).catch(() => null);
    if (isSendableTextChannel(channel)) {
      return channel;
    }
  }

  const guild = await client.guilds.fetch(config.autoReportGuildId).catch(() => null);
  if (!guild) {
    throw new Error(`자동 리포트 대상 길드를 찾지 못했다: ${config.autoReportGuildId}`);
  }

  const systemChannel = guild.systemChannelId
    ? await client.channels.fetch(guild.systemChannelId).catch(() => null)
    : null;
  if (isSendableTextChannel(systemChannel)) {
    return systemChannel;
  }

  const fetched = await guild.channels.fetch().catch(() => null);
  const candidates = [...(fetched?.values?.() || [])]
    .filter((channel) => isSendableTextChannel(channel))
    .sort((a, b) => {
      const left = Number(a.rawPosition || 0);
      const right = Number(b.rawPosition || 0);
      if (left !== right) {
        return left - right;
      }
      return String(a.id).localeCompare(String(b.id));
    });

  if (candidates.length > 0) {
    return candidates[0];
  }

  throw new Error(`길드 ${config.autoReportGuildId}에서 자동 리포트를 올릴 채널을 찾지 못했다.`);
}

async function runIdleAutoReport(client) {
  if (!config.autoReportEnabled || !config.autoReportGuildId) {
    return;
  }

  await ensureAutoReportBaseline();

  const skill = await resolveAutoReportSkill();
  const { runId, runDir } = createReportRun(skill.name);
  const claim = await claimIdleAutoReport({
    idleSeconds: Math.floor(config.autoReportIdleMs / 1000),
    runId,
  });

  if (!claim?.acquired) {
    return;
  }

  const queueItem = await enqueueReportJob({
    runId,
    skillName: skill.name,
    question: config.autoReportQuestion,
    autoReport: true,
  });

  const result = await waitForReportJobResult(
    queueItem.queueId,
    config.autoReportWaitTimeoutMs,
  );

  if (!result || result.status !== "ok") {
    throw new Error(result?.error || "자동 리포트 worker 결과를 받지 못했다.");
  }

  const materializedReport = materializeReportArtifacts(runDir, result.report);
  await validateReportArtifacts(runDir, materializedReport);
  const attachments = await loadAttachments(materializedReport.png_paths);
  const channel = await resolveAutoReportChannel(client);

  const contentLines = [
    `자동 리포트다냥! (${skill.name})`,
    buildMetricsLine(result.metrics || {}),
  ];

  if (result.benchmark?.message) {
    contentLines.push(result.benchmark.message);
  }

  await channel.send({
    content: contentLines.join("\n"),
    files: attachments,
  });

  await markAutoReportPosted({ runId });
}

export function startAutoReportScheduler({ client }) {
  if (!client || !config.autoReportEnabled || !config.autoReportGuildId) {
    return () => {};
  }

  let inFlight = false;
  const tick = async () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      await runIdleAutoReport(client);
    } catch (error) {
      console.error("Idle auto-report tick failed:", error);
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, Math.max(30_000, Number(config.autoReportCheckIntervalMs || 60_000)));
  timer.unref?.();

  return () => {
    clearInterval(timer);
  };
}
