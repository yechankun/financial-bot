import "./setup.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { beforeEach, test } from "node:test";
import { config } from "../src/config.js";
import { acquireFileLock } from "../src/shared/fileLock.js";
import { writeJsonAtomic } from "../src/shared/atomicJson.js";
import {
  enqueueReportJob, ensureReportJobQueueDirs, drainReportJobQueue,
  writeReportJobResult, readReportJobResult, createReportDeliveryConsumer,
} from "../src/reportJobQueue.js";

beforeEach(async () => {
  await fs.rm(config.reportJobQueueDir, { recursive: true, force: true });
  await ensureReportJobQueueDirs();
});
const enqueue = (extra = {}) => enqueueReportJob({ skillName: "test", question: "test", runId: "test-run", ...extra });

test("dead worker locks are reclaimed immediately; live locks and initialization are respected", async () => {
  const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
  await fs.mkdir(config.reportJobQueueLockDir);
  await writeJsonAtomic(path.join(config.reportJobQueueLockDir, "lock.json"), { pid: deadPid, startedAt: Date.now() });
  await enqueue();
  let count = 0;
  assert.equal(await drainReportJobQueue(async () => count++), true);
  assert.equal(count, 1);
  const first = await acquireFileLock(config.reportJobQueueLockDir);
  assert.equal(first.acquired, true);
  const second = await acquireFileLock(config.reportJobQueueLockDir);
  assert.equal(second.acquired, false);
  await second.release();
  assert.equal((await acquireFileLock(config.reportJobQueueLockDir)).acquired, false);
  await first.release();
  await fs.mkdir(config.reportJobQueueLockDir);
  assert.equal((await acquireFileLock(config.reportJobQueueLockDir)).acquired, false);
});

test("scratch JSON is not a recovered job, and completed copies are not executed twice", async () => {
  const item = await enqueue();
  await fs.rename(path.join(config.reportJobQueuePendingDir, `${item.queueId}.json`), path.join(config.reportJobQueueProcessingDir, `${item.queueId}.json`));
  await writeJsonAtomic(path.join(config.reportJobQueueProcessingDir, `${item.queueId}.exec-input.json`), item);
  await writeJsonAtomic(path.join(config.reportJobQueueProcessingDir, `${item.queueId}.exec-output.json`), { status: "ok" });
  let count = 0;
  const consume = async () => { count++; await writeReportJobResult(item.queueId, { status: "rejected" }, item); };
  await drainReportJobQueue(consume);
  assert.equal(count, 1);
  await writeJsonAtomic(path.join(config.reportJobQueuePendingDir, `${item.queueId}.json`), item);
  await drainReportJobQueue(consume);
  assert.equal(count, 1);
});

test("one failed consumer does not release the lock while another job is running", async () => {
  const a = await enqueue();
  const b = await enqueue();
  let finish;
  let failed;
  let bothStarted;
  let started = 0;
  const startBarrier = new Promise((resolve) => { bothStarted = resolve; });
  const waiting = new Promise((resolve) => { finish = resolve; });
  const failedPromise = new Promise((resolve) => { failed = resolve; });
  const draining = drainReportJobQueue(async ([item]) => {
    if (++started === 2) bothStarted();
    await startBarrier;
    if (item.queueId === a.queueId) { failed(); throw new Error("temporary failure"); }
    await waiting;
    await writeReportJobResult(item.queueId, { status: "ok" }, item);
  });
  // Ensure a second job can already be in flight when the first fails.
  await failedPromise;
  assert.equal((await acquireFileLock(config.reportJobQueueLockDir)).acquired, false);
  finish();
  await assert.rejects(draining, /temporary failure/);
  assert.ok(await fs.stat(path.join(config.reportJobQueuePendingDir, `${a.queueId}.json`)));
  await drainReportJobQueue(async ([item]) => writeReportJobResult(item.queueId, { status: "ok" }, item));
  assert.equal((await readReportJobResult(b.queueId)).status, "ok");
});

test("malformed jobs are quarantined without blocking good jobs", async () => {
  await fs.writeFile(path.join(config.reportJobQueuePendingDir, "broken.json"), "{");
  await enqueue();
  let count = 0;
  await drainReportJobQueue(async () => count++);
  assert.equal(count, 1);
  assert.equal((await readReportJobResult("broken")).status, "error");
  assert.ok(await fs.stat(path.join(config.reportJobQueueFailedDir, "broken.json")));
});

test("ingress retries delivery and acknowledges it only after confirmed success", async () => {
  const item = await enqueue({ delivery: { channelId: "test" } });
  await writeReportJobResult(item.queueId, { status: "ok" }, item);
  let attempts = 0;
  const drain = createReportDeliveryConsumer({ deliverResult: async () => ++attempts > 1 });
  await drain();
  await drain();
  await drain();
  assert.equal(attempts, 2);
  assert.ok(await fs.stat(path.join(config.reportJobDeliveryDir, `${item.queueId}.delivered.json`)));
});
