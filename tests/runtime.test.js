import "./setup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startPollingTask } from "../src/startRuntime.js";

test("long-running collection does not overlap itself or block report delivery", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let collectorCalls = 0;
  let deliveries = 0;
  const stopCollector = startPollingTask(async () => { collectorCalls++; await blocked; }, 5);
  const stopDelivery = startPollingTask(async () => deliveries++, 5);
  try {
    await delay(40);
    assert.equal(collectorCalls, 1);
    assert.ok(deliveries > 1);
  } finally {
    release();
    await stopCollector();
    await stopDelivery();
  }
});
