import { internalAppStorage } from "./provider.js";

export async function fetchReportAccessStatus({ discordUserId }) {
  return internalAppStorage.getReportAccessStatus({ discordUserId });
}

export async function grantReportAccess({ discordUserId }) {
  return internalAppStorage.authorizeReportAccess({ discordUserId });
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
