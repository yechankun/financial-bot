import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { config } from "../config.js";

const execFileAsync = promisify(execFile);
const CANDIDATE_CHART_WINDOW_DAYS = 90;
const MAX_PAGE3_LONG_CANDIDATES = 4;
const MAX_PAGE3_SHORT_WATCH_CANDIDATES = 3;
const MAX_PAGE3_FALLBACK_CANDIDATES = 6;
const PRICE_PLACEHOLDER_PATTERN =
  /^(?:자료\s*미기재|자료\s*미표기|없음|비공개|n\/a|na|null|unknown|미상|-|—)?$/i;

function normalizeTickerKey(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) {
    return "";
  }
  const strippedPrefix = raw.includes(":") ? raw.split(":").at(-1) : raw;
  return strippedPrefix.replace(/^\$/, "").replace(/[^A-Z0-9.\-]/g, "");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function renderBulletList(items = []) {
  const rows = items
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  return `<ul class="bullet-list">${rows}</ul>`;
}

function tagClass(index) {
  if (index === 0) {
    return "gold";
  }
  if (index === 1) {
    return "teal";
  }
  return "red";
}

function renderTagRow(tags = []) {
  const rows = tags
    .map((tag) => String(tag || "").trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((tag, index) => `<span class="tag ${tagClass(index)}">${escapeHtml(tag)}</span>`)
    .join("");
  return rows ? `<div class="tag-row">${rows}</div>` : "";
}

function renderSectionCard(section) {
  return [
    '<div class="panel">',
    `<div class="section-title">${escapeHtml(section?.title || "")}</div>`,
    renderBulletList(section?.bullets || []),
    "</div>",
  ].join("");
}

function renderFactCard(fact) {
  return [
    '<div class="panel">',
    `<div class="fact-label">${escapeHtml(fact?.label || "")}</div>`,
    `<div class="fact-value">${escapeHtml(fact?.value || "")}</div>`,
    `<div class="fact-note">${escapeHtml(fact?.note || "")}</div>`,
    "</div>",
  ].join("");
}

function renderMatrixCard(card) {
  return [
    '<div class="panel">',
    `<h3>${escapeHtml(card?.title || "")}</h3>`,
    `<p style="margin-top:12px;">${escapeHtml(card?.body || "")}</p>`,
    renderTagRow(card?.tags || []),
    "</div>",
  ].join("");
}

function renderNarrativeTableRow(row) {
  return [
    "<tr>",
    `<td>${escapeHtml(row?.focus || "")}</td>`,
    `<td>${escapeHtml(row?.change || "")}</td>`,
    `<td>${escapeHtml(row?.underpriced || "")}</td>`,
    `<td>${escapeHtml(row?.extend || "")}</td>`,
    `<td>${escapeHtml(row?.invalidate || "")}</td>`,
    "</tr>",
  ].join("");
}

function renderCompactCard(card) {
  return [
    '<div class="panel soft">',
    `<div class="section-title">${escapeHtml(card?.title || "")}</div>`,
    `<p>${escapeHtml(card?.body || "")}</p>`,
    "</div>",
  ].join("");
}

function clampUnit(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function formatSignedPercent(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  const rounded = Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${value > 0 ? "+" : ""}${rounded}%`;
}

function formatMetricValue(value) {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return value.toFixed(2);
}

function normalizeCandidateNarrative(value) {
  return String(value || "")
    .replaceAll("sochan_rollshort", "공매도 %b")
    .replaceAll("Sochan Rolling Short Pressure Oscillator", "공매도 %b")
    .replaceAll("Rolling Short Pressure Oscillator", "공매도 %b");
}

function isMissingPrice(value) {
  const text = String(value || "").trim();
  return !text || PRICE_PLACEHOLDER_PATTERN.test(text);
}

function extractRowClose(row) {
  const candidates = [
    row?.close,
    row?.price,
    row?.last_price,
    row?.current_price,
    row?.regular_market_price,
    row?.market_price,
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }
  return null;
}

function formatCandidatePrice(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }
  const decimals = value >= 100 ? 2 : value >= 10 ? 2 : 3;
  const formatted = new Intl.NumberFormat("ko-KR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  }).format(value);
  return `${formatted}달러`;
}

function buildPricePath(values, width, height, padding) {
  const numericValues = values.filter((value) => Number.isFinite(value));
  if (numericValues.length < 2) {
    return "";
  }

  const min = Math.min(...numericValues);
  const max = Math.max(...numericValues);
  const range = Math.max(max - min, Math.max(Math.abs(max) * 0.001, 1e-9));
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;

  return values
    .map((value, index) => {
      const x = padding + (innerWidth * index) / (values.length - 1);
      const normalized = (value - min) / range;
      const y = height - padding - normalized * innerHeight;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function renderMiniChart(snapshot) {
  const candles = Array.isArray(snapshot?.candles) ? snapshot.candles : [];
  const closes = candles
    .map((candle) => Number(candle?.close))
    .filter((value) => Number.isFinite(value));

  if (closes.length < 2) {
    return "";
  }

  const first = closes[0];
  const last = closes.at(-1);
  const changePct = first !== 0 ? ((last - first) / first) * 100 : NaN;
  const path = buildPricePath(closes, 520, 116, 10);
  if (!path) {
    return "";
  }

  const latestSeries = snapshot?.latestSeries || {};
  const bb = Number(latestSeries["Bollinger Bands %b · Bollinger Bands %b"]);
  const shortPressure = Number(
    latestSeries[
      "Sochan Rolling Short Pressure Oscillator · Rolling Short Pressure Oscillator Value"
    ],
  );
  const ret70 = Number(latestSeries["Returns %b · 기간 수익률 %b"]);
  const ret20 = Number(latestSeries["Returns %b (20,260) · 기간 수익률 %b (20,260)"]);
  const changeClass = Number.isFinite(changePct)
    ? changePct >= 0
      ? "up"
      : "down"
    : "";

  return [
    '<div class="mini-chart">',
    '<div class="mini-chart-head">',
    `<span class="mini-chart-title">${escapeHtml(`최근 ${snapshot?.windowDays || CANDIDATE_CHART_WINDOW_DAYS}일 가격`)}</span>`,
    `<span class="mini-chart-change ${changeClass}">${escapeHtml(formatSignedPercent(changePct))}</span>`,
    "</div>",
    '<svg viewBox="0 0 520 116" preserveAspectRatio="none" aria-hidden="true">',
    '<line x1="10" y1="58" x2="510" y2="58" class="mini-chart-axis" />',
    `<path d="${path}" class="mini-chart-line" />`,
    "</svg>",
    '<div class="mini-chart-metrics">',
    `<span><strong>밴드%b</strong>${escapeHtml(formatMetricValue(bb))}</span>`,
    `<span><strong>공매도 %b</strong>${escapeHtml(formatMetricValue(shortPressure))}</span>`,
    `<span><strong>단기 수익률%b</strong>${escapeHtml(formatMetricValue(ret20))}</span>`,
    `<span><strong>장기 수익률%b</strong>${escapeHtml(formatMetricValue(ret70))}</span>`,
    "</div>",
    "</div>",
  ].join("");
}

function renderCandidateCard(candidate, index, totalCount, chartHtml = "", meta = {}) {
  const compactLayout = totalCount > 4;
  const layoutClass = compactLayout
    ? totalCount % 2 === 1 && index === totalCount - 1
      ? " compact-last-center"
      : ""
    : totalCount % 2 === 1 && index === totalCount - 1
      ? " full"
      : "";
  const displayTicker = String(meta?.fullSymbol || candidate?.ticker || "").trim();
  const displayName = String(meta?.name || "").trim();
  const displayLabel = displayName ? `${displayTicker} / ${displayName}` : displayTicker;
  const displayPrice = isMissingPrice(candidate?.price)
    ? formatCandidatePrice(meta?.close)
    : String(candidate?.price || "").trim();
  return [
    `<article class="panel rank-card${layoutClass}">`,
    '<div class="rank-number">',
    `<div class="order">${escapeHtml(candidate?.rank || "")}</div>`,
    "<div>",
    `<div class="ticker">${escapeHtml(displayLabel)}</div>`,
    `<div class="price">${escapeHtml(displayPrice)}</div>`,
    "</div>",
    "</div>",
    chartHtml,
    '<div class="metric-columns">',
    '<div class="metric-box">',
    "<h4>단기</h4>",
    `<p>${escapeHtml(normalizeCandidateNarrative(candidate?.short_term || ""))}</p>`,
    "</div>",
    '<div class="metric-box">',
    "<h4>중기</h4>",
    `<p>${escapeHtml(normalizeCandidateNarrative(candidate?.medium_term || ""))}</p>`,
    "</div>",
    '<div class="metric-box">',
    "<h4>장기</h4>",
    `<p>${escapeHtml(normalizeCandidateNarrative(candidate?.long_term || ""))}</p>`,
    "</div>",
    "</div>",
    `<div class="asymmetry">주요 비대칭: ${escapeHtml(
      normalizeCandidateNarrative(candidate?.asymmetry || ""),
    )}${renderTagRow(
      candidate?.tags || [],
    )}</div>`,
    "</article>",
  ].join("");
}

function renderPortfolioBucket(bucket) {
  const items = (bucket?.items || [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .map((item) => `<div class="bucket-item">${escapeHtml(item)}</div>`)
    .join("");
  return [
    '<div class="panel">',
    `<div class="bucket-label">${escapeHtml(bucket?.label || "")}</div>`,
    `<h2 style="margin-top:10px;">${escapeHtml(bucket?.title || "")}</h2>`,
    `<div class="bucket-list">${items}</div>`,
    "</div>",
  ].join("");
}

async function loadCandidateChartSnapshots(runDir, candidateTickers = []) {
  const normalizedWanted = new Set(
    candidateTickers
      .map((ticker) => normalizeTickerKey(ticker))
      .filter(Boolean),
  );
  if (normalizedWanted.size === 0) {
    return new Map();
  }

  const manifestPath = path.join(runDir, "research-assets", "charts", "candidates_dw", "manifest.json");
  const manifestRaw = await fs.readFile(manifestPath, "utf8").catch(() => "");
  if (!manifestRaw) {
    return new Map();
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    return new Map();
  }

  const snapshots = new Map();
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  for (const entry of entries) {
    if (entry?.status !== "ok" || !entry?.latestPath) {
      continue;
    }
    const tickerKey = normalizeTickerKey(entry?.symbol);
    if (!tickerKey || !normalizedWanted.has(tickerKey) || snapshots.has(tickerKey)) {
      continue;
    }

    try {
      const latestPayload = JSON.parse(await fs.readFile(entry.latestPath, "utf8"));
      const candles = Array.isArray(latestPayload?.recentWindow?.candles)
        ? latestPayload.recentWindow.candles
        : [];
      if (candles.length < 2) {
        continue;
      }
      snapshots.set(tickerKey, {
        symbol: tickerKey,
        windowDays: Number(latestPayload?.recentWindow?.windowDays) || CANDIDATE_CHART_WINDOW_DAYS,
        candles: candles.slice(-120),
        latestSeries: latestPayload?.latestSeries || {},
      });
    } catch {
      continue;
    }
  }

  return snapshots;
}

async function loadCandidateMetas(runDir, candidateTickers = []) {
  const normalizedWanted = new Set(
    candidateTickers
      .map((ticker) => normalizeTickerKey(ticker))
      .filter(Boolean),
  );
  if (normalizedWanted.size === 0) {
    return new Map();
  }

  const lookupPaths = [
    path.join(runDir, "research-assets", "producers", "market", "stock_lookup_rows.json"),
    path.join(runDir, "research-assets", "producers", "market", "etf_lookup_rows.json"),
  ];
  const metaMap = new Map();

  for (const lookupPath of lookupPaths) {
    const raw = await fs.readFile(lookupPath, "utf8").catch(() => "");
    if (!raw) {
      continue;
    }
    let rows;
    try {
      const payload = JSON.parse(raw);
      rows = Array.isArray(payload) ? payload : Array.isArray(payload?.rows) ? payload.rows : [];
    } catch {
      rows = [];
    }

    for (const row of rows) {
      const key = normalizeTickerKey(row?.symbol || row?.tv_symbol || row?.ticker);
      if (!key || !normalizedWanted.has(key) || metaMap.has(key)) {
        continue;
      }
      const exchange = String(row?.exchange || "").trim().toUpperCase();
      const fullSymbol = String(row?.symbol || row?.tv_symbol || "").trim() || (exchange ? `${exchange}:${key}` : key);
      metaMap.set(key, {
        fullSymbol,
        name: String(row?.name || row?.description || "").trim(),
        close: extractRowClose(row),
      });
    }
  }

  return metaMap;
}

function buildPlaceholderMap(plan, chartSnapshots = new Map(), candidateMetas = new Map()) {
  const explicitLongCandidates = Array.isArray(plan.page3?.long_candidates)
    ? plan.page3.long_candidates.slice(0, MAX_PAGE3_LONG_CANDIDATES)
    : [];
  const explicitShortWatchCandidates = Array.isArray(plan.page3?.short_watch_candidates)
    ? plan.page3.short_watch_candidates.slice(0, MAX_PAGE3_SHORT_WATCH_CANDIDATES)
    : [];
  const fallbackCandidates =
    explicitLongCandidates.length === 0 && explicitShortWatchCandidates.length === 0
      ? (plan.page3?.candidates || []).slice(0, MAX_PAGE3_FALLBACK_CANDIDATES)
      : [];
  const longCandidates =
    explicitLongCandidates.length > 0 ? explicitLongCandidates : fallbackCandidates;
  const shortWatchCandidates = explicitShortWatchCandidates;
  const combinedPage3Count = longCandidates.length + shortWatchCandidates.length;
  const compactPage3Grid = combinedPage3Count > 4 ? "compact" : "";

  return {
    REPORT_TITLE: escapeHtml(plan.report_title || "시장 리포트"),
    PAGE1_EYEBROW: escapeHtml(plan.page1?.eyebrow || ""),
    PAGE1_TITLE: escapeHtml(plan.page1?.title || ""),
    PAGE1_LEAD: escapeHtml(plan.page1?.lead || ""),
    PAGE1_DISCLAIMER: escapeHtml(config.reportDisclaimerText),
    PAGE1_FACTS_HTML: (plan.page1?.facts || []).slice(0, 6).map(renderFactCard).join(""),
    PAGE1_LEFT_HTML: renderSectionCard(plan.page1?.left || {}),
    PAGE1_RIGHT_HTML: renderSectionCard(plan.page1?.right || {}),
    PAGE2_EYEBROW: escapeHtml(plan.page2?.eyebrow || ""),
    PAGE2_TITLE: escapeHtml(plan.page2?.title || ""),
    PAGE2_MATRIX_HTML: (plan.page2?.matrix_cards || []).slice(0, 4).map(renderMatrixCard).join(""),
    PAGE2_TABLE_HTML: (plan.page2?.table_rows || []).slice(0, 5).map(renderNarrativeTableRow).join(""),
    PAGE2_WARNINGS_HTML: (plan.page2?.warning_cards || []).slice(0, 3).map(renderCompactCard).join(""),
    PAGE3_EYEBROW: escapeHtml(plan.page3?.eyebrow || ""),
    PAGE3_TITLE: escapeHtml(plan.page3?.title || ""),
    PAGE3_LEAD: escapeHtml(plan.page3?.lead || ""),
    PAGE3_LONG_GRID_CLASS: escapeHtml(compactPage3Grid),
    PAGE3_SHORT_WATCH_GRID_CLASS: escapeHtml(compactPage3Grid),
    PAGE3_LONG_CANDIDATES_HTML: longCandidates
      .map((candidate, index) => {
        const tickerKey = normalizeTickerKey(candidate?.ticker);
        const chartHtml = renderMiniChart(chartSnapshots.get(tickerKey));
        const meta = candidateMetas.get(tickerKey) || {};
        return renderCandidateCard(candidate, index, longCandidates.length, chartHtml, meta);
      })
      .join(""),
    PAGE3_SHORT_WATCH_CANDIDATES_HTML: shortWatchCandidates
      .map((candidate, index) => {
        const tickerKey = normalizeTickerKey(candidate?.ticker);
        const chartHtml = renderMiniChart(chartSnapshots.get(tickerKey));
        const meta = candidateMetas.get(tickerKey) || {};
        return renderCandidateCard(
          candidate,
          index,
          shortWatchCandidates.length,
          chartHtml,
          meta,
        );
      })
      .join(""),
    PAGE4_EYEBROW: escapeHtml(plan.page4?.eyebrow || ""),
    PAGE4_TITLE: escapeHtml(plan.page4?.title || ""),
    PAGE4_LEAD: escapeHtml(plan.page4?.lead || ""),
    PAGE4_BUCKETS_HTML: (plan.page4?.buckets || []).slice(0, 4).map(renderPortfolioBucket).join(""),
    PAGE4_FOOTNOTE: escapeHtml(plan.page4?.footnote || ""),
  };
}

function applyTemplate(template, placeholderMap) {
  let html = template;
  for (const [key, value] of Object.entries(placeholderMap)) {
    html = html.replaceAll(`{{${key}}}`, value);
  }
  return html.replace(/\{\{[A-Z0-9_]+\}\}/g, "");
}

async function captureReportPages(htmlPath, outputDir) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      config.reportCaptureScriptPath,
      htmlPath,
      "--out-dir",
      outputDir,
      "--width",
      "1600",
      "--height",
      "1700",
      "--scale",
      "1.25",
    ],
    {
      cwd: config.repoDir,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  const pngPaths = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".png"));

  if (pngPaths.length > 0) {
    return pngPaths;
  }

  const reportEntries = await fs.readdir(outputDir).catch(() => []);
  return reportEntries
    .filter((name) => /^page-\d+\.png$/.test(name))
    .sort()
    .map((name) => path.join(outputDir, name));
}

export async function renderReportPlanToBundle({ runDir, plan }) {
  const outputDir = path.join(runDir, "report");
  const htmlPath = path.join(outputDir, "report.html");
  const planPath = path.join(outputDir, "report-plan.json");

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  const template = await fs.readFile(config.reportDeckTemplatePath, "utf8");
  const page3Tickers = [
    ...(plan.page3?.long_candidates || []),
    ...(plan.page3?.short_watch_candidates || []),
    ...(plan.page3?.candidates || []),
  ].map((candidate) => candidate?.ticker);
  const chartSnapshots = await loadCandidateChartSnapshots(
    runDir,
    page3Tickers,
  );
  const candidateMetas = await loadCandidateMetas(runDir, page3Tickers);
  const html = applyTemplate(template, buildPlaceholderMap(plan, chartSnapshots, candidateMetas));
  await fs.writeFile(htmlPath, html, "utf8");

  const pngPaths = await captureReportPages(htmlPath, outputDir);
  if (pngPaths.length === 0) {
    throw new Error("리포트 PNG를 생성하지 못했다냥.");
  }

  return {
    output_dir: outputDir,
    html_path: htmlPath,
    png_paths: pngPaths,
    supporting_paths: [planPath],
  };
}
