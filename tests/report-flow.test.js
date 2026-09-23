import "./setup.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

process.env.INTERNAL_PROVIDER_MODE = "package";
process.env.INTERNAL_PROVIDER_PACKAGE = new URL("./fixtures/provider.mjs", import.meta.url).pathname;
process.env.BOT_RUNTIME_ROLE = "ingress";
const { config } = await import("../src/config.js");
const { requestReport } = await import("../src/usecases/requestReport.js");
const { createReportJobConsumer } = await import("../src/usecases/processReportJobs.js");
const { calls } = await import("./fixtures/provider.mjs");
const { drainReportJobQueue, createReportDeliveryConsumer, enqueueReportJob, readReportJobResult } = await import("../src/reportJobQueue.js");
const { createReportJobResultDeliverer } = await import("../src/usecases/reportJobNotifier.js");

test("ingress queues, credential-free worker runs guard, ingress delivers persisted result once", async () => {
  const edits = [];
  const message = { id: "progress", channelId: "channel", edit: async (payload) => edits.push(payload) };
  const channel = { send: async () => message, messages: { fetch: async () => message } };
  const client = { channels: { fetch: async () => channel } };
  const interaction = {
    options: { getString: (name) => name === "skill" ? "druckenmiller-market-research" : "test question" },
    user: { id: "user" }, channelId: "channel", guildId: "guild", channel, client,
    deferReply: async () => { interaction.deferred = true; },
    editReply: async () => {},
  };
  await requestReport({ interaction, channelKey: "channel", activeChannelRuns: new Map() });
  assert.deepEqual(calls, [], "ingress must not run the LLM guard or research");
  assert.equal((await fs.readdir(config.reportJobQueuePendingDir)).length, 1);
  const consumer = createReportJobConsumer();
  await drainReportJobQueue(consumer);
  const resultName = (await fs.readdir(config.reportJobQueueProcessedDir)).find((name) => name.endsWith(".result.json"));
  const result = JSON.parse(await fs.readFile(path.join(config.reportJobQueueProcessedDir, resultName), "utf8"));
  assert.equal(result.status, "rejected");
  assert.equal(result.job.delivery.channelId, "channel");
  const deliver = createReportDeliveryConsumer({ deliverResult: createReportJobResultDeliverer({ client }) });
  await deliver();
  await deliver();
  assert.equal(edits.length, 1);
  assert.match(edits[0].content, /test guard rejected/);
});

test("artifact sync retries before granting access, and a delivery retry reuses its saved grant", async () => {
  let authorizations = 0;
  let grant;
  let sendFails = true;
  const channel = { send: async () => { if (sendFails) throw new Error("Discord offline"); } };
  const deliver = createReportJobResultDeliverer({
    client: { channels: { fetch: async () => channel } },
    authorize: async () => { authorizations++; return { allowed: true }; },
  });
  const params = {
    item: { skillName: "test", delivery: { channelId: "channel", discordUserId: "user" } },
    result: { status: "ok", runId: "artifact-test", report: { html_path: "report.html", png_paths: ["page.png"] } },
    saveAccessGrant: async (value) => { grant = value; },
  };
  await assert.rejects(deliver(params), /ENOENT/);
  assert.equal(authorizations, 0);
  const runDir = path.join(config.runsDir, "artifact-test");
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "report.html"), "test");
  await fs.writeFile(path.join(runDir, "page.png"), "test");
  await assert.rejects(deliver(params), /Discord offline/);
  assert.equal(authorizations, 1);
  sendFails = false;
  assert.equal(await deliver({ ...params, accessGrant: grant }), true);
  assert.equal(authorizations, 1);
});

test("worker runs the complete research-to-report pipeline with fixture providers", async () => {
  process.env.FIXTURE_GUARD_ALLOW = "true";
  process.env.REPORT_CAPTURE_SCRIPT_PATH = new URL("./fixtures/capture.mjs", import.meta.url).pathname;
  const item = await enqueueReportJob({ skillName: "druckenmiller-market-research", question: "fixture", runId: "complete-pipeline" });
  try {
    await drainReportJobQueue(createReportJobConsumer());
    const result = await readReportJobResult(item.queueId);
    assert.equal(result.status, "ok", result.error);
    assert.equal(result.report.png_paths.length, 1);
    assert.ok(await fs.stat(path.join(config.runsDir, result.runId, result.report.html_path)));
    const html = await fs.readFile(path.join(config.runsDir, result.runId, result.report.html_path), "utf8");
    assert.match(html, /Fixture report/);
    assert.ok(!html.includes("{{PAGE1_TITLE}}"));
  } finally {
    delete process.env.FIXTURE_GUARD_ALLOW;
    delete process.env.REPORT_CAPTURE_SCRIPT_PATH;
  }
});

test("worker recovers an already committed child result after a parent crash", async () => {
  const item = await enqueueReportJob({ skillName: "druckenmiller-market-research", question: "fixture", runId: "recovery-pipeline" });
  await fs.writeFile(path.join(config.reportJobScratchDir, `${item.queueId}.exec-output.json`), JSON.stringify({
    queueId: item.queueId, runId: item.runId, status: "rejected", reason: "previous child result",
  }));
  await drainReportJobQueue(createReportJobConsumer());
  assert.equal((await readReportJobResult(item.queueId)).reason, "previous child result");
});
