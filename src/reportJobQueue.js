import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { readJsonIfExists, writeJsonAtomic } from "./shared/atomicJson.js";
import { acquireFileLock } from "./shared/fileLock.js";

function assertQueueId(queueId) {
  if (typeof queueId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(queueId)) {
    throw new Error("Invalid report queue ID.");
  }
  return queueId;
}

function jobFileName(name) {
  // Jobs have no extra extension: .exec-input, .result, and .progress are not jobs.
  return /^[a-zA-Z0-9_-]+\.json$/.test(name);
}

async function listFiles(directory, predicate = jobFileName) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => entry.name).sort();
}

export async function ensureReportJobQueueDirs() {
  await Promise.all([
    config.reportJobQueuePendingDir, config.reportJobQueueProcessingDir,
    config.reportJobQueueProcessedDir, config.reportJobQueueFailedDir,
    config.reportJobScratchDir, config.reportJobRequestsDir,
    config.reportJobDeliveryDir, config.reportJobProgressDir,
  ].map((directory) => fs.mkdir(directory, { recursive: true })));
}

export async function readReportJobResult(queueId) {
  return readJsonIfExists(path.join(config.reportJobQueueProcessedDir, `${assertQueueId(queueId)}.result.json`));
}

async function markProcessed(filePath) {
  await fs.rename(filePath, path.join(config.reportJobQueueProcessedDir, path.basename(filePath)));
}

async function reclaimProcessingItems() {
  for (const name of await listFiles(config.reportJobQueueProcessingDir)) {
    const queueId = name.slice(0, -5);
    const filePath = path.join(config.reportJobQueueProcessingDir, name);
    if (await readReportJobResult(queueId)) {
      await markProcessed(filePath);
    } else {
      await fs.rename(filePath, path.join(config.reportJobQueuePendingDir, name));
    }
  }
}

export async function enqueueReportJob(item) {
  await ensureReportJobQueueDirs();
  const queueId = `${Date.now()}-${randomUUID()}`;
  const payload = { ...item, queueId, enqueuedAt: new Date().toISOString() };
  // Ingress retains its request while a remote worker moves its pending copy.
  const requestPath = path.join(config.reportJobRequestsDir, `${queueId}.json`);
  await writeJsonAtomic(requestPath, payload);
  try {
    await writeJsonAtomic(path.join(config.reportJobQueuePendingDir, `${queueId}.json`), payload);
  } catch (error) {
    await fs.rm(requestPath, { force: true });
    throw error;
  }
  return payload;
}

export async function findOutstandingReportJob({ channelId, discordUserId }) {
  await ensureReportJobQueueDirs();
  for (const name of await listFiles(config.reportJobRequestsDir)) {
    const item = await readJsonIfExists(path.join(config.reportJobRequestsDir, name));
    if (!item?.delivery) continue;
    const delivered = await readJsonIfExists(path.join(config.reportJobDeliveryDir, `${item.queueId}.delivered.json`));
    if (delivered) continue;
    if ((channelId && item.delivery.channelId === channelId) ||
        (discordUserId && item.delivery.discordUserId === discordUserId)) return item;
  }
  return null;
}

async function claimNextPendingItem() {
  for (const name of await listFiles(config.reportJobQueuePendingDir)) {
    const queueId = name.slice(0, -5);
    const pendingPath = path.join(config.reportJobQueuePendingDir, name);
    const filePath = path.join(config.reportJobQueueProcessingDir, name);
    try {
      await fs.rename(pendingPath, filePath);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (await readReportJobResult(queueId)) {
      await markProcessed(filePath);
      continue;
    }
    try {
      const payload = await readJsonIfExists(filePath);
      if (payload?.queueId !== queueId || !payload.skillName || !payload.question ||
          typeof payload.runId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(payload.runId)) {
        throw new Error(`Invalid report job: ${name}`);
      }
      return { filePath, payload };
    } catch (error) {
      await fs.rename(filePath, path.join(config.reportJobQueueFailedDir, name));
      await writeReportJobResult(queueId, { status: "error", error: error.message });
    }
  }
  return null;
}

export async function writeReportJobResult(queueId, result, item) {
  await writeJsonAtomic(
    path.join(config.reportJobQueueProcessedDir, `${assertQueueId(queueId)}.result.json`),
    { ...result, queueId, ...(item ? { job: item } : {}) },
  );
}

export async function writeReportJobProgress(item, progress) {
  await writeJsonAtomic(
    path.join(config.reportJobProgressDir, `${assertQueueId(item.queueId)}.progress.json`),
    { item, progress, updatedAt: new Date().toISOString() },
  );
}

export async function drainReportJobQueue(consumeBatch) {
  await ensureReportJobQueueDirs();
  const lock = await acquireFileLock(config.reportJobQueueLockDir);
  if (!lock.acquired) return false;
  const inFlight = new Set();
  let failure = null;
  try {
    await reclaimProcessingItems();
    while (!failure) {
      while (!failure && inFlight.size < config.reportJobConcurrency) {
        const item = await claimNextPendingItem();
        if (!item) break;
        const task = (async () => {
          try {
            await consumeBatch([item.payload]);
            await markProcessed(item.filePath);
          } catch (error) {
            failure ||= error;
            await fs.rename(item.filePath, path.join(config.reportJobQueuePendingDir, path.basename(item.filePath)));
          }
        })().catch((error) => { failure ||= error; }).finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
      if (inFlight.size === 0) break;
      await Promise.race(inFlight);
    }
    await Promise.allSettled(inFlight);
    if (failure) throw failure;
    return true;
  } finally {
    // Never release the lock while another claimed job is still running.
    await Promise.allSettled(inFlight);
    await lock.release();
  }
}

export async function waitForReportJobResult(queueId, timeoutMs = 15 * 60 * 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await readReportJobResult(queueId);
    if (result) return result;
    // A remote worker may move its copy before rsync publishes the result.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

export function createReportDeliveryConsumer({ deliverProgress, deliverResult }) {
  let inFlight = false;
  return async function drainDeliveries() {
    if (inFlight) return;
    inFlight = true;
    try {
      await ensureReportJobQueueDirs();
      for (const name of await listFiles(config.reportJobProgressDir, (name) => name.endsWith(".progress.json"))) {
        const event = await readJsonIfExists(path.join(config.reportJobProgressDir, name));
        if (!event?.item?.queueId || await readReportJobResult(event.item.queueId)) continue;
        try { await deliverProgress?.(event); }
        catch (error) { console.error("Report progress delivery failed:", error); }
      }
      for (const name of await listFiles(config.reportJobQueueProcessedDir, (name) => name.endsWith(".result.json"))) {
        const queueId = assertQueueId(name.slice(0, -".result.json".length));
        const deliveredPath = path.join(config.reportJobDeliveryDir, `${queueId}.delivered.json`);
        if (await readJsonIfExists(deliveredPath)) continue;
        const lock = await acquireFileLock(path.join(config.reportJobDeliveryDir, `${queueId}.lock`));
        if (!lock.acquired) continue;
        try {
          if (await readJsonIfExists(deliveredPath)) continue;
          const result = await readReportJobResult(queueId);
          const item = result.job || await readJsonIfExists(path.join(config.reportJobRequestsDir, `${queueId}.json`)) ||
            await readJsonIfExists(path.join(config.reportJobQueueProcessedDir, `${queueId}.json`));
          if (!item?.delivery) continue; // Auto reports have scheduler-owned delivery.
          const grantPath = path.join(config.reportJobDeliveryDir, `${queueId}.access.json`);
          const accessGrant = await readJsonIfExists(grantPath);
          const delivered = await deliverResult({ item, result, accessGrant,
            saveAccessGrant: (grant) => writeJsonAtomic(grantPath, grant) });
          if (delivered === true) {
            await writeJsonAtomic(deliveredPath, { queueId, deliveredAt: new Date().toISOString() });
            await fs.rm(path.join(config.reportJobQueuePendingDir, `${queueId}.json`), { force: true });
          }
        } catch (error) {
          console.error(`Report delivery will retry (${queueId}):`, error);
        } finally {
          await lock.release();
        }
      }
    } finally {
      inFlight = false;
    }
  };
}
