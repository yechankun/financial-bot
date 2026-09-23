import "./setup.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { testRoot } from "./setup.js";
import { config } from "../src/config.js";
import { createPaymentWebhookHandler, startPaymentWebhookServer } from "../src/payments/startPaymentWebhookServer.js";

async function request(handler, body, { headers = {}, url = "/gumroad/ping" } = {}) {
  const input = Readable.from([Buffer.from(body)]);
  Object.assign(input, { method: "POST", url, headers: { "content-type": "application/json", ...headers } });
  const response = { writeHead(code) { this.code = code; }, end(body) { this.body = JSON.parse(body); } };
  await handler(input, response);
  return response;
}

test("webhook startup requires a secret and disabled servers do not bind", async () => {
  assert.equal(await startPaymentWebhookServer(), null);
  config.gumroadPingEnabled = true;
  config.gumroadPingSecret = "";
  await assert.rejects(startPaymentWebhookServer(), /GUMROAD_PING_SECRET/);
  config.gumroadPingEnabled = false;
});

test("unauthenticated, malformed and oversized payloads cannot ingest payments", async () => {
  let writes = 0;
  const settings = { ...config, gumroadPingSecret: "test-secret", gumroadPingMaxBodyBytes: 100 };
  const handler = createPaymentWebhookHandler({ settings, ingest: async () => { writes++; } });
  assert.equal((await request(handler, '{"sale_id":"test"}')).code, 403);
  assert.equal((await request(handler, "{")).code, 400);
  assert.equal((await request(handler, "x".repeat(101))).code, 413);
  assert.equal((await request(createPaymentWebhookHandler({ settings: { ...settings, gumroadPingSecret: "" }, ingest: async () => writes++ }), '{}')).code, 403);
  assert.equal(writes, 0);
});

test("authenticated events ingest and logs redact secrets and license keys", async () => {
  const logPath = path.join(testRoot, "payment.jsonl");
  const settings = { ...config, gumroadPingSecret: "test-secret", gumroadPingRawLogPath: logPath };
  let event;
  const handler = createPaymentWebhookHandler({ settings, ingest: async (value) => { event = value; return { payment_event: { id: "test" } }; } });
  const response = await request(handler, JSON.stringify({ sale_id: "test", secret: "test-secret", license_key: "private-license" }));
  assert.equal(response.code, 200);
  assert.equal(event.provider, "gumroad");
  const log = await fs.readFile(logPath, "utf8");
  assert.ok(!log.includes("test-secret"));
  assert.ok(!log.includes("private-license"));
});
