import fs from "node:fs/promises";
import path from "node:path";

import { internalBenchmarkQueue, internalBenchmarkStore } from "./provider.js";

import { runBenchmarkPlanningStage } from "./reportGateway.js";

async function updateBenchmarkDiscordMessage(client, item, benchmarkMessage) {
  if (!client) {
    return;
  }

  if (
    !item.reportMessageChannelId ||
    !item.reportMessageId ||
    !item.reportMessageBaseContent
  ) {
    return;
  }

  try {
    const channel = await client.channels
      .fetch(item.reportMessageChannelId)
      .catch(() => null);
    if (!channel || typeof channel.messages?.fetch !== "function") {
      return;
    }

    const message = await channel.messages
      .fetch(item.reportMessageId)
      .catch(() => null);
    if (!message) {
      return;
    }

    await message.edit({
      content: [item.reportMessageBaseContent, benchmarkMessage].join("\n"),
    });
  } catch (error) {
    console.error(
      "Failed to update benchmark result on Discord message:",
      error,
    );
  }
}

async function planAffordableBenchmarkActions(actions) {
  const plannedActions = [];
  const skippedActions = [];
  const snapshot = await internalBenchmarkStore.loadBenchmarkSnapshot();
  const portfolio = snapshot?.portfolio || {};
  let simulatedCash = Number(portfolio.cash_balance || 0);
  const buyFeeRate = Number(portfolio.buy_fee_rate || 0);
  const sellFeeRate = Number(portfolio.sell_fee_rate || 0);
  const simulatedPositions = new Map(
    (Array.isArray(portfolio.positions) ? portfolio.positions : []).map((position) => [
      String(position?.symbol || "").trim().toUpperCase(),
      Number(position?.quantity || 0),
    ]),
  );

  for (const action of Array.isArray(actions) ? actions : []) {
    const symbol = String(action?.symbol || "").trim().toUpperCase();
    const side = String(action?.side || "").trim().toLowerCase();
    const quantity = Number(action?.quantity || 0);
    const price = Number(action?.price || 0);
    if (!symbol || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) {
      plannedActions.push(action);
      continue;
    }

    if (side === "sell") {
      const heldQuantity = Number(simulatedPositions.get(symbol) || 0);
      if (heldQuantity >= quantity) {
        const grossAmount = quantity * price;
        const feeAmount = grossAmount * sellFeeRate;
        simulatedCash += grossAmount - feeAmount;
        simulatedPositions.set(symbol, heldQuantity - quantity);
      }
      plannedActions.push(action);
      continue;
    }

    if (side !== "buy") {
      plannedActions.push(action);
      continue;
    }

    const totalRequired = quantity * price * (1 + buyFeeRate);
    if (simulatedCash + 1e-9 < totalRequired) {
      skippedActions.push({
        action,
        error: "계획 단계 잔고 기준으로 소화할 수 없는 매수 주문이라 제외했다냥.",
      });
      continue;
    }

    simulatedCash -= totalRequired;
    simulatedPositions.set(symbol, Number(simulatedPositions.get(symbol) || 0) + quantity);
    plannedActions.push(action);
  }

  return {
    plannedActions,
    skippedActions,
  };
}

export async function executeBenchmarkActions(actions) {
  const executedTrades = [];
  const {
    plannedActions,
    skippedActions: preSkippedActions,
  } = await planAffordableBenchmarkActions(actions);
  const skippedActions = [...preSkippedActions];

  for (const action of plannedActions) {
    try {
      const result = await internalBenchmarkStore.applyBenchmarkTrade(action);
      executedTrades.push(result.trade);
    } catch (error) {
      skippedActions.push({
        action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const snapshot = await internalBenchmarkStore.loadBenchmarkSnapshot();
  return {
    executedTrades,
    skippedActions,
    snapshot,
  };
}

export async function buildBenchmarkViewMessage(view) {
  const snapshot = await internalBenchmarkStore.loadBenchmarkSnapshot();
  return view === "history"
    ? internalBenchmarkStore.buildBenchmarkHistoryMessage(snapshot)
    : internalBenchmarkStore.buildBenchmarkPortfolioMessage(snapshot);
}

export async function ensureBenchmarkRuntime() {
  await internalBenchmarkStore.ensureBenchmarkFiles();
  await internalBenchmarkQueue.ensureBenchmarkQueueDirs();
}

export async function loadReportBenchmarkContext() {
  const snapshot = await internalBenchmarkStore.loadBenchmarkSnapshot();
  return {
    snapshot,
    promptContext: internalBenchmarkStore.buildBenchmarkPromptContext(snapshot),
  };
}

export function createBenchmarkQueueConsumer(client = null) {
  return async function consumeBenchmarkQueueBatch(batchItems) {
    for (const item of batchItems) {
      try {
        const researchMarkdown = await fs.readFile(
          item.researchMarkdownPath,
          "utf8",
        );
        const benchmarkSnapshot = await internalBenchmarkStore.loadBenchmarkSnapshot();
        const benchmarkJob = await runBenchmarkPlanningStage({
          skill: item.skill,
          analysisMarkdown: researchMarkdown,
          benchmarkContext:
            await internalBenchmarkStore.buildBenchmarkConsumerPromptContext(benchmarkSnapshot),
          runDir: item.runDir,
        });

        const benchmarkMarkdownPath = path.join(
          item.runDir,
          "benchmark-execution.md",
        );

        if (benchmarkJob.code !== 0) {
          const message =
            benchmarkJob.stderr || `exit code ${benchmarkJob.code}`;
          await fs.writeFile(
            benchmarkMarkdownPath,
            [
              "## 내부 벤치마크 거래 결과",
              `- 벤치마크 거래 계획 단계가 실패했다: ${message}`,
            ].join("\n"),
            "utf8",
          );
          await updateBenchmarkDiscordMessage(
            client,
            item,
            internalBenchmarkStore.buildBenchmarkDecisionFailureMessage(message),
          );
          continue;
        }

        if (!benchmarkJob.result) {
          const message = "벤치마크 거래 계획 결과를 제대로 받지 못했다.";
          await fs.writeFile(
            benchmarkMarkdownPath,
            ["## 내부 벤치마크 거래 결과", `- ${message}`].join("\n"),
            "utf8",
          );
          await updateBenchmarkDiscordMessage(
            client,
            item,
            internalBenchmarkStore.buildBenchmarkDecisionFailureMessage(message),
          );
          continue;
        }

        if (benchmarkJob.result.status !== "ok") {
          const message = benchmarkJob.result.error || "알 수 없는 오류";
          await fs.writeFile(
            benchmarkMarkdownPath,
            [
              "## 내부 벤치마크 거래 결과",
              `- 벤치마크 거래 계획 단계 오류: ${message}`,
            ].join("\n"),
            "utf8",
          );
          await updateBenchmarkDiscordMessage(
            client,
            item,
            internalBenchmarkStore.buildBenchmarkDecisionFailureMessage(message),
          );
          continue;
        }

        const executionResult = await executeBenchmarkActions(
          benchmarkJob.result.actions || [],
        );
        const benchmarkMarkdown =
          internalBenchmarkStore.buildBenchmarkExecutionMarkdown(executionResult);
        await fs.writeFile(benchmarkMarkdownPath, benchmarkMarkdown, "utf8");
        await updateBenchmarkDiscordMessage(
          client,
          item,
          internalBenchmarkStore.buildBenchmarkDecisionMessage(executionResult),
        );
      } catch (error) {
        console.error("Benchmark queue item failed:", error);
        await updateBenchmarkDiscordMessage(
          client,
          item,
          internalBenchmarkStore.buildBenchmarkDecisionFailureMessage(
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }
  };
}

export async function enqueueBenchmarkFollowup(
  queueItem,
  consumeBenchmarkQueueBatch,
) {
  await internalBenchmarkQueue.enqueueBenchmarkReport(queueItem);
  await internalBenchmarkQueue.drainBenchmarkQueue(consumeBenchmarkQueueBatch);
}

export async function drainPendingBenchmarkQueue(consumeBenchmarkQueueBatch) {
  await internalBenchmarkQueue.drainBenchmarkQueue(consumeBenchmarkQueueBatch);
}
