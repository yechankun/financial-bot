import path from "node:path";

import { config } from "../config.js";
import {
  grantReportAccess,
  putReportCache,
} from "../gateways/internal/appGateway.js";
import {
  buildMetricsLine,
  buildProgressMessage,
  loadAttachments,
} from "../channels/discord/responders/reportProgress.js";
import {
  materializeReportArtifacts,
  validateReportArtifacts,
} from "../shared/reportArtifacts.js";

function resolveClient(clientOrGetter) {
  if (typeof clientOrGetter === "function") {
    return clientOrGetter() || null;
  }
  if (clientOrGetter && typeof clientOrGetter === "object") {
    if (typeof clientOrGetter.getClient === "function") {
      return clientOrGetter.getClient() || null;
    }
    return clientOrGetter;
  }
  return null;
}

function formatElapsedDurationFromIso(startedAtIso) {
  const startedAtMs = Date.parse(String(startedAtIso || ""));
  if (!Number.isFinite(startedAtMs)) {
    return "";
  }

  const elapsedMs = Math.max(0, Date.now() - startedAtMs);
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function buildFailureMessage(item, result) {
  const mention = item?.delivery?.discordUserId
    ? `<@${item.delivery.discordUserId}> `
    : "";
  const detail = String(result?.error || "worker 리포트 실행에 실패했다냥.")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);

  return [
    `${mention}리포트 작업이 실패했다냥.`,
    `원인: ${detail}`,
  ].join("\n");
}

async function resolveSendableChannel(client, channelId) {
  const resolvedClient = resolveClient(client);
  if (!resolvedClient || !channelId) {
    return null;
  }
  const channel = await resolvedClient.channels.fetch(channelId).catch(() => null);
  if (!channel || typeof channel.send !== "function") {
    return null;
  }
  return channel;
}

async function resolveEditableProgressMessage(client, channelId, messageId) {
  if (!client || !channelId || !messageId) {
    return null;
  }
  const channel = await resolveSendableChannel(client, channelId);
  if (!channel || typeof channel.messages?.fetch !== "function") {
    return null;
  }
  return channel.messages.fetch(messageId).catch(() => null);
}

export function createReportJobProgressDeliverer({ client }) {
  const lastContentByMessageId = new Map();

  return async function deliverReportJobProgress({ item, progress }) {
    const delivery = item?.delivery;
    if (!delivery?.progressMessageChannelId || !delivery?.progressMessageId) {
      return;
    }

    const nextContent = buildProgressMessage(progress || {});
    if (!nextContent) {
      return;
    }

    const lastContent = lastContentByMessageId.get(delivery.progressMessageId);
    if (lastContent === nextContent) {
      return;
    }

    const message = await resolveEditableProgressMessage(
      client,
      delivery.progressMessageChannelId,
      delivery.progressMessageId,
    );
    if (!message) {
      return;
    }

    await message.edit({ content: nextContent });
    lastContentByMessageId.set(delivery.progressMessageId, nextContent);
    if (lastContentByMessageId.size > 1000) {
      lastContentByMessageId.delete(lastContentByMessageId.keys().next().value);
    }
  };
}

export function createReportJobResultDeliverer({ client, authorize = grantReportAccess, cacheReport = putReportCache }) {
  return async function deliverReportJobResult({ item, result, accessGrant: savedGrant, saveAccessGrant }) {
    const delivery = item?.delivery;
    if (!delivery?.channelId) {
      return false;
    }

    const channel = await resolveSendableChannel(client, delivery.channelId);
    if (!channel) {
      return false;
    }

    if (result?.status === "rejected") {
      const mention = delivery.discordUserId ? `<@${delivery.discordUserId}> ` : "";
      const progressMessage = await resolveEditableProgressMessage(
        client,
        delivery.progressMessageChannelId,
        delivery.progressMessageId,
      );
      if (progressMessage) {
        await progressMessage.edit({
          content: `${mention}${result.reason || "이 질문은 사전 검사에서 통과하지 못했다냥."}`,
        });
      } else {
        await channel.send({
          content: `${mention}${result.reason || "이 질문은 사전 검사에서 통과하지 못했다냥."}`,
        });
      }
      return true;
    }

    if (result?.status !== "ok") {
      const failureMessage = buildFailureMessage(item, result);
      const progressMessage = await resolveEditableProgressMessage(
        client,
        delivery.progressMessageChannelId,
        delivery.progressMessageId,
      );
      if (progressMessage) {
        await progressMessage.edit({ content: failureMessage });
      } else {
        await channel.send({
          content: failureMessage,
        });
      }
      return true;
    }

    const runDir = path.join(config.runsDir, result.runId);
    const materializedReport = materializeReportArtifacts(runDir, result.report);
    // Remote artifacts may arrive after result metadata. Retry before consuming access.
    await validateReportArtifacts(runDir, materializedReport);
    const attachments = await loadAttachments(materializedReport.png_paths);
    const accessGrant = savedGrant || await authorize({
      discordUserId: delivery.discordUserId || "",
      guildId: delivery.guildId || "",
    });
    if (!savedGrant) await saveAccessGrant?.(accessGrant);

    if (!accessGrant.allowed) {
      await channel.send({
        content: accessGrant.reason || "현재 `/report`를 사용할 수 없다냥.",
      });
      return true;
    }

    if (delivery.cacheDescriptor) {
      await cacheReport({
        cacheKey: delivery.cacheDescriptor.cacheKey,
        discordUserId: delivery.discordUserId || "",
        skill: item.skillName,
        questionNormalized: delivery.cacheDescriptor.questionNormalized,
        questionHash: delivery.cacheDescriptor.questionHash,
        marketSnapshotDate: delivery.cacheDescriptor.marketSnapshotDate,
        marketSessionState: delivery.cacheDescriptor.marketSessionState,
        reportMode: delivery.cacheDescriptor.reportMode,
        runDir,
        result: {
          report: result.report,
          metrics: result.metrics || {},
        },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }).catch((error) => console.error("Report cache write failed:", error));
    }

    const elapsed = formatElapsedDurationFromIso(delivery.requestedAt);
    const mention = delivery.discordUserId ? `<@${delivery.discordUserId}> ` : "";
    const finalMessageBase = [
      `${mention}리포트 완성이다냥! (${item.skillName}${elapsed ? `, 소요시간: ${elapsed}` : ""})`,
      buildMetricsLine(result.metrics || {}),
    ].join("\n");
    const finalMessage = result.benchmark?.message
      ? [finalMessageBase, result.benchmark.message].join("\n")
      : finalMessageBase;
    const progressMessage = await resolveEditableProgressMessage(
      client,
      delivery.progressMessageChannelId,
      delivery.progressMessageId,
    );

    const deliveredContent =
      accessGrant.access_type === "free_once_consumed"
        ? ["무료 `/report` 1회를 사용했다냥.", finalMessage].join("\n")
        : finalMessage;

    if (progressMessage) {
      await progressMessage.edit({
        content: deliveredContent,
        files: attachments,
      }).catch(async () => {
        await channel.send({
          content: deliveredContent,
          files: attachments,
        });
      });
    } else {
      await channel.send({
        content: deliveredContent,
        files: attachments,
      });
    }
    return true;
  };
}
