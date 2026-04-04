import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

import { config } from "../config.js";
import {
  fetchReportAccessStatus,
  issuePlanClaimCode,
  redeemPlanLicense,
} from "../gateways/internal/appGateway.js";

export const PLAN_REDEEM_BUTTON_ID = "plan:redeem-license";
export const PLAN_REDEEM_MODAL_ID = "plan:redeem-license-modal";
export const PLAN_REDEEM_INPUT_ID = "plan:redeem-license-input";

function formatQuota(quota) {
  if (!quota) {
    return "현재 구독 횟수 혜택은 없다냥.";
  }

  const scopeLabel =
    quota.scope_type === "guild" ? "서버 플랜" : "개인 플랜";
  return [
    `${scopeLabel}: \`${quota.tier_key}\``,
    `이번 달 사용량: \`${quota.used}/${quota.limit}\``,
    `남은 횟수: \`${quota.remaining}\``,
    `정산 월: \`${quota.period_month}\``,
  ].join("\n");
}

function formatAccess(status) {
  switch (status.access_type) {
    case "guild_subscription_quota":
      return "현재 `/report`는 서버 구독 횟수를 먼저 사용한다냥.";
    case "user_subscription_quota":
      return "현재 `/report`는 개인 구독 횟수를 사용한다냥.";
    case "subscription_quota_exhausted":
      return "이번 달 구독 횟수를 모두 사용했다냥.";
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

function buildPlanText({ status, guildId, guildName }) {
  const lines = [];

  lines.push("현재 플랜 상태다냥.");

  if (guildId) {
    lines.push(`현재 서버: \`${guildName || guildId}\``);
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

function buildFallbackPlanUrl() {
  const url = new URL(config.gumroadProductUrl);
  if (!url.searchParams.has("wanted")) {
    url.searchParams.set("wanted", "true");
  }
  return url.toString();
}

function buildClaimPlanUrl(claimCode) {
  const url = new URL(config.gumroadProductUrl);
  if (!url.searchParams.has("wanted")) {
    url.searchParams.set("wanted", "true");
  }
  url.searchParams.set(config.gumroadClaimFieldName, claimCode);
  return url.toString();
}

function buildPlanComponents(planUrl) {
  const supportButton = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel("후원으로 플랜 이용하기")
    .setURL(planUrl);
  const redeemButton = new ButtonBuilder()
    .setStyle(ButtonStyle.Secondary)
    .setLabel("라이선스 키 등록")
    .setCustomId(PLAN_REDEEM_BUTTON_ID);

  return [
    new ActionRowBuilder().addComponents(supportButton, redeemButton),
  ];
}

export function buildPlanRedeemModal() {
  const input = new TextInputBuilder()
    .setCustomId(PLAN_REDEEM_INPUT_ID)
    .setLabel("Gumroad 라이선스 키")
    .setPlaceholder("예: 85DB562A-C11D4B06-A2335A6B-8C079166")
    .setRequired(true)
    .setStyle(TextInputStyle.Short);

  return new ModalBuilder()
    .setCustomId(PLAN_REDEEM_MODAL_ID)
    .setTitle("라이선스 키 등록")
    .addComponents(new ActionRowBuilder().addComponents(input));
}

export async function buildPlanReplyPayload({
  discordUserId,
  guildId,
  guildName = "",
}) {
  let planUrl = buildFallbackPlanUrl();
  try {
    const claim = await issuePlanClaimCode({
      discordUserId,
      guildId,
      guildName,
    });
    if (claim?.claim_code) {
      planUrl = buildClaimPlanUrl(claim.claim_code);
    }
  } catch {
    planUrl = buildFallbackPlanUrl();
  }

  const status = await fetchReportAccessStatus({
    discordUserId,
    guildId: guildId || "",
  });

  return {
    content: buildPlanText({ status, guildId, guildName }),
    components: buildPlanComponents(planUrl),
    flags: MessageFlags.Ephemeral,
  };
}

export async function buildPlanLicenseRedeemReplyPayload({
  discordUserId,
  guildId,
  guildName = "",
  licenseKey,
}) {
  const redeemed = await redeemPlanLicense({
    discordUserId,
    guildId,
    guildName,
    licenseKey,
  });

  const paymentEvent = redeemed.paymentEvent || {};
  const purchase = redeemed.purchase || {};
  const scopeLabel =
    paymentEvent.scope_type === "guild" ? "서버 플랜" : "개인 플랜";

  const lines = [
    "라이선스 키를 확인하고 플랜을 반영했다냥.",
    `${scopeLabel}: \`${paymentEvent.tier_key || purchase.tierKey || "unknown"}\``,
  ];

  if (purchase.productName) {
    lines.push(`상품: \`${purchase.productName}\``);
  }

  if (purchase.claimCode) {
    lines.push(`연결 코드: \`${purchase.claimCode}\``);
  }

  return {
    content: lines.join("\n"),
    flags: MessageFlags.Ephemeral,
  };
}
