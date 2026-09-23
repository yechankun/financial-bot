import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
export const calls = [];
export const internalResearch = {
  createRunId: () => `test-${randomUUID()}`,
  async runResearchJob({ stageName, runDir, prompt, onEvent }) {
    calls.push(stageName);
    if (stageName === "guard") return { code: 0, result: {
      allow: process.env.FIXTURE_GUARD_ALLOW === "true", reason: "test guard rejected", scope_mode: "broad",
    } };
    const stageDir = path.join(runDir, stageName);
    await fs.mkdir(stageDir, { recursive: true });
    if (stageName === "policy-search") {
      await fs.writeFile(prompt.artifactPaths.policyMarkdownPath, "test policy");
    }
    await onEvent?.({ status: "completed", webSearchCount: 1 });
    return { code: 0, stageDir, startedAt: new Date().toISOString(), result: {
      status: "ok", analysis_markdown: "test research and decision", report_title: "Fixture report",
    } };
  },
};
export const internalPrompts = {
  buildGuardPrompt: () => "test guard",
  buildPolicySearchPrompt: (args) => args,
  buildResearchPrompt: () => "test research",
  buildDecisionPrompt: () => "test decision",
  buildReportPrompt: () => "test report",
};
export const internalAppStorage = {
  getReportAccessStatus: async () => ({ allowed: true }),
  authorizeReportAccess: async () => ({ allowed: true, access_type: "subscribed" }),
  getReportCache: async () => null,
  putReportCache: async () => ({}),
  touchUserReportRequest: async () => ({}),
};
export const internalBenchmarkStore = {
  loadBenchmarkSnapshot: async () => ({ marketSession: { tradingDate: "2026-09-11", session: "closed" } }),
  buildBenchmarkPromptContext: () => "test benchmark context",
};
export const internalMarketStorage = {
  getMarketDataCapabilities: () => ({ contractVersion: 1, tradingViewFallback: false }),
  resolveReportQuestionScope: async () => ({ scope_mode: "broad" }),
  async generateReportScreenerArtifacts({ artifactPaths }) {
    for (const [key, file] of Object.entries(artifactPaths)) {
      if (key.includes("Dir")) continue;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, file.endsWith(".json") ? "[]" : "fixture research");
    }
    return { status: "ok" };
  },
};
export const internalBenchmarkQueue = {};
export const internalChartQueue = {};
export const internalChartTool = {};
export const internalCollectorRuntime = {};
