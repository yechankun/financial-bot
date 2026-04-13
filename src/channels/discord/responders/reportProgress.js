import fs from "node:fs/promises";
import path from "node:path";

import { AttachmentBuilder } from "discord.js";

export async function loadAttachments(pngPaths) {
  return Promise.all(
    pngPaths.map(async (pngPath) => {
      const data = await fs.readFile(pngPath);
      return new AttachmentBuilder(data, { name: path.basename(pngPath) });
    }),
  );
}

export function formatElapsedDuration(startedAt) {
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function buildMetricsLine(progress) {
  return `(웹 검색: ${String(progress.webSearchCount || 0).padStart(2, "0")}회, 재무 조회: ${String(progress.financeLookupCount || 0).padStart(2, "0")}회, 차트 분석: ${String(progress.chartAnalysisCount || 0).padStart(2, "0")}회)`;
}

export function toNyangSentence(text, fallback) {
  const source = String(text || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!source) {
    return fallback;
  }

  if (/[냥][.!?…~]*$/u.test(source) || /다냥[.!?…~]*$/u.test(source)) {
    return source;
  }

  return `${source}냥.`;
}

function formatMultilineNyangText(text, fallback) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return fallback;
  }

  return lines.map((line) => toNyangSentence(line, fallback)).join("\n");
}

function normalizeResearchStep(progress) {
  const rawText = String(progress.activeStepText || "").trim();

  if ((progress.chartAnalysisCount || 0) > 0) {
    return {
      activeStepIndex: 3,
      totalSteps: 3,
      activeStepText: "최종 확인용 차트를 읽어 crowding과 타이밍을 점검하고 있다",
    };
  }

  if (
    /교차 비교|우선순위|산업·ETF·개별주|기대수익 대비 하방/i.test(rawText)
  ) {
    return {
      activeStepIndex: 2,
      totalSteps: 3,
      activeStepText: "후보를 교차 비교해 기대수익 대비 하방 우선순위를 정리하고 있다",
    };
  }

  return {
    activeStepIndex: 1,
    totalSteps: 3,
    activeStepText: "산출물을 읽어 현재 레짐과 후보 공급층을 해석하고 있다",
  };
}

export function buildProgressMessage(progress) {
  const normalizedResearchStep =
    progress.phase === "research" ? normalizeResearchStep(progress) : null;
  const stepIndex =
    normalizedResearchStep?.activeStepIndex ?? progress.activeStepIndex;
  const totalSteps =
    normalizedResearchStep?.totalSteps ?? progress.totalSteps;
  const activeStepText =
    normalizedResearchStep?.activeStepText ?? progress.activeStepText;
  const skillLabel = progress.skillName || "선택한";
  const base =
    progress.phase === "producer"
      ? "거시경제/기술/재무차트 자료를 수집하고 있다냥."
      : progress.phase === "report"
        ? "최종 보고서를 렌더링중이다냥."
        : progress.phase === "research"
          ? `${skillLabel} 스킬로 산출물을 해석하고 있다냥.`
        : `${skillLabel} 스킬을 써서 리포트를 준비한다냥.`;
  const producerStageLine =
    progress.phase === "producer" &&
    Number.isInteger(progress.completedProducerStages) &&
    Number.isInteger(progress.totalProducerStages)
      ? `현재 입력층 ${progress.completedProducerStages}/${progress.totalProducerStages}개를 마쳤다냥.`
      : "";
  const stepLine =
    Number.isInteger(stepIndex) &&
    Number.isInteger(totalSteps)
      ? `현재 ${stepIndex}/${totalSteps} 단계다냥: ${toNyangSentence(activeStepText, "진행 중이다냥.")}`
      : activeStepText
        ? formatMultilineNyangText(activeStepText, "진행 중이다냥.")
        : "";
  const metricsLine = buildMetricsLine(progress);

  return [base, producerStageLine, stepLine, metricsLine].filter(Boolean).join("\n");
}
