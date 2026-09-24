import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";

const STALE_LOCK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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

function isStaleLock(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return true;
  }

  if (isProcessAlive(metadata.pid)) {
    return false;
  }

  const startedAt = Number(metadata.startedAt || 0);
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    return true;
  }

  return Date.now() - startedAt > STALE_LOCK_MAX_AGE_MS;
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
  await fs.writeFile(path.join(lockDir, "lock.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function acquireChartWorkerLock() {
  const lockDir = config.chartQueueLockDir;
  const metadata = {
    pid: process.pid,
    startedAt: Date.now()
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(lockDir);
      await writeLockMetadata(lockDir, metadata);
      return {
        acquired: true,
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
        async release() {}
      };
    }
  }

  return {
    acquired: false,
    async release() {}
  };
}

export async function ensureChartQueueDirs() {
  await fs.mkdir(config.chartQueuePendingDir, { recursive: true });
  await fs.mkdir(config.chartQueueProcessingDir, { recursive: true });
  await fs.mkdir(config.chartQueueProcessedDir, { recursive: true });
}

async function reclaimProcessingItems() {
  const entries = await fs.readdir(config.chartQueueProcessingDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) =>
        fs.rename(
          path.join(config.chartQueueProcessingDir, entry.name),
          path.join(config.chartQueuePendingDir, entry.name)
        ).catch(() => {})
      )
  );
}

export async function enqueueChartJob(item) {
  await ensureChartQueueDirs();
  const queueId = `${Date.now()}-${randomUUID()}`;
  const filePath = path.join(config.chartQueuePendingDir, `${queueId}.json`);
  const payload = {
    queueId,
    enqueuedAt: new Date().toISOString(),
    ...item
  };
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

async function claimPendingBatch() {
  const entries = await fs.readdir(config.chartQueuePendingDir, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  const batch = [];

  for (const filename of files) {
    const pendingPath = path.join(config.chartQueuePendingDir, filename);
    const processingPath = path.join(config.chartQueueProcessingDir, filename);

    try {
      await fs.rename(pendingPath, processingPath);
      const raw = await fs.readFile(processingPath, "utf8");
      batch.push({
        filePath: processingPath,
        payload: JSON.parse(raw)
      });
    } catch {
      continue;
    }
  }

  return batch;
}

async function markBatchProcessed(batch) {
  await Promise.all(
    batch.map((item) =>
      fs.rename(
        item.filePath,
        path.join(config.chartQueueProcessedDir, path.basename(item.filePath))
      ).catch(() => fs.rm(item.filePath, { force: true }).catch(() => {}))
    )
  );
}

export async function drainChartQueue(consumeBatch) {
  await ensureChartQueueDirs();
  const lock = await acquireChartWorkerLock();
  if (!lock.acquired) {
    return false;
  }

  try {
    await reclaimProcessingItems();

    while (true) {
      const batch = await claimPendingBatch();
      if (batch.length === 0) {
        break;
      }

      await consumeBatch(batch.map((item) => item.payload));
      await markBatchProcessed(batch);
    }

    return true;
  } finally {
    await lock.release();
  }
}

export async function waitForChartJob(queueId, timeoutMs = 15 * 60 * 1000) {
  const filename = `${queueId}.json`;
  const processedPath = path.join(config.chartQueueProcessedDir, filename);
  const pendingPath = path.join(config.chartQueuePendingDir, filename);
  const processingPath = path.join(config.chartQueueProcessingDir, filename);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const [processed, pending, processing] = await Promise.all([
      fs.access(processedPath).then(() => true).catch(() => false),
      fs.access(pendingPath).then(() => true).catch(() => false),
      fs.access(processingPath).then(() => true).catch(() => false)
    ]);

    if (processed) {
      return true;
    }

    if (!pending && !processing) {
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return false;
}
