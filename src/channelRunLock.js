import path from "node:path";
import { config } from "./config.js";
import { acquireFileLock } from "./shared/fileLock.js";

export async function acquireChannelRunLock(channelId, commandName) {
  const label = String(channelId).toLowerCase().replace(/[^a-z0-9]+/g, "-") || "unknown";
  return acquireFileLock(path.join(config.channelLocksDir, label), { channelId, commandName });
}
