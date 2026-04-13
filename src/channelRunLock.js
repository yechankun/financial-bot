import fs from "node:fs/promises";
import path from "node:path";

import { config } from "./config.js";

const STALE_LOCK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function safeLabel(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readLockMetadata(lockDir) {
  try {
    const text = await fs.readFile(path.join(lockDir, "lock.json"), "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeLockMetadata(lockDir, metadata) {
  const lockFile = path.join(lockDir, "lock.json");
  await fs.writeFile(lockFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function isStaleLock(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return true;
  }

  if (!isProcessAlive(metadata.pid)) {
    return true;
  }

  const startedAt = Number(metadata.startedAt || 0);
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    return false;
  }

  return Date.now() - startedAt > STALE_LOCK_MAX_AGE_MS;
}

export async function acquireChannelRunLock(channelId, commandName) {
  await fs.mkdir(config.channelLocksDir, { recursive: true });

  const lockDir = path.join(config.channelLocksDir, safeLabel(channelId));
  const metadata = {
    channelId,
    commandName,
    pid: process.pid,
    startedAt: Date.now()
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(lockDir);
      await writeLockMetadata(lockDir, metadata);

      return {
        acquired: true,
        metadata,
        async release() {
          await fs.rm(lockDir, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      const existing = await readLockMetadata(lockDir);
      if (isStaleLock(existing)) {
        await fs.rm(lockDir, { recursive: true, force: true });
        continue;
      }

      return {
        acquired: false,
        metadata: existing,
        async release() {}
      };
    }
  }

  return {
    acquired: false,
    metadata: await readLockMetadata(lockDir),
    async release() {}
  };
}
