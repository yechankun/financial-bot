import crypto from "node:crypto";

function collapseWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeReportQuestion(question) {
  return collapseWhitespace(question).toLowerCase();
}

export function buildReportQuestionHash(questionNormalized) {
  return crypto
    .createHash("sha256")
    .update(String(questionNormalized || ""))
    .digest("hex");
}

export function buildReportCacheDescriptor({
  skillName,
  question,
  marketSnapshotDate,
  marketSessionState,
  reportMode = "default",
}) {
  const questionNormalized = normalizeReportQuestion(question);
  const questionHash = buildReportQuestionHash(questionNormalized);
  const payload = {
    skill: String(skillName || "").trim(),
    question_normalized: questionNormalized,
    market_snapshot_date: String(marketSnapshotDate || "").trim(),
    market_session_state: String(marketSessionState || "").trim(),
    report_mode: String(reportMode || "default").trim(),
  };
  const cacheKey = crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");

  return {
    cacheKey,
    questionNormalized,
    questionHash,
    marketSnapshotDate: payload.market_snapshot_date,
    marketSessionState: payload.market_session_state,
    reportMode: payload.report_mode,
  };
}
