import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { config } from "../config.js";
import { findActiveSkill } from "../skillWhitelist.js";
import {
  executeBenchmarkActions,
  loadReportBenchmarkContext,
} from "../gateways/internal/benchmarkGateway.js";
import { resolveReportQuestionScope } from "../gateways/internal/marketGateway.js";
import {
  createReportRun,
  runBenchmarkPlanningStage,
  runDecisionStage,
  runGuardStage,
  runMarketScreenerStage,
  runProducerStage,
  runReportStage,
  runResearchStage,
} from "../gateways/internal/reportGateway.js";
import { internalBenchmarkStore } from "../gateways/internal/provider.js";
import { hasCapability } from "../runtimeCapabilities.js";
import { writeReportJobResult, writeReportJobProgress } from "../reportJobQueue.js";
import { writeJsonAtomic } from "../shared/atomicJson.js";
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

async function runReportJobItemInChildProcess(item, onProgress, signal) {
  const inputPath = path.join(
    config.reportJobScratchDir,
    `${item.queueId}.exec-input.json`,
  );
  const outputPath = path.join(
    config.reportJobScratchDir,
    `${item.queueId}.exec-output.json`,
  );
  const stderrPath = path.join(
    config.reportJobScratchDir,
    `${item.queueId}.exec-stderr.log`,
  );
  const scriptPath = path.join(config.repoDir, "scripts", "run_report_job_process.js");

  await writeJsonAtomic(inputPath, item);

  try {
    // The child may have committed its result just before the parent crashed.
    const previous = await fs.readFile(outputPath, "utf8").then(JSON.parse).catch(() => null);
    if (previous?.queueId === item.queueId && previous?.runId === item.runId &&
        ["ok", "error", "rejected"].includes(previous.status)) return previous;
    await fs.rm(outputPath, { force: true });
    await new Promise((resolve, reject) => {
      const detached = process.platform !== "win32";
      const child = spawn(process.execPath, [scriptPath, inputPath, outputPath], {
        cwd: config.repoDir,
        env: { ...process.env, BOT_REPORT_PARENT_PID: String(process.pid), BOT_REPORT_PROCESS_GROUP: String(detached) },
        stdio: ["ignore", "pipe", "pipe"],
        detached,
      });
      const kill = (killSignal) => {
        if (!child.pid) return;
        try { if (detached) process.kill(-child.pid, killSignal); else child.kill(killSignal); }
        catch (error) { if (error.code !== "ESRCH") console.error("Report child cleanup failed:", error); }
      };
      let abortKillTimeout;
      const abort = () => {
        kill("SIGTERM");
        abortKillTimeout = setTimeout(() => kill("SIGKILL"), 10_000);
        abortKillTimeout.unref();
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const timeout = setTimeout(() => kill("SIGTERM"), config.reportJobTimeoutMs);
      const killTimeout = setTimeout(() => kill("SIGKILL"), config.reportJobTimeoutMs + 10_000);
      timeout.unref();
      killTimeout.unref();
      let progressWrites = Promise.resolve();

      let stderr = "";
      const lineReader = readline.createInterface({ input: child.stdout });
      lineReader.on("line", (line) => {
        const text = String(line || "").trim();
        if (!text) {
          return;
        }
        try {
          const event = JSON.parse(text);
          if (event?.type === "progress" && event?.progress && onProgress) {
            progressWrites = progressWrites.then(() => onProgress(event.progress))
              .catch((error) => console.error("Report progress persistence failed:", error));
          }
        } catch {
          // Ignore non-JSON stdout noise from the child process.
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-1024 * 1024);
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        clearTimeout(killTimeout);
        clearTimeout(abortKillTimeout);
        signal?.removeEventListener("abort", abort);
        reject(error);
      });
      child.on("close", async (code) => {
        clearTimeout(timeout);
        clearTimeout(killTimeout);
        clearTimeout(abortKillTimeout);
        signal?.removeEventListener("abort", abort);
        lineReader.close();
        await progressWrites;
        if (signal?.aborted) {
          reject(new Error("Report worker stopped before completion."));
          return;
        }
        if (stderr.trim()) {
          await fs.writeFile(stderrPath, stderr, "utf8").catch(() => {});
        }
        if (code === 0) {
          resolve();
          return;
        }
        const recoveredResult = await fs
          .readFile(outputPath, "utf8")
          .then((raw) => JSON.parse(raw))
          .catch(() => null);
        if (recoveredResult) {
          resolve();
          return;
        }
        reject(
          new Error(
            stderr.trim() ||
              `report job child exited with code ${code}` +
                (stderr.trim() ? "" : ` (stderr: ${stderrPath})`),
          ),
        );
      });
    });

    return JSON.parse(await fs.readFile(outputPath, "utf8"));
  } finally {
    await fs.rm(inputPath, { force: true }).catch(() => {});
    await fs.rm(outputPath, { force: true }).catch(() => {});
  }
}

async function executeReportJob({
  skill,
  question,
  runId,
  consumeChartQueueBatch,
  consumeBenchmarkQueueBatch,
  onProgress,
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

  const reportScope = await resolveReportQuestionScope({
    scopeMode: guardJob.result.scope_mode,
    targetSymbols: guardJob.result.target_symbols,
    targetCompanyQueries: guardJob.result.target_company_queries,
    targetIndustries: guardJob.result.target_industries,
  });

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
  let currentProgress = {
    status: "starting",
    phase: "producer",
    skillName: skill.name,
    activeStepText: "worker가 리포트 작업을 시작하고 있다냥.",
    completedProducerStages: 0,
    totalProducerStages: 2,
    webSearchCount: 0,
    financeLookupCount: 0,
    chartAnalysisCount: 0,
  };
  const emitProgress = async (patch = {}) => {
    currentProgress = {
      ...currentProgress,
      ...patch,
      skillName: skill.name,
    };
    if (onProgress) {
      await onProgress({ ...currentProgress });
    }
  };

  await emitProgress();

  const runProducerStageWithValidation = async ({ stageName, expectedPaths }) => {
    producerStageCounts.set(stageName, {
      status: "running",
      webSearchCount: 0,
      financeLookupCount: 0,
      chartAnalysisCount: 0,
    });
    await emitProgress({
      phase: "producer",
      activeStepText: "정책조사와 후보조사를 병렬로 진행하고 있다냥.",
      completedProducerStages: [...producerStageCounts.values()].filter((entry) => entry?.status === "completed").length,
      totalProducerStages: 2,
      webSearchCount: aggregateCounts.webSearchCount,
      financeLookupCount: aggregateCounts.financeLookupCount,
      chartAnalysisCount: aggregateCounts.chartAnalysisCount,
    });

    const job = await runProducerStage({
      stageName,
      skill,
      question,
      artifactPaths,
      runDir: resolvedRunDir,
      onEvent: async (progress) => {
        producerStageCounts.set(stageName, {
          status: progress?.status === "completed" ? "completed" : "running",
          webSearchCount: progress?.webSearchCount || 0,
          financeLookupCount: progress?.financeLookupCount || 0,
          chartAnalysisCount: progress?.chartAnalysisCount || 0,
        });
        aggregateCounts = aggregateProducerCounts();
        await emitProgress({
          phase: "producer",
          activeStepText:
            String(progress?.activeStepText || "").trim() ||
            "정책조사와 후보조사를 병렬로 진행하고 있다냥.",
          completedProducerStages: [...producerStageCounts.values()].filter((entry) => entry?.status === "completed").length,
          totalProducerStages: 2,
          webSearchCount: aggregateCounts.webSearchCount,
          financeLookupCount: aggregateCounts.financeLookupCount,
          chartAnalysisCount: aggregateCounts.chartAnalysisCount,
        });
      },
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
      status: "completed",
      webSearchCount: job.progress?.webSearchCount || 0,
      financeLookupCount: job.progress?.financeLookupCount || 0,
      chartAnalysisCount: job.progress?.chartAnalysisCount || 0,
    });
    aggregateCounts = aggregateProducerCounts();
    await emitProgress({
      phase: "producer",
      activeStepText: "정책조사와 후보조사를 병렬로 진행하고 있다냥.",
      completedProducerStages: [...producerStageCounts.values()].filter((entry) => entry?.status === "completed").length,
      totalProducerStages: 2,
      webSearchCount: aggregateCounts.webSearchCount,
      financeLookupCount: aggregateCounts.financeLookupCount,
      chartAnalysisCount: aggregateCounts.chartAnalysisCount,
    });
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
      scope: reportScope,
      onEvent: async (progress) => {
        await emitProgress({
          phase: "research",
          activeStepText:
            String(progress?.activeStepText || "").trim() ||
            "후보 공급층을 정리하고 있다냥.",
          webSearchCount: aggregateCounts.webSearchCount,
          financeLookupCount:
            aggregateCounts.financeLookupCount + (progress?.financeLookupCount || 0),
          chartAnalysisCount:
            aggregateCounts.chartAnalysisCount + (progress?.chartAnalysisCount || 0),
        });
      },
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
      artifactPaths.marketScreenerCandidatesJsonPath,
      artifactPaths.researchCandidatesJsonPath,
      artifactPaths.decisionCandidatesJsonPath,
      artifactPaths.decisionPriorMarkdownPath,
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

  const runCandidateInvestigationPipeline = async () => {
    await runMarketScreenerStageWithValidation();

    const researchJob = await runResearchStage({
      skill,
      question,
      runDir: resolvedRunDir,
      artifactPaths,
      onEvent: async (progress) => {
        await emitProgress({
          phase: "research",
          activeStepText:
            String(progress?.activeStepText || "").trim() ||
            "후보 조사 결과를 해석하고 있다냥.",
          webSearchCount:
            aggregateCounts.webSearchCount + (progress?.webSearchCount || 0),
          financeLookupCount:
            aggregateCounts.financeLookupCount + (progress?.financeLookupCount || 0),
          chartAnalysisCount:
            aggregateCounts.chartAnalysisCount + (progress?.chartAnalysisCount || 0),
        });
      },
    });
    if (researchJob.code !== 0) {
      throw new Error(
        researchJob.stderr ||
          `후보 조사 단계가 ${researchJob.code} 코드로 끝났다냥.`,
      );
    }
    if (!researchJob.result) {
      throw new Error("후보 조사 결과를 제대로 받지 못했다냥.");
    }
    if (researchJob.result.status !== "ok") {
      throw new Error(
        researchJob.result.error || "후보 조사 단계에서 문제가 생겼다냥.",
      );
    }

    aggregateCounts = {
      webSearchCount:
        aggregateCounts.webSearchCount + (researchJob.progress?.webSearchCount || 0),
      financeLookupCount:
        aggregateCounts.financeLookupCount +
        (researchJob.progress?.financeLookupCount || 0),
      chartAnalysisCount:
        aggregateCounts.chartAnalysisCount +
        (researchJob.progress?.chartAnalysisCount || 0),
    };

    const candidateResearchMarkdown = await resolveResearchMarkdown(
      resolvedRunDir,
      researchJob,
    );
    const candidateResearchMarkdownPath = path.join(
      resolvedRunDir,
      "candidate-research.md",
    );
    await fs.writeFile(
      candidateResearchMarkdownPath,
      candidateResearchMarkdown,
      "utf8",
    );
    await fs.writeFile(
      path.join(resolvedRunDir, "research.md"),
      candidateResearchMarkdown,
      "utf8",
    );

    return {
      researchJob,
      candidateResearchMarkdown,
      candidateResearchMarkdownPath,
    };
  };

  const [candidateInvestigation] = await Promise.all([
    runCandidateInvestigationPipeline(),
    runProducerStageWithValidation({
      stageName: "policy-search",
      expectedPaths: [artifactPaths.policyMarkdownPath],
    }),
  ]);

  const decisionJob = await runDecisionStage({
    skill,
    question,
    runDir: resolvedRunDir,
    artifactPaths,
    candidateResearchMarkdown: candidateInvestigation.candidateResearchMarkdown,
    onEvent: async (progress) => {
      await emitProgress({
        phase: "decision",
        activeStepText:
          String(progress?.activeStepText || "").trim() ||
          "드러켄밀러식 판단을 정리하고 있다냥.",
        webSearchCount:
          aggregateCounts.webSearchCount + (progress?.webSearchCount || 0),
        financeLookupCount:
          aggregateCounts.financeLookupCount + (progress?.financeLookupCount || 0),
        chartAnalysisCount:
          aggregateCounts.chartAnalysisCount + (progress?.chartAnalysisCount || 0),
      });
    },
  });
  if (decisionJob.code !== 0) {
    throw new Error(
      decisionJob.stderr ||
        `판단 단계가 ${decisionJob.code} 코드로 끝났다냥.`,
    );
  }
  if (!decisionJob.result) {
    throw new Error("판단 결과를 제대로 받지 못했다냥.");
  }
  if (decisionJob.result.status !== "ok") {
    throw new Error(
      decisionJob.result.error || "판단 단계에서 문제가 생겼다냥.",
    );
  }

  aggregateCounts = {
    webSearchCount:
      aggregateCounts.webSearchCount + (decisionJob.progress?.webSearchCount || 0),
    financeLookupCount:
      aggregateCounts.financeLookupCount +
      (decisionJob.progress?.financeLookupCount || 0),
    chartAnalysisCount:
      aggregateCounts.chartAnalysisCount +
      (decisionJob.progress?.chartAnalysisCount || 0),
  };

  const decisionMarkdown = await resolveResearchMarkdown(resolvedRunDir, decisionJob);
  const decisionMarkdownPath = path.join(resolvedRunDir, "decision.md");
  await fs.writeFile(decisionMarkdownPath, decisionMarkdown, "utf8");

  const runReportStageWithValidation = async () => {
    const reportJob = await runReportStage({
      skill,
      analysisMarkdownPath: decisionMarkdownPath,
      runDir: resolvedRunDir,
      onEvent: async (progress) => {
        await emitProgress({
          phase: "report",
          activeStepText:
            String(progress?.activeStepText || "").trim() ||
            "최종 보고서를 렌더링중이다냥.",
          webSearchCount: aggregateCounts.webSearchCount,
          financeLookupCount: aggregateCounts.financeLookupCount,
          chartAnalysisCount: aggregateCounts.chartAnalysisCount,
        });
      },
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
    return reportJob;
  };

  const runBenchmarkPipeline = async () => {
    if (!hasCapability("ai-trading")) {
      if (consumeBenchmarkQueueBatch) {
        // Reserved for future queue-backed benchmark follow-up in non-worker runtimes.
        void consumeBenchmarkQueueBatch;
      }
      return null;
    }

    try {
      const benchmarkSnapshot = await internalBenchmarkStore.loadBenchmarkSnapshot();
      const benchmarkJob = await runBenchmarkPlanningStage({
        skill,
        analysisMarkdown: decisionMarkdown,
        benchmarkContext:
          await internalBenchmarkStore.buildBenchmarkConsumerPromptContext(
            benchmarkSnapshot,
          ),
        runDir: resolvedRunDir,
        onEvent: async (progress) => {
          await emitProgress({
            phase: "report",
            activeStepText:
              String(progress?.activeStepText || "").trim() ||
              "벤치마크 시뮬레이션 결정을 정리하고 있다냥.",
            webSearchCount:
              aggregateCounts.webSearchCount + (progress?.webSearchCount || 0),
            financeLookupCount:
              aggregateCounts.financeLookupCount + (progress?.financeLookupCount || 0),
            chartAnalysisCount:
              aggregateCounts.chartAnalysisCount + (progress?.chartAnalysisCount || 0),
          });
        },
      });

      aggregateCounts = {
        webSearchCount:
          aggregateCounts.webSearchCount + (benchmarkJob.progress?.webSearchCount || 0),
        financeLookupCount:
          aggregateCounts.financeLookupCount +
          (benchmarkJob.progress?.financeLookupCount || 0),
        chartAnalysisCount:
          aggregateCounts.chartAnalysisCount +
          (benchmarkJob.progress?.chartAnalysisCount || 0),
      };

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
        return {
          status: "ok",
          message:
            internalBenchmarkStore.buildBenchmarkDecisionMessage(executionResult),
        };
      }

      const message =
        benchmarkJob.result?.error ||
        benchmarkJob.stderr ||
        `exit code ${benchmarkJob.code}`;
      return {
        status: "error",
        message:
          internalBenchmarkStore.buildBenchmarkDecisionFailureMessage(message),
      };
    } catch (error) {
      return {
        status: "error",
        message: internalBenchmarkStore.buildBenchmarkDecisionFailureMessage(
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
  };

  const [reportJob, benchmark] = await Promise.all([
    runReportStageWithValidation(),
    runBenchmarkPipeline(),
  ]);

  if (!hasCapability("ai-trading") && consumeBenchmarkQueueBatch) {
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

export async function executeReportJobItem(item, onProgress) {
  try {
    const skill = await findActiveSkill(item.skillName);
    if (!skill) {
      return buildFailureResult(
        item.queueId,
        new Error(`활성화되지 않았거나 없는 스킬이다냥: ${item.skillName}`),
        item.runId,
      );
    }

    const result = await executeReportJob({
      skill,
      question: item.question,
      runId: item.runId,
      onProgress,
    });
    result.queueId = item.queueId;
    return result;
  } catch (error) {
    return buildFailureResult(item.queueId, error, item.runId);
  }
}

export function createReportJobConsumer({ signal } = {}) {
  async function processOneBatchItem(item) {
    const result = await runReportJobItemInChildProcess(item, async (progress) => {
      await writeReportJobProgress(item, progress);
    }, signal).catch((error) => {
      if (signal?.aborted) throw error;
      return buildFailureResult(item.queueId, error, item.runId);
    });

    await writeReportJobResult(item.queueId, result, item);
  }

  return async function consumeReportJobBatch(batchItems) {
    await Promise.all(batchItems.map((item) => processOneBatchItem(item)));
  };
}
