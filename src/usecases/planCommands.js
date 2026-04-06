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
  fetchGuildSubscription,
  fetchUserSubscription,
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

function formatInactiveSubscription(status) {
  const inactive = status.inactive_subscription;
  if (!inactive) {
    return "";
  }

  const scopeLabel =
    inactive.scope_type === "guild" ? "서버 플랜" : "개인 플랜";
  const statusLabelMap = {
    cancellation_pending: "해지 예정",
    cancelled: "해지됨",
    refunded: "환불됨",
    disputed: "분쟁 처리 중",
    chargebacked: "차지백 처리됨",
    failed: "결제 실패",
    expired: "만료됨",
  };
  const statusLabel =
    statusLabelMap[String(inactive.status || "").trim().toLowerCase()] ||
    String(inactive.status || "비활성");

  const lines = [
    `최근 ${scopeLabel}: \`${inactive.tier_key}\``,
    `상태: \`${statusLabel}\``,
  ];

  if (inactive.current_period_end) {
    lines.push(`기준 시각: \`${inactive.current_period_end}\``);
  }

  return lines.join("\n");
}

function buildPlanText({ status, guildId, guildName }) {
  const lines = [];

  lines.push("현재 플랜 상태다냥.");

  if (guildId) {
    lines.push(`현재 서버: \`${guildName || guildId}\``);
  }

  lines.push(formatAccess(status));
  lines.push(formatQuota(status.quota));

  const inactiveSubscriptionText = formatInactiveSubscription(status);
  if (inactiveSubscriptionText) {
    lines.push(inactiveSubscriptionText);
  }

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

function buildFallbackPlanUrl(baseUrl) {
  return new URL(baseUrl).toString();
}

function buildClaimPlanUrl(baseUrl, claimCode) {
  const url = new URL(baseUrl);
  url.searchParams.set(config.gumroadClaimFieldName, claimCode);
  return url.toString();
}

function buildGumroadReceiptUrl(saleId) {
  const normalizedSaleId = String(saleId || "").trim();
  if (!normalizedSaleId) {
    return "";
  }
  return `https://gumroad.com/purchases/${encodeURIComponent(normalizedSaleId)}/receipt`;
}

function isActiveSubscription(subscription) {
  if (!subscription) {
    return false;
  }

  const normalizedStatus = String(subscription.status || "").trim().toLowerCase();
  if (!["active", "trialing", "cancellation_pending"].includes(normalizedStatus)) {
    return false;
  }

  const currentPeriodEnd = String(subscription.current_period_end || "").trim();
  if (!currentPeriodEnd) {
    return true;
  }

  return currentPeriodEnd >= new Date().toISOString();
}

function buildPlanComponents({
  personalPlanUrl,
  guildPlanUrl = "",
  canPurchaseGuildPlan = false,
  personalReceiptUrl = "",
  guildReceiptUrl = "",
}) {
  const personalSupportButton = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel("개인 플랜 구매")
    .setURL(personalPlanUrl);
  const redeemButton = new ButtonBuilder()
    .setStyle(ButtonStyle.Secondary)
    .setLabel("라이선스 키 등록")
    .setCustomId(PLAN_REDEEM_BUTTON_ID);

  const primaryRow = new ActionRowBuilder().addComponents(personalSupportButton);
  if (canPurchaseGuildPlan && guildPlanUrl) {
    primaryRow.addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("이 서버 플랜 구매")
        .setURL(guildPlanUrl),
    );
  }

  const rows = [primaryRow];

  const receiptButtons = [];
  if (personalReceiptUrl) {
    receiptButtons.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("개인 영수증 보기")
        .setURL(personalReceiptUrl),
    );
  }
  if (guildReceiptUrl) {
    receiptButtons.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("서버 영수증 보기")
        .setURL(guildReceiptUrl),
    );
  }
  if (receiptButtons.length > 0) {
    rows.push(new ActionRowBuilder().addComponents(...receiptButtons));
  }

  rows.push(new ActionRowBuilder().addComponents(redeemButton));
  return rows;
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
  canManageGuild = false,
}) {
  let personalPlanUrl = buildFallbackPlanUrl(config.gumroadPersonalProductUrl);
  let guildPlanUrl = "";
  try {
    const personalClaim = await issuePlanClaimCode({
      discordUserId,
      scopeType: "user",
      guildId,
      guildName,
    });
    if (personalClaim?.claim_code) {
      personalPlanUrl = buildClaimPlanUrl(
        config.gumroadPersonalProductUrl,
        personalClaim.claim_code,
      );
    }
  } catch {
    personalPlanUrl = buildFallbackPlanUrl(config.gumroadPersonalProductUrl);
  }

  if (guildId && guildName && canManageGuild && config.gumroadGuildProductUrl) {
    try {
      const guildClaim = await issuePlanClaimCode({
        discordUserId,
        scopeType: "guild",
        guildId,
        guildName,
      });
      if (guildClaim?.claim_code) {
        guildPlanUrl = buildClaimPlanUrl(
          config.gumroadGuildProductUrl,
          guildClaim.claim_code,
        );
      } else {
        guildPlanUrl = buildFallbackPlanUrl(config.gumroadGuildProductUrl);
      }
    } catch {
      guildPlanUrl = buildFallbackPlanUrl(config.gumroadGuildProductUrl);
    }
  }

  const status = await fetchReportAccessStatus({
    discordUserId,
    guildId: guildId || "",
  });
  const [personalSubscription, guildSubscription] = await Promise.all([
    fetchUserSubscription({ discordUserId }),
    guildId ? fetchGuildSubscription({ guildId }) : Promise.resolve(null),
  ]);
  const personalReceiptUrl =
    personalSubscription &&
    personalSubscription.provider === "gumroad" &&
    isActiveSubscription(personalSubscription)
      ? buildGumroadReceiptUrl(personalSubscription.provider_sale_id)
      : "";
  const guildReceiptUrl =
    guildSubscription &&
    guildSubscription.provider === "gumroad" &&
    isActiveSubscription(guildSubscription)
      ? buildGumroadReceiptUrl(guildSubscription.provider_sale_id)
      : "";

  return {
    content: buildPlanText({ status, guildId, guildName }),
    components: buildPlanComponents({
      personalPlanUrl,
      guildPlanUrl,
      canPurchaseGuildPlan: Boolean(guildId && canManageGuild),
      personalReceiptUrl,
      guildReceiptUrl: canManageGuild ? guildReceiptUrl : "",
    }),
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
