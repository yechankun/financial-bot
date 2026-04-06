import { internalAppStorage } from "./provider.js";

export async function fetchReportAccessStatus({ discordUserId, guildId = "" }) {
  return internalAppStorage.getReportAccessStatus({ discordUserId, guildId });
}

export async function grantReportAccess({ discordUserId, guildId = "" }) {
  return internalAppStorage.authorizeReportAccess({ discordUserId, guildId });
}

export async function fetchScreenPreference({ discordUserId, category }) {
  return internalAppStorage.loadScreenPreference({ discordUserId, category });
}

export async function putScreenPreference({ discordUserId, category, criteria }) {
  return internalAppStorage.saveScreenPreference({ discordUserId, category, criteria });
}

export async function removeScreenPreference({ discordUserId, category }) {
  return internalAppStorage.deleteScreenPreference({ discordUserId, category });
}

export async function consumeCommandRateLimit({ discordUserId, command }) {
  return internalAppStorage.consumeCommandRateLimit({ discordUserId, command });
}

export async function fetchReportCache({
  skill,
  questionNormalized,
  marketSnapshotDate,
  marketSessionState,
  reportMode,
}) {
  return internalAppStorage.getReportCache({
    skill,
    questionNormalized,
    marketSnapshotDate,
    marketSessionState,
    reportMode,
  });
}

export async function putReportCache({
  cacheKey,
  discordUserId,
  skill,
  questionNormalized,
  questionHash,
  marketSnapshotDate,
  marketSessionState,
  reportMode,
  runDir,
  result,
  expiresAt,
}) {
  return internalAppStorage.putReportCache({
    cacheKey,
    discordUserId,
    skill,
    questionNormalized,
    questionHash,
    marketSnapshotDate,
    marketSessionState,
    reportMode,
    runDir,
    result,
    expiresAt,
  });
}

export async function ingestPaymentEvent({
  provider,
  eventId,
  eventType,
  scopeType,
  scopeId,
  status,
  tierKey,
  currentPeriodEnd,
  providerCustomerId,
  customerEmail,
  customerName,
  providerMembershipId,
  providerSaleId,
  claimCode,
  payload,
}) {
  return internalAppStorage.ingestPaymentEvent({
    provider,
    eventId,
    eventType,
    scopeType,
    scopeId,
    status,
    tierKey,
    currentPeriodEnd,
    providerCustomerId,
    customerEmail,
    customerName,
    providerMembershipId,
    providerSaleId,
    claimCode,
    payload,
  });
}

export async function fetchUserSubscription({ discordUserId }) {
  return internalAppStorage.getUserSubscription({ discordUserId });
}

export async function putUserSubscription({
  discordUserId,
  provider,
  status,
  tierKey = "individual_basic",
  currentPeriodEnd = "",
  providerCustomerId = "",
  providerMembershipId = "",
  providerSaleId = "",
}) {
  return internalAppStorage.putUserSubscription({
    discordUserId,
    provider,
    status,
    tierKey,
    currentPeriodEnd,
    providerCustomerId,
    providerMembershipId,
    providerSaleId,
  });
}

export async function fetchGuildSubscription({ guildId }) {
  return internalAppStorage.getGuildSubscription({ guildId });
}

export async function putGuildSubscription({
  guildId,
  provider,
  status,
  tierKey = "guild_basic",
  currentPeriodEnd = "",
  providerCustomerId = "",
  providerMembershipId = "",
  providerSaleId = "",
}) {
  return internalAppStorage.putGuildSubscription({
    guildId,
    provider,
    status,
    tierKey,
    currentPeriodEnd,
    providerCustomerId,
    providerMembershipId,
    providerSaleId,
  });
}

export async function issuePlanClaimCode({
  discordUserId,
  scopeType = "user",
  guildId = "",
  guildName = "",
}) {
  return internalAppStorage.issuePlanClaimCode({
    discordUserId,
    scopeType,
    guildId,
    guildName,
  });
}

export async function redeemPlanLicense({
  discordUserId,
  guildId = "",
  guildName = "",
  licenseKey,
}) {
  return internalAppStorage.redeemPlanLicense({
    discordUserId,
    guildId,
    guildName,
    licenseKey,
  });
}
