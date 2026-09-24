import fs from "node:fs/promises";
import path from "node:path";

import * as chartQueue from "../../charts/queue.js";
import * as chartTool from "../../charts/renderer.js";

export function createChartQueueConsumer({
  renderCharts = chartTool.renderCandidateCharts,
} = {}) {
  return async function consumeChartQueueBatch(batchItems) {
    for (const item of batchItems) {
      try {
        const result = await renderCharts({
          candidateTickersJsonPath: item.candidateTickersJsonPath,
          outRoot: item.outRoot,
          timeframes: item.timeframes || ["D", "W"],
        });

        const summaryPath = path.join(item.runDir, "chart-production.json");
        await fs.writeFile(
          summaryPath,
          `${JSON.stringify(
            {
              queueId: item.queueId,
              symbols: result.symbols,
              timeframes: result.timeframes,
              manifestPath: result.manifestPath,
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      } catch (error) {
        const failurePath = path.join(item.runDir, "chart-production-error.txt");
        await fs.writeFile(
          failurePath,
          `${error instanceof Error ? error.message : String(error)}\n`,
          "utf8",
        );
        throw error;
      }
    }
  };
}

export async function ensureChartRuntime() {
  await chartQueue.ensureChartQueueDirs();
}

export async function produceCandidateCharts({
  consumeChartQueueBatch,
  runDir,
  candidateTickersJsonPath,
  outRoot,
  timeframes = ["D"],
}) {
  const chartJob = await chartQueue.enqueueChartJob({
    runDir,
    candidateTickersJsonPath,
    outRoot,
    timeframes,
  });
  await chartQueue.drainChartQueue(consumeChartQueueBatch);

  const chartCompleted = await chartQueue.waitForChartJob(
    chartJob.queueId,
    15 * 60 * 1000,
  );
  if (!chartCompleted) {
    throw new Error("후보 차트 생산 큐가 시간 안에 끝나지 못했다냥.");
  }

  return chartTool.loadCandidateTickers(candidateTickersJsonPath);
}

export async function drainPendingChartQueue(consumeChartQueueBatch) {
  await chartQueue.drainChartQueue(consumeChartQueueBatch);
}
