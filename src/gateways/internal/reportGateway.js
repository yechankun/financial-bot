import path from "node:path";

import { config } from "../../config.js";
import { internalMarketStorage, internalPrompts, internalResearch } from "./provider.js";

const PRODUCER_PROMPT_BUILDERS = {
  "policy-search": internalPrompts.buildPolicySearchPrompt,
  "tech-social-search": internalPrompts.buildTechSocialSearchPrompt,
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
    reasoningEffort: "medium",
    onEvent,
  });
}

export async function runMarketScreenerStage({
  artifactPaths,
  runDir,
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
    onEvent,
  });
}

export async function runReportStage({
  skill,
  analysisMarkdown,
  runDir,
  onEvent,
}) {
  return internalResearch.runResearchJob({
    prompt: internalPrompts.buildReportPrompt({
      analysisMarkdown,
      runDir,
      skill,
    }),
    schemaPath: config.reportSchemaPath,
    runDir,
    stageName: "reporting",
    onEvent,
  });
}

export async function runBenchmarkPlanningStage({
  skill,
  analysisMarkdown,
  benchmarkContext,
  runDir,
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
  });
}
