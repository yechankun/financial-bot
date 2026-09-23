import path from "node:path";
import fs from "node:fs/promises";

import { config } from "../../config.js";
import { internalMarketStorage, internalPrompts, internalResearch } from "./provider.js";
import { renderReportPlanToBundle } from "../../shared/reportPlanRenderer.js";

const PRODUCER_PROMPT_BUILDERS = {
  "policy-search": (args) => internalPrompts.buildPolicySearchPrompt(args),
};

export function createReportRun(skillName) {
  const runId = internalResearch.createRunId(skillName);
  return {
    runId,
    runDir: path.join(config.runsDir, runId),
  };
}

export async function runGuardStage({ skill, question, runDir }) {
  return internalResearch.runResearchJob({
    prompt: internalPrompts.buildGuardPrompt({ skill, question }),
    schemaPath: config.guardSchemaPath,
    runDir,
    stageName: "guard",
    sandboxMode: "read-only",
  });
}

export async function runProducerStage({
  stageName,
  skill,
  question,
  artifactPaths,
  runDir,
  onEvent,
}) {
  const buildPrompt = PRODUCER_PROMPT_BUILDERS[stageName];
  if (!buildPrompt) {
    throw new Error(`Unknown producer stage: ${stageName}`);
  }

  return internalResearch.runResearchJob({
    prompt: buildPrompt({
      skill,
      question,
      artifactPaths,
    }),
    schemaPath: config.producerSchemaPath,
    runDir,
    stageName,
    // Producers write their markdown artifact into the run directory; nothing else may be written.
    sandboxMode: "workspace-write",
    reasoningEffort: stageName === "policy-search" ? "low" : "medium",
    onEvent,
  });
}

export async function runMarketScreenerStage({
  artifactPaths,
  runDir,
  scope,
  onEvent,
}) {
  onEvent?.({
    status: "running",
    activeStepText: "미국 거래소 주식과 ETF의 재무/차트 특징을 정리하고 있다냥.",
    webSearchCount: 0,
    financeLookupCount: 0,
    chartAnalysisCount: 0,
  });

  const result = await internalMarketStorage.generateReportScreenerArtifacts({
    artifactPaths,
    runDir,
    scope,
  });

  onEvent?.({
    status: "completed",
    activeStepText:
      result.progress?.activeStepText || "재무/차트 후보 지도를 정리했다냥.",
    ...(result.progress || {
      webSearchCount: 0,
      financeLookupCount: 0,
      chartAnalysisCount: 0,
    }),
  });

  return {
    code: result.status === "ok" ? 0 : 1,
    result,
    progress: result.progress || {
      webSearchCount: 0,
      financeLookupCount: 0,
      chartAnalysisCount: 0,
    },
    stderr: result.status === "ok" ? "" : result.error || "market screener stage failed",
  };
}

export async function runResearchStage({
  skill,
  question,
  runDir,
  artifactPaths,
  onEvent,
}) {
  return internalResearch.runResearchJob({
    prompt: internalPrompts.buildResearchPrompt({
      skill,
      question,
      runDir,
      artifactPaths,
    }),
    schemaPath: config.researchSchemaPath,
    runDir,
    stageName: "research",
    sandboxMode: "read-only",
    onEvent,
  });
}

export async function runDecisionStage({
  skill,
  question,
  candidateResearchMarkdown,
  runDir,
  artifactPaths,
  onEvent,
}) {
  const policyMarkdown = await fs
    .readFile(artifactPaths.policyMarkdownPath, "utf8")
    .catch(() => "");
  const decisionPriorMarkdown = await fs
    .readFile(artifactPaths.decisionPriorMarkdownPath, "utf8")
    .catch(() => "");

  return internalResearch.runResearchJob({
    prompt: internalPrompts.buildDecisionPrompt({
      skill,
      question,
      candidateResearchMarkdown,
      policyMarkdown,
      decisionPriorMarkdown,
      artifactPaths,
      runDir,
    }),
    schemaPath: config.researchSchemaPath,
    runDir,
    stageName: "decision",
    sandboxMode: "read-only",
    onEvent,
  });
}

export async function runReportStage({
  skill,
  analysisMarkdownPath,
  runDir,
  onEvent,
}) {
  onEvent?.({
    status: "running",
    activeStepText: "고정 리포트 템플릿용 슬롯을 정리하고 있다냥.",
    webSearchCount: 0,
    financeLookupCount: 0,
    chartAnalysisCount: 0,
  });

  const startedAtMs = Date.now();
  const planJob = await internalResearch.runResearchJob({
    prompt: internalPrompts.buildReportPrompt({
      analysisMarkdownPath,
      runDir,
      skill,
    }),
    schemaPath: config.reportPlanSchemaPath,
    runDir,
    stageName: "reporting",
    sandboxMode: "read-only",
    reasoningEffort: "medium",
    onEvent,
  });

  if (planJob.code !== 0 || !planJob.result || planJob.result.status !== "ok") {
    return planJob;
  }

  onEvent?.({
    status: "running",
    activeStepText: "고정 템플릿으로 HTML 리포트를 조립하고 있다냥.",
    webSearchCount: 0,
    financeLookupCount: 0,
    chartAnalysisCount: 0,
  });

  const report = await renderReportPlanToBundle({
    runDir,
    plan: planJob.result,
  });

  onEvent?.({
    status: "running",
    activeStepText: "리포트 페이지 PNG를 캡처하고 있다냥.",
    webSearchCount: 0,
    financeLookupCount: 0,
    chartAnalysisCount: 0,
  });

  const finishedAtMs = Date.now();
  const timingPath = path.join(planJob.stageDir, "timing.json");
  const existingTiming = JSON.parse(
    await fs.readFile(timingPath, "utf8").catch(() => "{}"),
  );
  const updatedTiming = {
    ...existingTiming,
    stage_name: "reporting",
    started_at: planJob.startedAt,
    finished_at: new Date(finishedAtMs).toISOString(),
    duration_ms: Math.max(0, finishedAtMs - startedAtMs),
    event_count: Array.isArray(planJob.events) ? planJob.events.length : existingTiming.event_count || 0,
    usage: existingTiming.usage || null,
    local_render: {
      html_path: report.html_path,
      png_count: report.png_paths.length,
      supporting_paths: report.supporting_paths,
    },
  };
  await fs.writeFile(timingPath, `${JSON.stringify(updatedTiming, null, 2)}\n`, "utf8");

  return {
    ...planJob,
    finishedAt: updatedTiming.finished_at,
    durationMs: updatedTiming.duration_ms,
    result: {
      status: planJob.result.status,
      summary: planJob.result.summary,
      key_takeaways: planJob.result.key_takeaways,
      report,
      notes: planJob.result.notes,
      error: planJob.result.error,
    },
  };
}

export async function runBenchmarkPlanningStage({
  skill,
  analysisMarkdown,
  benchmarkContext,
  runDir,
  onEvent,
}) {
  return internalResearch.runResearchJob({
    prompt: internalPrompts.buildBenchmarkTradePrompt({
      skill,
      analysisMarkdown,
      benchmarkContext,
    }),
    schemaPath: config.benchmarkActionSchemaPath,
    runDir,
    stageName: "benchmarking",
    sandboxMode: "read-only",
    onEvent,
  });
}
