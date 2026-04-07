import {
  fetchEtfLookup,
  fetchEtfScreen,
  fetchStockScreen,
  fetchStockLookup,
} from "../gateways/internal/marketGateway.js";
import {
  fetchScreenPreference,
  fetchScreenPreferenceBundle,
  putScreenPreference,
  putScreenPreferenceBundle,
  removeScreenPreference,
} from "../gateways/internal/appGateway.js";

const DEFAULT_ETF_SCREEN_CRITERIA = {
  undervalued: {
    score_mode: "weighted_percentile",
    min_metric_count: 3,
    reason: "낮은 연간 PER/PBR/PSR 조합",
    metrics: [
      { key: "aggregate_pe_ttm", label: "PER 연간", higher_better: false, weight: 1.0, positive_preferred: true },
      { key: "aggregate_pb", label: "PBR 분기", higher_better: false, weight: 1.0, positive_preferred: true },
      { key: "aggregate_ps_ttm", label: "PSR 연간", higher_better: false, weight: 1.0, positive_preferred: true },
    ],
  },
  overvalued: {
    score_mode: "weighted_percentile",
    min_metric_count: 3,
    reason: "높은 연간 PER/PBR/PSR 조합",
    metrics: [
      { key: "aggregate_pe_ttm", label: "PER 연간", higher_better: true, weight: 1.0, positive_preferred: true },
      { key: "aggregate_pb", label: "PBR 분기", higher_better: true, weight: 1.0, positive_preferred: true },
      { key: "aggregate_ps_ttm", label: "PSR 연간", higher_better: true, weight: 1.0, positive_preferred: true },
    ],
  },
  cashflow_good: {
    score_mode: "weighted_percentile",
    min_metric_count: 2,
    reason: "현금흐름 수익률과 매출 대비 FCF가 강함",
    metrics: [
      { key: "free_cash_flow_to_market_cap_ttm", label: "잉여현금/시총 연간", higher_better: true, weight: 1.0, positive_preferred: true },
      { key: "free_cash_flow_to_revenue_ttm", label: "잉여현금/매출 연간", higher_better: true, weight: 1.0, positive_preferred: true },
    ],
  },
  cashflow_capex_deterioration: {
    score_mode: "weighted_percentile",
    min_metric_count: 4,
    reason: "FCF 비율은 약하고 CAPEX 부담은 큼",
    metrics: [
      { key: "free_cash_flow_to_market_cap_ttm", label: "잉여현금/시총 연간", higher_better: false, weight: 1.0 },
      { key: "free_cash_flow_to_revenue_ttm", label: "잉여현금/매출 연간", higher_better: false, weight: 1.0 },
      { key: "capital_expenditures_to_market_cap_ttm", label: "자본지출/시총 연간", higher_better: true, weight: 1.0 },
      { key: "capital_expenditures_to_revenue_ttm", label: "자본지출/매출 연간", higher_better: true, weight: 1.0 },
    ],
  },
  momentum: {
    score_mode: "weighted_percentile",
    min_metric_count: 5,
    reason: "1M/3M 성과, ADX, MACD, 거래량이 같이 받쳐줌",
    metrics: [
      { key: "etf_perf_1m", label: "1개월 수익률", higher_better: true, weight: 1.0 },
      { key: "etf_perf_3m", label: "3개월 수익률", higher_better: true, weight: 1.0 },
      { key: "etf_adx", label: "ADX", higher_better: true, weight: 1.0 },
      { key: "etf_relative_volume_10d", label: "RVOL", higher_better: true, weight: 1.0 },
      { key: "etf_macd_hist", label: "MACD", higher_better: true, weight: 1.0 },
    ],
    bonus_rules: [
      { key: "etf_rsi", min: 55, max: 75, bonus: 0.08 },
      { key: "etf_rsi", min: 50, max: 55, bonus: 0.03 },
      { key: "etf_rsi", min: 75, max: 80, bonus: 0.03 },
    ],
  },
  outlier: {
    score_mode: "weighted_abs_zscore",
    min_metric_count: 6,
    reason: "지표 기준 극단값",
    metrics: [
      { key: "etf_perf_1m", label: "1개월 수익률", weight: 1.0 },
      { key: "etf_fund_flows_1m", label: "자금유입 1개월", weight: 1.0 },
      { key: "etf_atrp", label: "ATRP", weight: 1.0 },
      { key: "aggregate_pe_ttm", label: "PER 연간", weight: 1.0, positive_only: true },
      { key: "aggregate_ps_ttm", label: "PSR 연간", weight: 1.0, positive_only: true },
      { key: "free_cash_flow_to_market_cap_ttm", label: "잉여현금/시총 연간", weight: 1.0 },
    ],
  },
};

const DEFAULT_STOCK_SCREEN_CRITERIA = {
  etf_included_count: {
    score_mode: "weighted_percentile",
    min_metric_count: 1,
    reason: "많은 ETF에 편입된 종목",
    metrics: [
      { key: "included_etf_count", label: "포함 ETF 수", higher_better: true, weight: 1.0 },
    ],
  },
  etf_total_exposure: {
    score_mode: "weighted_percentile",
    min_metric_count: 1,
    reason: "ETF 보유 총규모가 큰 종목",
    metrics: [
      { key: "included_etf_total_exposure", label: "ETF 보유 총규모", higher_better: true, weight: 1.0 },
    ],
  },
  undervalued: {
    score_mode: "weighted_percentile",
    min_metric_count: 4,
    reason: "낮은 PER/PBR/EV/EBITDA/주가잉여현금흐름 조합",
    metrics: [
      { key: "price_earnings_ttm", label: "PER", higher_better: false, weight: 1.0, positive_preferred: true },
      { key: "price_book_fq", label: "PBR 분기", higher_better: false, weight: 1.0, positive_preferred: true },
      { key: "enterprise_value_ebitda_ttm", label: "EV/EBITDA", higher_better: false, weight: 1.0, positive_preferred: true },
      { key: "price_free_cash_flow_ttm", label: "주가/잉여현금흐름", higher_better: false, weight: 1.0, positive_preferred: true },
    ],
  },
  overvalued: {
    score_mode: "weighted_percentile",
    min_metric_count: 4,
    reason: "높은 PER/PBR/EV/EBITDA/주가잉여현금흐름 조합",
    metrics: [
      { key: "price_earnings_ttm", label: "PER", higher_better: true, weight: 1.0, positive_preferred: true },
      { key: "price_book_fq", label: "PBR 분기", higher_better: true, weight: 1.0, positive_preferred: true },
      { key: "enterprise_value_ebitda_ttm", label: "EV/EBITDA", higher_better: true, weight: 1.0, positive_preferred: true },
      { key: "price_free_cash_flow_ttm", label: "주가/잉여현금흐름", higher_better: true, weight: 1.0, positive_preferred: true },
    ],
  },
  cashflow_good: {
    score_mode: "weighted_percentile",
    min_metric_count: 4,
    reason: "잉여현금흐름 수익률과 수익성이 함께 강함",
    metrics: [
      { key: "free_cash_flow_to_market_cap_ttm", label: "잉여현금/시총 연간", higher_better: true, weight: 1.0, positive_preferred: true },
      { key: "free_cash_flow_to_revenue_ttm", label: "잉여현금/매출 연간", higher_better: true, weight: 1.0, positive_preferred: true },
      { key: "operating_margin_ttm", label: "영업이익률", higher_better: true, weight: 1.0, positive_preferred: true },
      { key: "return_on_equity_fq", label: "ROE", higher_better: true, weight: 1.0, positive_preferred: true },
    ],
  },
  cashflow_capex_deterioration: {
    score_mode: "weighted_percentile",
    min_metric_count: 4,
    reason: "FCF는 약하고 CAPEX 부담은 큰 편",
    metrics: [
      { key: "free_cash_flow_to_market_cap_ttm", label: "잉여현금/시총 연간", higher_better: false, weight: 1.0 },
      { key: "free_cash_flow_to_revenue_ttm", label: "잉여현금/매출 연간", higher_better: false, weight: 1.0 },
      { key: "capital_expenditures_to_market_cap_ttm", label: "자본지출/시총 연간", higher_better: true, weight: 1.0 },
      { key: "capital_expenditures_to_revenue_ttm", label: "자본지출/매출 연간", higher_better: true, weight: 1.0 },
    ],
  },
  momentum: {
    score_mode: "weighted_percentile",
    min_metric_count: 5,
    reason: "1M/3M 성과, ADX, 거래량, MACD가 같이 받쳐줌",
    metrics: [
      { key: "perf_1m", label: "1개월 수익률", higher_better: true, weight: 1.0 },
      { key: "perf_3m", label: "3개월 수익률", higher_better: true, weight: 1.0 },
      { key: "adx", label: "ADX", higher_better: true, weight: 1.0 },
      { key: "relative_volume_10d", label: "RVOL", higher_better: true, weight: 1.0 },
      { key: "macd_hist", label: "MACD", higher_better: true, weight: 1.0 },
    ],
    bonus_rules: [
      { key: "rsi", min: 55, max: 75, bonus: 0.08 },
      { key: "rsi", min: 50, max: 55, bonus: 0.03 },
      { key: "rsi", min: 75, max: 80, bonus: 0.03 },
    ],
  },
  outlier: {
    score_mode: "weighted_abs_zscore",
    min_metric_count: 5,
    reason: "지표 기준 극단값",
    metrics: [
      { key: "perf_1m", label: "1개월 수익률", weight: 1.0 },
      { key: "atrp", label: "ATRP", weight: 1.0 },
      { key: "price_earnings_ttm", label: "PER", weight: 1.0, positive_only: true },
      { key: "price_free_cash_flow_ttm", label: "주가/잉여현금흐름", weight: 1.0, positive_only: true },
      { key: "free_cash_flow_to_market_cap_ttm", label: "잉여현금/시총 연간", weight: 1.0 },
    ],
  },
};

function buildPreferenceCategory(dataset, category) {
  return `${String(dataset || "").trim()}:${String(category || "").trim()}`;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function getDefaultCriteriaMap(dataset) {
  return dataset === "stock"
    ? DEFAULT_STOCK_SCREEN_CRITERIA
    : DEFAULT_ETF_SCREEN_CRITERIA;
}

function buildDefaultScreenPreference({ dataset, category }) {
  const defaults = getDefaultCriteriaMap(dataset);
  if (category) {
    const criteria = defaults[category];
    if (!criteria) {
      return null;
    }
    return {
      category: buildPreferenceCategory(dataset, category),
      criteria_json: JSON.stringify(cloneJson(criteria), null, 2),
      updated_at: "기본값",
    };
  }

  return {
    dataset,
    criteria_json: JSON.stringify({ categories: cloneJson(defaults) }, null, 2),
    updated_at: "기본값",
    categories: cloneJson(defaults),
  };
}

async function loadScopedScreenPreference({ discordUserId, dataset, category }) {
  const scopedCategory = buildPreferenceCategory(dataset, category);
  const scoped = await fetchScreenPreference({
    discordUserId,
    category: scopedCategory,
  });
  if (scoped) {
    return scoped;
  }

  if (dataset === "etf") {
    return fetchScreenPreference({
      discordUserId,
      category,
    });
  }

  return null;
}

export async function runEtfScreen({ category, limit, criteria, discordUserId }) {
  let effectiveCriteria = criteria;
  if (
    category !== "overview" &&
    !String(criteria || "").trim() &&
    String(discordUserId || "").trim()
  ) {
    const savedPreference = await loadScopedScreenPreference({
      discordUserId,
      dataset: "etf",
      category,
    });
    if (savedPreference?.criteria_json) {
      effectiveCriteria = savedPreference.criteria_json;
    }
  }

  return fetchEtfScreen({
    category,
    limit,
    criteria: effectiveCriteria,
  });
}

export async function runEtfLookup({ symbol }) {
  return fetchEtfLookup({ symbol });
}

export async function runStockScreen({
  category,
  limit,
  criteria,
  discordUserId,
  industryHighlights,
  industryOnly,
  industries,
  usOnly,
  perIndustryLimit,
  maxIndustries,
}) {
  let effectiveCriteria = criteria;
  if (!String(criteria || "").trim() && String(discordUserId || "").trim()) {
    const savedPreference = await loadScopedScreenPreference({
      discordUserId,
      dataset: "stock",
      category,
    });
    if (savedPreference?.criteria_json) {
      effectiveCriteria = savedPreference.criteria_json;
    }
  }

  return fetchStockScreen({
    category,
    limit,
    criteria: effectiveCriteria,
    industryHighlights,
    industryOnly,
    industries,
    usOnly,
    perIndustryLimit,
    maxIndustries,
  });
}

export async function runStockLookup({ symbol }) {
  return fetchStockLookup({ symbol });
}

export async function saveEtfScreenPreferenceUsecase({
  discordUserId,
  category,
  criteria,
}) {
  return putScreenPreference({
    discordUserId,
    category: buildPreferenceCategory("etf", category),
    criteria,
  });
}

export async function loadEtfScreenPreferenceUsecase({
  discordUserId,
  category,
}) {
  const saved = await loadScopedScreenPreference({
    discordUserId,
    dataset: "etf",
    category,
  });
  return saved || buildDefaultScreenPreference({ dataset: "etf", category });
}

export async function loadEtfScreenPreferenceBundleUsecase({
  discordUserId,
}) {
  const saved = await fetchScreenPreferenceBundle({
    discordUserId,
    dataset: "etf",
  });
  return saved || buildDefaultScreenPreference({ dataset: "etf" });
}

export async function deleteEtfScreenPreferenceUsecase({
  discordUserId,
  category,
}) {
  return removeScreenPreference({
    discordUserId,
    category: buildPreferenceCategory("etf", category),
  });
}

export async function saveEtfScreenPreferenceBundleUsecase({
  discordUserId,
  criteria,
}) {
  return putScreenPreferenceBundle({
    discordUserId,
    dataset: "etf",
    criteria,
  });
}

export async function saveStockScreenPreferenceUsecase({
  discordUserId,
  category,
  criteria,
}) {
  return putScreenPreference({
    discordUserId,
    category: buildPreferenceCategory("stock", category),
    criteria,
  });
}

export async function loadStockScreenPreferenceUsecase({
  discordUserId,
  category,
}) {
  const saved = await loadScopedScreenPreference({
    discordUserId,
    dataset: "stock",
    category,
  });
  return saved || buildDefaultScreenPreference({ dataset: "stock", category });
}

export async function loadStockScreenPreferenceBundleUsecase({
  discordUserId,
}) {
  const saved = await fetchScreenPreferenceBundle({
    discordUserId,
    dataset: "stock",
  });
  return saved || buildDefaultScreenPreference({ dataset: "stock" });
}

export async function saveStockScreenPreferenceBundleUsecase({
  discordUserId,
  criteria,
}) {
  return putScreenPreferenceBundle({
    discordUserId,
    dataset: "stock",
    criteria,
  });
}
