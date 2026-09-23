import { MessageFlags } from "discord.js";
import { acquireChannelRunLock } from "../channelRunLock.js";
import { findActiveSkill } from "../skillWhitelist.js";
import {
  fetchReportAccessStatus, fetchReportCache, grantReportAccess, touchUserReportRequest,
} from "../gateways/internal/appGateway.js";
import { loadReportBenchmarkContext } from "../gateways/internal/benchmarkGateway.js";
import { createReportRun } from "../gateways/internal/reportGateway.js";
import { createProgressMessage } from "../channels/discord/responders/channelMessages.js";
import {
  buildMetricsLine, buildProgressMessage, formatElapsedDuration, loadAttachments,
} from "../channels/discord/responders/reportProgress.js";
import { materializeReportArtifacts, validateReportArtifacts } from "../shared/reportArtifacts.js";
import { buildReportCacheDescriptor } from "../shared/reportCache.js";
import { enqueueReportJob, findOutstandingReportJob } from "../reportJobQueue.js";

async function tryServeCachedReport({ interaction, skill, cacheDescriptor, startedAt }) {
  const cache = await fetchReportCache({
    skill: skill.name,
    questionNormalized: cacheDescriptor.questionNormalized,
    marketSnapshotDate: cacheDescriptor.marketSnapshotDate,
    marketSessionState: cacheDescriptor.marketSessionState,
    reportMode: cacheDescriptor.reportMode,
  });
  if (!cache?.result?.report || !cache.run_dir) return false;
  const report = materializeReportArtifacts(cache.run_dir, cache.result.report);
  try { await validateReportArtifacts(cache.run_dir, report); }
  catch { return false; }
  const attachments = await loadAttachments(report.png_paths);
  const accessGrant = await grantReportAccess({
    discordUserId: interaction.user.id, guildId: interaction.guildId || "",
  });
  if (!accessGrant.allowed) {
    await interaction.editReply({ content: accessGrant.reason || "현재 리포트를 사용할 수 없다냥." });
    return true;
  }
  await interaction.editReply({
    content: [
      accessGrant.access_type === "free_once_consumed" ? "무료 리포트 1회를 사용했다냥." : "캐시된 리포트를 바로 꺼내왔다냥.",
      `리포트 완성이다냥! (${skill.name}, 소요시간: ${formatElapsedDuration(startedAt)})`,
      buildMetricsLine(cache.result.metrics || {}),
      "동일 조건의 최근 리포트를 재사용했다냥.",
    ].join("\n"),
    files: attachments,
  });
  return true;
}

export async function requestReport({ interaction, channelKey, activeChannelRuns }) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply();
  const startedAt = Date.now();
  const locks = [];
  try {
    const skillName = interaction.options.getString("skill", true);
    const question = interaction.options.getString("question", true).trim();
    const skill = await findActiveSkill(skillName);
    if (!skill || !question) throw new Error("활성 스킬과 질문을 확인해달라냥.");
    // Serialize admission for both the channel and the user's one-time access.
    for (const key of [channelKey, `user-${interaction.user.id}`]) {
      const lock = await acquireChannelRunLock(key, "report");
      if (!lock.acquired) {
        await interaction.editReply({ content: "이미 리포트 요청을 처리 중이다냥. 잠시 뒤에 다시 시도해달라냥." });
        return;
      }
      locks.push(lock);
    }
    const outstanding = await findOutstandingReportJob({
      channelId: interaction.channelId, discordUserId: interaction.user.id,
    });
    if (outstanding) {
      await interaction.editReply({ content: "아직 진행 중이거나 전달 대기 중인 리포트가 있다냥. 완료 후에 다시 요청해달라냥." });
      return;
    }
    activeChannelRuns.set(channelKey, { commandName: "report", startedAt });
    await touchUserReportRequest().catch((error) => console.error("Report activity update failed:", error));
    const access = await fetchReportAccessStatus({
      discordUserId: interaction.user.id, guildId: interaction.guildId || "",
    });
    if (!access.allowed) {
      await interaction.editReply({ content: access.reason || "현재 리포트를 사용할 수 없다냥." });
      return;
    }
    const { snapshot } = await loadReportBenchmarkContext();
    const cacheDescriptor = buildReportCacheDescriptor({
      skillName: skill.name, question,
      marketSnapshotDate: snapshot.marketSession?.tradingDate || "",
      marketSessionState: snapshot.marketSession?.session || "",
      reportMode: "default",
    });
    if (await tryServeCachedReport({ interaction, skill, cacheDescriptor, startedAt })) return;

    const { runId } = createReportRun(skill.name);
    const progressMessage = await createProgressMessage(interaction, buildProgressMessage({
      status: "starting", phase: "guard", skillName: skill.name,
      activeStepText: "질문 검사와 리포트 생성을 기다리고 있다냥.",
    }));
    try {
      await enqueueReportJob({
        runId, skillName: skill.name, question,
        delivery: {
          channelId: interaction.channelId || "", guildId: interaction.guildId || "",
          discordUserId: interaction.user.id, requestedAt: new Date(startedAt).toISOString(),
          cacheDescriptor,
          progressMessageChannelId: progressMessage.channelId || interaction.channelId || "",
          progressMessageId: progressMessage.id || "",
        },
      });
    } catch (error) {
      await progressMessage.edit({ content: "리포트 요청을 접수하지 못했다냥. 다시 시도해달라냥." }).catch(() => {});
      throw error;
    }
    await interaction.editReply({ content: "리포트를 요청했다냥. 아래 메시지에서 진행 상황과 결과를 확인해달라냥." });
  } catch (error) {
    console.error("Report request failed:", error);
    const content = error instanceof Error ? error.message.slice(0, 400) : "리포트 요청에 실패했다냥.";
    if (interaction.deferred || interaction.replied) await interaction.editReply({ content });
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  } finally {
    activeChannelRuns.delete(channelKey);
    for (const lock of locks.reverse()) await lock.release();
  }
}
