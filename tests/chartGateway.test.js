import "./setup.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { config } from "../src/config.js";
import {
  createChartQueueConsumer,
  produceCandidateCharts,
} from "../src/gateways/internal/chartGateway.js";

test("public chart queue preserves the queue payload and delegates rendering locally", async () => {
  await fs.rm(config.chartQueueDir, { recursive: true, force: true });
  const runDir = path.join(config.runsDir, "chart-queue-contract");
  const candidateTickersJsonPath = path.join(runDir, "candidate-tickers.json");
  const outRoot = path.join(runDir, "charts");
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    candidateTickersJsonPath,
    JSON.stringify({ rows: [{ tv_symbol: "KOSPI:005930" }] }),
    "utf8",
  );

  let renderRequest;
  const consume = createChartQueueConsumer({
    async renderCharts(request) {
      renderRequest = request;
      return {
        symbols: ["005930.KS"],
        timeframes: request.timeframes,
        manifestPath: path.join(request.outRoot, "manifest.json"),
      };
    },
  });

  const candidates = await produceCandidateCharts({
    consumeChartQueueBatch: consume,
    runDir,
    candidateTickersJsonPath,
    outRoot,
    timeframes: ["D", "W"],
  });

  assert.deepEqual(candidates.symbols, ["005930.KS"]);
  assert.equal(renderRequest.candidateTickersJsonPath, candidateTickersJsonPath);
  assert.deepEqual(renderRequest.timeframes, ["D", "W"]);

  const processedFiles = (await fs.readdir(config.chartQueueProcessedDir)).filter((name) => name.endsWith(".json"));
  assert.equal(processedFiles.length, 1);
  const queued = JSON.parse(await fs.readFile(path.join(config.chartQueueProcessedDir, processedFiles[0]), "utf8"));
  assert.equal(queued.candidateTickersJsonPath, candidateTickersJsonPath);
  assert.equal(queued.outRoot, outRoot);
  assert.deepEqual(queued.timeframes, ["D", "W"]);

  const summary = JSON.parse(await fs.readFile(path.join(runDir, "chart-production.json"), "utf8"));
  assert.equal(summary.queueId, queued.queueId);
  assert.deepEqual(summary.symbols, ["005930.KS"]);
  assert.equal(summary.manifestPath, path.join(outRoot, "manifest.json"));
});
