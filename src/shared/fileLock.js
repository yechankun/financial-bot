import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "./atomicJson.js";

const INITIALIZATION_GRACE_MS = 30_000;
const REMOTE_LEASE_MS = 5 * 60_000;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function readMetadata(lockDir) {
  return fs.readFile(path.join(lockDir, "lock.json"), "utf8")
    .then(JSON.parse).catch(() => null);
}

async function isStale(lockDir, metadata) {
  const stat = await fs.stat(path.join(lockDir, "lock.json"))
    .catch(() => fs.stat(lockDir)).catch(() => null);
  if (!stat) return false;
  if (!Number.isInteger(metadata?.pid) || metadata.pid <= 0) {
    // mkdir and metadata publication are separate operations.
    return Date.now() - (stat.isDirectory() ? stat.birthtimeMs : stat.mtimeMs) > INITIALIZATION_GRACE_MS;
  }
  if (!metadata.hostname || metadata.hostname === os.hostname()) {
    return !isProcessAlive(metadata.pid);
  }
  return Date.now() - stat.mtimeMs > REMOTE_LEASE_MS;
}

export async function acquireFileLock(lockDir, details = {}) {
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  const metadata = { ...details, pid: process.pid, hostname: os.hostname(), startedAt: Date.now(), token: randomUUID() };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.mkdir(lockDir);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await readMetadata(lockDir);
      if (!(await isStale(lockDir, existing))) {
        return { acquired: false, metadata: existing, async release() {} };
      }
      // Serialize reclamation so competing starters cannot remove a new owner's lock.
      const reaperPath = path.join(lockDir, ".reclaim");
      const reaper = await fs.open(reaperPath, "wx").catch(() => null);
      if (!reaper) {
        const reaperPid = Number(await fs.readFile(reaperPath, "utf8").catch(() => ""));
        if (reaperPid > 0 && !isProcessAlive(reaperPid)) await fs.rm(reaperPath, { force: true });
        continue;
      }
      try {
        await reaper.writeFile(String(process.pid));
        if (await isStale(lockDir, await readMetadata(lockDir))) {
          await fs.rm(lockDir, { recursive: true, force: true });
        } else {
          await fs.rm(reaperPath, { force: true });
        }
      } finally {
        await reaper.close();
      }
      continue;
    }
    try {
      await writeJsonAtomic(path.join(lockDir, "lock.json"), metadata);
    } catch (error) {
      await fs.rm(lockDir, { recursive: true, force: true });
      throw error;
    }
    const heartbeat = setInterval(() => {
      const now = new Date();
      void fs.utimes(path.join(lockDir, "lock.json"), now, now).catch(() => {});
    }, 10_000);
    heartbeat.unref();
    return {
      acquired: true,
      metadata,
      async release() {
        clearInterval(heartbeat);
        if ((await readMetadata(lockDir))?.token === metadata.token) {
          await fs.rm(lockDir, { recursive: true, force: true });
        }
      },
    };
  }
  return { acquired: false, metadata: await readMetadata(lockDir), async release() {} };
}
