import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from "discord.js";

import { config } from "../config.js";
import { fetchReportAccessStatus } from "../gateways/internal/appGateway.js";

const PLAN_REFRESH_BUTTON_ID = "plan:refresh";

function formatQuota(quota) {
  if (!quota) {
    return "현재 구독 quota는 없다냥.";
  }

  const scopeLabel =
    quota.scope_type === "guild" ? "서버 플랜" : "개인 플랜";
  return [
    `${scopeLabel}: \`${quota.tier_key}\``,
    `이번 달 사용량: \`${quota.used}/${quota.limit}\``,
    `남은 quota: \`${quota.remaining}\``,
    `정산 월: \`${quota.period_month}\``,
  ].join("\n");
}

function formatAccess(status) {
  switch (status.access_type) {
    case "guild_subscription_quota":
      return "현재 `/report`는 서버 구독 quota를 먼저 사용한다냥.";
    case "user_subscription_quota":
      return "현재 `/report`는 개인 구독 quota를 사용한다냥.";
    case "subscription_quota_exhausted":
      return "이번 달 구독 quota를 모두 사용했다냥.";
    case "free_once_available":
      return "아직 무료 `/report` 1회를 사용할 수 있다냥.";
    case "free_once_consumed":
      return "무료 `/report` 1회를 이미 사용했다냥.";
    case "blocked":
      return status.reason || "현재 `/report`를 사용할 수 없다냥.";
    default:
      return status.reason || "현재 플랜 상태를 확인했다냥.";
  }
}

function buildPlanText({ status, guildId, view }) {
  const lines = [];

  if (view === "personal") {
    lines.push("개인 플랜 안내다냥.");
  } else if (view === "server") {
    lines.push("서버 플랜 안내다냥.");
    lines.push(
      guildId
        ? `이 서버(\`${guildId}\`)에 서버 구독 quota를 연결할 수 있다냥.`
        : "서버 텍스트 채널에서 실행하면 서버 플랜 상태를 같이 보여준다냥.",
    );
  } else {
    lines.push("현재 플랜 상태다냥.");
  }

  lines.push(formatAccess(status));
  lines.push(formatQuota(status.quota));

  if (!status.quota) {
    const freeUsed = Number(status.report_usage?.free_report_used || 0);
    lines.push(
      freeUsed > 0
        ? "무료 `/report` 1회는 이미 사용했다냥."
        : "무료 `/report` 1회가 아직 남아 있다냥.",
    );
  }

  return lines.join("\n");
}

function buildPlanComponents({ guildId }) {
  const personalButton = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel("개인 플랜 결제")
  const serverButton = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
  const refreshButton = new ButtonBuilder()
    .setCustomId(PLAN_REFRESH_BUTTON_ID)
    .setStyle(ButtonStyle.Secondary)
    .setLabel("상태 새로고침");

  return [
    new ActionRowBuilder().addComponents(
      personalButton,
      serverButton,
      refreshButton,
    ),
  ];
}

export async function buildPlanReplyPayload({
  discordUserId,
  guildId,
  view = "status",
}) {
  const status = await fetchReportAccessStatus({
    discordUserId,
    guildId: guildId || "",
  });

  return {
    content: buildPlanText({ status, guildId, view }),
    components: buildPlanComponents({ guildId }),
    flags: MessageFlags.Ephemeral,
  };
}

export function getPlanRefreshButtonId() {
  return PLAN_REFRESH_BUTTON_ID;
}
