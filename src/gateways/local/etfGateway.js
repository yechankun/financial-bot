import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import { config } from "../../config.js";

const script = fileURLToPath(new URL("../../../scripts/etf_query.py", import.meta.url));
const flowMethods = {
  reported: "공식 설정·환매 공시",
  shares_nav: "발행좌수×NAV 추정",
  nav_aum: "NAV·순자산 추정",
  index_proxy: "지수 기반 추정",
};
const flowReasons = {
  aum_scope_mismatch: "클래스 순자산 미확인",
  action_coverage_unknown: "분할·병합 이력 미확인",
  distribution_coverage_unknown: "분배금 이력 미확인",
  tracked_benchmark_unavailable: "추적지수 수익률 없음",
};

export function formatDirectEtfView(view) {
  if (view?.status === "ambiguous") {
    const candidates = (view.candidates || []).slice(0, 10).map((row) =>
      `• ${row.share_class_id || row.entity_id} (${row.market || row.listing_id || "거래소 미확인"})`);
    return `ETF 식별이 모호합니다. 거래소 또는 정확한 class ID로 다시 조회해주세요.\n${candidates.join("\n")}`;
  }
  if (view?.status !== "ok") {
    return "직접 수집한 ETF 자료에서 해당 상품을 찾지 못했습니다. 수집 대상과 마지막 수집 상태를 확인해주세요.";
  }

  const cls = view.entity?.share_class || {};
  const fund = view.entity?.fund || {};
  const title = cls.name || fund.name || view.query;
  const lines = [`**${title}**`, `class: ${cls.share_class_id || "확인 불가"}`];
  const holdings = view.holdings;
  if (holdings?.snapshot_id) {
    lines.push(`구성종목: ${holdings.total_rows ?? holdings.parsed_rows ?? "?"}행 · 기준 ${holdings.as_of_date || "?"} · ${holdings.disclosure_completeness || "완전성 미확인"}`);
  } else {
    lines.push("구성종목: 수집 자료 없음");
  }

  const observations = view.capital_series?.observations || [];
  for (const [metric, label] of [["shares_outstanding", "발행좌수"], ["nav_per_share", "NAV"], ["net_assets", "순자산"]]) {
    const latest = observations.filter((row) => row.metric === metric && row.value != null
      && (row.asset_scope === "share_class"
        || (row.asset_scope == null && row.entity_type === "share_class")))
      .sort((a, b) => String(b.as_of_date || "").localeCompare(String(a.as_of_date || "")))[0];
    lines.push(latest
      ? `${label}: ${latest.value}${latest.currency ? ` ${latest.currency}` : ""} (${latest.as_of_date}, ${latest.asset_scope || latest.entity_type || "scope 미확인"})`
      : `${label}: 클래스 범위 자료 없음`);
  }

  const tracked = (view.benchmark_series?.links || []).find((row) => row.role === "tracked");
  const index = (view.benchmark_series?.indexes || []).find((row) => row.index_id === tracked?.index_id);
  lines.push(index
    ? `추적지수: ${index.name || index.code || index.index_id} (${index.return_type || "유형 미확인"})`
    : "추적지수: 확인된 연결 없음");

  const flow = [...(view.flows?.results || [])]
    .sort((a, b) => String(b.period_end || "").localeCompare(String(a.period_end || "")))[0];
  if (flow) {
    const amount = flow.selected_flow == null ? "계산 불가" : `${flow.selected_flow} ${flow.currency || ""}`.trim();
    const method = flow.selected_flow == null ? "" : `, ${flowMethods[flow.selected_method] || flow.selected_method || "방법 미확인"}`;
    lines.push(`순유입·유출: ${amount} (${flow.period_start}→${flow.period_end}${method})`);
    if (flow.selected_flow == null && flow.reason_codes?.length) {
      lines.push(`사유: ${flow.reason_codes.slice(0, 3).map((code) => flowReasons[code] || code).join(", ")}`);
    }
  } else {
    lines.push("순유입·유출: 계산 결과 없음");
  }
  const reportedFundFlow = observations.filter((row) =>
    row.metric === "net_creation_amount" && row.asset_scope === "fund"
      && row.value != null && row.extensions?.official_definition
      && row.extensions?.source_authority_tier === "exchange")
    .sort((a, b) => String(b.period_end || b.as_of_date || "")
      .localeCompare(String(a.period_end || a.as_of_date || "")))[0];
  if (reportedFundFlow) {
    const start = reportedFundFlow.period_start || "?";
    const end = reportedFundFlow.period_end || reportedFundFlow.as_of_date || "?";
    lines.push(`펀드 월간 공시 유입·유출: ${reportedFundFlow.value} ${reportedFundFlow.currency || ""}`.trim()
      + ` (${start}→${end}, 클래스별 배분 미확인)`);
  }
  lines.push(`자료 인지 시각: ${view.known_at || "?"}`);
  return lines.join("\n").slice(0, 1900);
}

export function runDirectEtfQuery(symbol, {
  pythonBin = process.env.ETF_PYTHON_BIN || "python3",
  dataDir = process.env.ETF_DIRECT_DATA_DIR || config.dataDir,
  timeoutMs = 20000,
  execFileImpl = execFile,
} = {}) {
  return new Promise((resolve, reject) => {
    const args = [script, "--data-dir", dataDir, "query", "--query", symbol,
      "--holdings-limit", "5"];
    execFileImpl(pythonBin, args, { timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`ETF 직접 조회 실패: ${String(stderr || error.message).trim().slice(0, 500)}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("ETF 직접 조회가 유효한 JSON을 반환하지 않았습니다."));
        }
      });
  });
}

export async function fetchDirectEtfLookup({ symbol }) {
  const view = await runDirectEtfQuery(symbol);
  return { content: formatDirectEtfView(view), allowedMentions: { parse: [] } };
}
