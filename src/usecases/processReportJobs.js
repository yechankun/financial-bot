import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";
import { findActiveSkill } from "../skillWhitelist.js";
import {
  executeBenchmarkActions,
  loadReportBenchmarkContext,
} from "../gateways/internal/benchmarkGateway.js";
import {
  createReportRun,
  runBenchmarkPlanningStage,
  runGuardStage,
  runMarketScreenerStage,
  runProducerStage,
  runReportStage,
  runResearchStage,
} from "../gateways/internal/reportGateway.js";
import { internalBenchmarkStore } from "../gateways/internal/provider.js";
import { hasCapability } from "../runtimeCapabilities.js";
import { writeReportJobResult } from "../reportJobQueue.js";
import {
  buildResearchArtifactPaths,
  ensureArtifactParentDirs,
  resolveResearchMarkdown,
  serializeReportArtifacts,
  validateArtifactPathsExist,
  validateReportArtifacts,
} from "../shared/reportArtifacts.js";

function buildFailureResult(queueId, error, runId = "") {
  return {
    queueId,
    status: "error",
    runId,
    error: error instanceof Error ? error.message : String(error),
  };
}

async function executeReportJob({
  skill,
  question,
  runId,
  consumeChartQueueBatch,
  consumeBenchmarkQueueBatch,
}) {
  const { runId: generatedRunId } = createReportRun(skill.name);
  const resolvedRunId = runId || generatedRunId;
  const resolvedRunDir = path.join(config.runsDir, resolvedRunId);
  const artifactPaths = buildResearchArtifactPaths(resolvedRunDir);
  await ensureArtifactParentDirs(artifactPaths);

  const guardJob = await runGuardStage({
    skill,
    question,
    runDir: resolvedRunDir,
  });
  if (guardJob.code !== 0) {
    throw new Error(
      guardJob.stderr || `사전 검사 단계가 ${guardJob.code} 코드로 끝났다냥.`,
    );
  }
  if (!guardJob.result) {
    throw new Error("사전 검사 결과를 제대로 받지 못했다냥.");
  }
  if (!guardJob.result.allow) {
    return {
      status: "rejected",
      runId: resolvedRunId,
      reason:
        guardJob.result.reason || "이 질문은 사전 검사에서 통과하지 못했다냥.",
    };
  }

  const { promptContext: benchmarkContext } = await loadReportBenchmarkContext();
  let aggregateCounts = {
    webSearchCount: 0,
    financeLookupCount: 0,
    chartAnalysisCount: 0,
  };
  const producerStageCounts = new Map();
  const aggregateProducerCounts = () =>
    [...producerStageCounts.values()].reduce(
      (totals, counts) => ({
        webSearchCount: totals.webSearchCount + (counts.webSearchCount || 0),
        financeLookupCount:
          totals.financeLookupCount + (counts.financeLookupCount || 0),
        chartAnalysisCount:
          totals.chartAnalysisCount + (counts.chartAnalysisCount || 0),
      }),
      {
        webSearchCount: 0,
        financeLookupCount: 0,
        chartAnalysisCount: 0,
      },
    );

  const runProducerStageWithValidation = async ({ stageName, expectedPaths }) => {
    producerStageCounts.set(stageName, {
      webSearchCount: 0,
      financeLookupCount: 0,
      chartAnalysisCount: 0,
    });
    const job = await runProducerStage({
      stageName,
      skill,
      question,
      artifactPaths,
      runDir: resolvedRunDir,
    });

    if (job.code !== 0) {
      throw new Error(
        job.stderr || `${stageName} 단계가 ${job.code} 코드로 끝났다냥.`,
      );
    }
    if (!job.result) {
      throw new Error(`${stageName} 결과를 제대로 받지 못했다냥.`);
    }
    if (job.result.status !== "ok") {
      throw new Error(
        job.result.error || `${stageName} 단계에서 문제가 생겼다냥.`,
      );
    }

    await validateArtifactPathsExist(expectedPaths);
    producerStageCounts.set(stageName, {
      webSearchCount: job.progress?.webSearchCount || 0,
      financeLookupCount: job.progress?.financeLookupCount || 0,
      chartAnalysisCount: job.progress?.chartAnalysisCount || 0,
    });
    aggregateCounts = aggregateProducerCounts();
  };

  const runMarketScreenerStageWithValidation = async () => {
    producerStageCounts.set("market-screener", {
      webSearchCount: 0,
      financeLookupCount: 0,
      chartAnalysisCount: 0,
    });

    const job = await runMarketScreenerStage({
      artifactPaths,
      runDir: resolvedRunDir,
    });

    if (job.code !== 0) {
      throw new Error(
        job.stderr || "market screener 단계가 실패했다냥.",
      );
    }
    if (!job.result || job.result.status !== "ok") {
      throw new Error(
        job.result?.error || "market screener 결과를 제대로 받지 못했다냥.",
      );
    }

    await validateArtifactPathsExist([
      artifactPaths.marketScreenerManifestJsonPath,
      artifactPaths.marketScreenerSummaryMarkdownPath,
      artifactPaths.stockLookupRowsJsonPath,
      artifactPaths.etfLookupRowsJsonPath,
      artifactPaths.candidateTickersJsonPath,
    ]);

    producerStageCounts.set("market-screener", {
      webSearchCount: job.progress?.webSearchCount || 0,
      financeLookupCount: job.progress?.financeLookupCount || 0,
      chartAnalysisCount: job.progress?.chartAnalysisCount || 0,
    });
    aggregateCounts = aggregateProducerCounts();
  };

  await Promise.all([
    runProducerStageWithValidation({
      stageName: "policy-search",
      expectedPaths: [artifactPaths.policyMarkdownPath],
    }),
    runProducerStageWithValidation({
      stageName: "tech-social-search",
      expectedPaths: [artifactPaths.techSocialMarkdownPath],
    }),
    runMarketScreenerStageWithValidation(),
  ]);

  const researchJob = await runResearchStage({
    skill,
    question,
    runDir: resolvedRunDir,
    artifactPaths,
  });
  if (researchJob.code !== 0) {
    throw new Error(
      researchJob.stderr ||
        `리서치 단계가 ${researchJob.code} 코드로 끝났다냥.`,
    );
  }
  if (!researchJob.result) {
    throw new Error("리서치 결과를 제대로 받지 못했다냥.");
  }
  if (researchJob.result.status !== "ok") {
    throw new Error(
      researchJob.result.error || "리서치 단계에서 문제가 생겼다냥.",
    );
  }

  const researchMarkdown = await resolveResearchMarkdown(resolvedRunDir, researchJob);
  const researchMarkdownPath = path.join(resolvedRunDir, "research.md");
  await fs.writeFile(researchMarkdownPath, researchMarkdown, "utf8");

  const reportJob = await runReportStage({
    skill,
    analysisMarkdown: researchMarkdown,
    runDir: resolvedRunDir,
  });
  if (reportJob.code !== 0) {
    throw new Error(
      reportJob.stderr || `리포트 단계가 ${reportJob.code} 코드로 끝났다냥.`,
    );
  }
  if (!reportJob.result) {
    throw new Error("리포트 결과를 제대로 받지 못했다냥.");
  }
  if (reportJob.result.status !== "ok") {
    throw new Error(
      reportJob.result.error || "리포트 단계에서 문제가 생겼다냥.",
    );
  }

  await validateReportArtifacts(resolvedRunDir, reportJob.result.report);

  let benchmark = null;
  if (hasCapability("ai-trading")) {
    try {
      const benchmarkSnapshot = await internalBenchmarkStore.loadBenchmarkSnapshot();
      const benchmarkJob = await runBenchmarkPlanningStage({
        skill,
        analysisMarkdown: researchMarkdown,
        benchmarkContext:
          await internalBenchmarkStore.buildBenchmarkConsumerPromptContext(
            benchmarkSnapshot,
          ),
        runDir: resolvedRunDir,
      });

      if (
        benchmarkJob.code === 0 &&
        benchmarkJob.result &&
        benchmarkJob.result.status === "ok"
      ) {
        const executionResult = await executeBenchmarkActions(
          benchmarkJob.result.actions || [],
        );
        const benchmarkMarkdown =
          internalBenchmarkStore.buildBenchmarkExecutionMarkdown(executionResult);
        await fs.writeFile(
          path.join(resolvedRunDir, "benchmark-execution.md"),
          benchmarkMarkdown,
          "utf8",
        );
        benchmark = {
          status: "ok",
          message:
            internalBenchmarkStore.buildBenchmarkDecisionMessage(executionResult),
        };
      } else {
        const message =
          benchmarkJob.result?.error ||
          benchmarkJob.stderr ||
          `exit code ${benchmarkJob.code}`;
        benchmark = {
          status: "error",
          message:
            internalBenchmarkStore.buildBenchmarkDecisionFailureMessage(message),
        };
      }
    } catch (error) {
      benchmark = {
        status: "error",
        message: internalBenchmarkStore.buildBenchmarkDecisionFailureMessage(
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
  } else if (consumeBenchmarkQueueBatch) {
    // Reserved for future queue-backed benchmark follow-up in non-worker runtimes.
    void consumeBenchmarkQueueBatch;
  }

  return {
    status: "ok",
    runId: resolvedRunId,
    report: serializeReportArtifacts(resolvedRunDir, reportJob.result.report),
    metrics: aggregateCounts,
    benchmark,
  };
}

export function createReportJobConsumer({
  consumeChartQueueBatch,
  consumeBenchmarkQueueBatch,
}) {
  return async function consumeReportJobBatch(batchItems) {
    for (const item of batchItems) {
      let result;

      try {
        const skill = await findActiveSkill(item.skillName);
        if (!skill) {
          result = buildFailureResult(
            item.queueId,
            new Error(`활성화되지 않았거나 없는 스킬이다냥: ${item.skillName}`),
            item.runId,
          );
        } else {
          result = await executeReportJob({
            skill,
            question: item.question,
            runId: item.runId,
            consumeChartQueueBatch,
            consumeBenchmarkQueueBatch,
          });
          result.queueId = item.queueId;
        }
      } catch (error) {
        result = buildFailureResult(item.queueId, error, item.runId);
      }

      await writeReportJobResult(item.queueId, result);
    }
  };
}
