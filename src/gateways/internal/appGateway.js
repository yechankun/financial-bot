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
  providerMembershipId,
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
    providerMembershipId,
    payload,
  });
}
