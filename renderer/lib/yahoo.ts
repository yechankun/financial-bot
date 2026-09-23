import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { readIndependentMarketSnapshot as readLocalMarketSnapshot } from './independent-market-db';
import { readYahooCache, writeYahooCache } from './cache-db';
import { toYahooShareClassSymbol } from './symbols';

export type YahooSplitEvent = {
    time: number;
    numerator: number;
    denominator: number;
};

export type YahooSymbolSnapshot = {
    cacheVersion?: number;
    symbol: string;
    instrumentType: string | null;
    syminfoType: string | null;
    regularMarketPrice: number | null;
    navPrice: number | null;
    marketCap: number | null;
    sharesOutstanding: number | null;
    totalAssets: number | null;
};

export type YahooFinancialMetric =
    | 'AUM'
    | 'NAV'
    | 'NAV_ALL'
    | 'TOTAL_ASSETS'
    | 'TOTAL_EQUITY'
    | 'RETURN_ON_ASSETS'
    | 'RETURN_ON_EQUITY'
    | 'RETURN_ON_TANG_EQUITY';
export type YahooFinancialPeriod = 'D' | 'FQ' | 'FH' | 'FY';
export type YahooFinancialPoint = {
    time: number;
    value: number;
};
export type YahooFinancialCatalog = Record<YahooFinancialMetric, Record<YahooFinancialPeriod, YahooFinancialPoint[]>>;
type YahooFinancialCatalogCache = YahooFinancialCatalog & { cacheVersion: number };

const YAHOO_PAGE_TTL_MS = 12 * 60 * 60 * 1000;
const YAHOO_SPLITS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const YAHOO_SNAPSHOT_CACHE_VERSION = 3;
const YAHOO_FINANCIAL_CACHE_VERSION = 3;
const YAHOO_USER_AGENT = 'Mozilla/5.0 PineTS-Local-Workbench';
const YAHOO_ACCEPT_HEADER = 'application/json,text/html,*/*';
const YAHOO_FETCH_RETRY_DELAYS_MS = [250, 750];
const CURL_MAX_TIME_SECONDS = '20';
const execFileAsync = promisify(execFile);

export function normalizeYahooLookupSymbol(symbol: string) {
    const normalized = symbol.replace(/^FINRA:/i, '').replace(/^.*:/, '').trim().toUpperCase();
    return toYahooShareClassSymbol(
        normalized.replace(/_(SHORT_VOLUME|SHORT_EXEMPT_VOLUME|TOTAL_VOLUME|SHORT_RATIO)$/i, '').trim().toUpperCase(),
    );
}

function formatRequestError(error: unknown) {
    if (error instanceof Error) {
        const cause = (error as Error & { cause?: unknown }).cause;
        const causeMessage =
            cause instanceof Error
                ? cause.message
                : cause && typeof cause === 'object' && 'message' in cause && typeof cause.message === 'string'
                  ? cause.message
                  : null;
        return causeMessage && causeMessage !== error.message ? `${error.message} (cause: ${causeMessage})` : error.message;
    }
    return String(error);
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchYahooTextViaNode(url: string) {
    const response = await fetch(url, {
        signal: AbortSignal.timeout(20_000),
        headers: {
            'user-agent': YAHOO_USER_AGENT,
            accept: YAHOO_ACCEPT_HEADER,
        },
    });

    if (!response.ok) {
        throw new Error(`Yahoo request failed with ${response.status} for ${url}.`);
    }

    return response.text();
}

async function fetchYahooTextViaCurl(url: string) {
    const { stdout } = await execFileAsync(
        'curl',
        [
            '--fail-with-body',
            '--location',
            '--silent',
            '--show-error',
            '--max-time',
            CURL_MAX_TIME_SECONDS,
            '-A',
            YAHOO_USER_AGENT,
            '-H',
            `Accept: ${YAHOO_ACCEPT_HEADER}`,
            url,
        ],
        {
            maxBuffer: 10 * 1024 * 1024,
        },
    );
    return stdout;
}

export async function fetchYahooText(url: string | URL) {
    const target = String(url);
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= YAHOO_FETCH_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
            return await fetchYahooTextViaNode(target);
        } catch (error) {
            lastError = error;
            if (attempt < YAHOO_FETCH_RETRY_DELAYS_MS.length) {
                await sleep(YAHOO_FETCH_RETRY_DELAYS_MS[attempt]);
            }
        }
    }

    try {
        return await fetchYahooTextViaCurl(target);
    } catch (curlError) {
        const fetchDetail = lastError ? formatRequestError(lastError) : 'unknown fetch error';
        const curlDetail = formatRequestError(curlError);
        throw new Error(`Yahoo request failed for ${target}: fetch=${fetchDetail}; curl=${curlDetail}`);
    }
}

export async function fetchYahooJson<T>(url: string | URL): Promise<T> {
    const text = await fetchYahooText(url);
    try {
        return JSON.parse(text) as T;
    } catch (error) {
        throw new Error(`Yahoo JSON parse failed for ${String(url)}: ${formatRequestError(error)}`);
    }
}

async function fetchYahooQuoteHtml(symbol: string) {
    return fetchYahooText(`https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`);
}

function unwrapRawNumber(value: unknown) {
    if (typeof value === 'number') return value;
    if (!value || typeof value !== 'object') return null;
    const raw = (value as { raw?: unknown }).raw;
    return typeof raw === 'number' ? raw : null;
}

function extractQuoteSummaryPayload(html: string, symbol: string) {
    const pattern = new RegExp(
        `<script type="application/json" data-sveltekit-fetched data-url="https://query1\\.finance\\.yahoo\\.com/v10/finance/quoteSummary/${symbol}\\?[^"]*"[^>]*>([\\s\\S]*?)<\\/script>`,
    );
    const match = html.match(pattern);
    if (!match) return null;

    try {
        const outer = JSON.parse(match[1]) as { body?: string };
        if (!outer.body) return null;
        const inner = JSON.parse(outer.body) as {
            quoteSummary?: {
                result?: Array<Record<string, unknown>>;
            };
        };
        return inner.quoteSummary?.result?.[0] ?? null;
    } catch {
        return null;
    }
}

function mapYahooInstrumentType(type: string | null) {
    if (!type) return null;
    if (['ETF', 'MUTUALFUND', 'FUND', 'CLOSED_END_FUND'].includes(type)) return 'fund';
    if (type === 'CRYPTOCURRENCY') return 'crypto';
    if (type === 'INDEX') return 'index';
    if (type === 'FUTURE') return 'futures';
    if (type === 'CURRENCY') return 'forex';
    return 'stock';
}

export async function fetchYahooSymbolSnapshot(baseDir: string, symbolInput: string): Promise<YahooSymbolSnapshot> {
    const symbol = normalizeYahooLookupSymbol(symbolInput);
    const localSnapshot = readLocalMarketSnapshot(baseDir, symbol);
    if (localSnapshot) {
        const snapshot: YahooSymbolSnapshot = {
            cacheVersion: YAHOO_SNAPSHOT_CACHE_VERSION,
            symbol,
            instrumentType: localSnapshot.kind === 'fund' ? 'ETF' : 'EQUITY',
            syminfoType: localSnapshot.kind === 'fund' ? 'fund' : 'stock',
            regularMarketPrice: localSnapshot.regularMarketPrice,
            navPrice: localSnapshot.navPrice,
            marketCap: localSnapshot.marketCap,
            sharesOutstanding: localSnapshot.sharesOutstanding,
            totalAssets: localSnapshot.totalAssets,
        };
        await writeYahooCache(baseDir, 'yahoo_snapshot_cache', symbol, snapshot, YAHOO_PAGE_TTL_MS, YAHOO_SNAPSHOT_CACHE_VERSION);
        return snapshot;
    }

    const cached = await readYahooCache<YahooSymbolSnapshot>(baseDir, 'yahoo_snapshot_cache', symbol);
    if (cached?.cacheVersion === YAHOO_SNAPSHOT_CACHE_VERSION) return cached.payload;

    const html = await fetchYahooQuoteHtml(symbol);
    const summary = extractQuoteSummaryPayload(html, symbol);
    const price = (summary?.price as Record<string, unknown> | undefined) ?? {};
    const summaryDetail = (summary?.summaryDetail as Record<string, unknown> | undefined) ?? {};
    const defaultKeyStatistics = (summary?.defaultKeyStatistics as Record<string, unknown> | undefined) ?? {};

    const instrumentType = typeof price.quoteType === 'string' ? price.quoteType : null;
    const regularMarketPrice = unwrapRawNumber(price.regularMarketPrice);
    const navPrice = unwrapRawNumber(summaryDetail.navPrice);
    const marketCap = unwrapRawNumber(price.marketCap) ?? unwrapRawNumber(summaryDetail.marketCap);
    const sharesOutstanding = unwrapRawNumber(defaultKeyStatistics.sharesOutstanding);
    const totalAssets = unwrapRawNumber(summaryDetail.totalAssets) ?? unwrapRawNumber(price.totalAssets);

    const snapshot: YahooSymbolSnapshot = {
        cacheVersion: YAHOO_SNAPSHOT_CACHE_VERSION,
        symbol,
        instrumentType,
        syminfoType: mapYahooInstrumentType(instrumentType),
        regularMarketPrice,
        navPrice,
        marketCap,
        sharesOutstanding,
        totalAssets,
    };

    await writeYahooCache(baseDir, 'yahoo_snapshot_cache', symbol, snapshot, YAHOO_PAGE_TTL_MS, YAHOO_SNAPSHOT_CACHE_VERSION);
    return snapshot;
}

export async function fetchYahooSplits(baseDir: string, symbolInput: string): Promise<YahooSplitEvent[]> {
    const symbol = normalizeYahooLookupSymbol(symbolInput);
    const cached = await readYahooCache<YahooSplitEvent[]>(baseDir, 'yahoo_splits_cache', symbol);
    if (cached) return cached.payload;

    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
    url.searchParams.set('interval', '1d');
    url.searchParams.set('range', 'max');
    url.searchParams.set('includePrePost', 'false');
    url.searchParams.set('events', 'splits');

    const payload = await fetchYahooJson<{
        chart?: {
            result?: Array<{
                events?: {
                    splits?: Record<string, { date?: number; numerator?: number; denominator?: number }>;
                };
            }>;
        };
    }>(url);
    const rawSplits = payload?.chart?.result?.[0]?.events?.splits ?? {};
    const splits = Object.values(rawSplits)
        .map((entry) => {
            const split = entry as { date?: number; numerator?: number; denominator?: number };
            return {
                time: Number(split.date) * 1000,
                numerator: Number(split.numerator),
                denominator: Number(split.denominator),
            } satisfies YahooSplitEvent;
        })
        .filter((event) => Number.isFinite(event.time) && Number.isFinite(event.numerator) && Number.isFinite(event.denominator))
        .sort((a, b) => a.time - b.time);

    await writeYahooCache(baseDir, 'yahoo_splits_cache', symbol, splits, YAHOO_SPLITS_TTL_MS);
    return splits;
}

function pointFromSeriesEntry(entry: unknown) {
    const record = entry as { asOfDate?: string; reportedValue?: { raw?: unknown } } | null;
    const asOfDate = record?.asOfDate;
    const value = typeof record?.reportedValue?.raw === 'number' ? record.reportedValue.raw : null;
    if (!asOfDate || value == null) return null;
    const time = Date.parse(`${asOfDate}T00:00:00Z`);
    return Number.isFinite(time) ? ({ time, value } satisfies YahooFinancialPoint) : null;
}

function deriveSemiAnnualSeries(points: YahooFinancialPoint[]) {
    if (points.length <= 2) return points;
    const result: YahooFinancialPoint[] = [];
    for (let index = points.length - 1; index >= 0; index -= 2) {
        result.push(points[index]);
    }
    return result.reverse();
}

function deriveAnnualSeries(points: YahooFinancialPoint[]) {
    const byYear = new Map<number, YahooFinancialPoint>();
    for (const point of points) {
        const year = new Date(point.time).getUTCFullYear();
        byYear.set(year, point);
    }
    return [...byYear.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, point]) => point);
}

function latestValueAtOrBefore(points: YahooFinancialPoint[], time: number) {
    let latest: number | null = null;
    for (const point of points) {
        if (point.time <= time) {
            latest = point.value;
            continue;
        }
        break;
    }
    return latest;
}

function buildQuarterlyReturnSeries(numeratorPoints: YahooFinancialPoint[], denominatorPoints: YahooFinancialPoint[], annualizationFactor: number) {
    return numeratorPoints
        .map((point) => {
            const denominator = latestValueAtOrBefore(denominatorPoints, point.time);
            if (denominator == null || denominator === 0) return null;
            return {
                time: point.time,
                value: (point.value * annualizationFactor * 100) / denominator,
            } satisfies YahooFinancialPoint;
        })
        .filter((point): point is YahooFinancialPoint => point != null);
}

function buildHalfYearReturnSeries(numeratorPoints: YahooFinancialPoint[], denominatorPoints: YahooFinancialPoint[]) {
    const result: YahooFinancialPoint[] = [];
    for (let index = 1; index < numeratorPoints.length; index += 1) {
        const current = numeratorPoints[index];
        const previous = numeratorPoints[index - 1];
        const denominator = latestValueAtOrBefore(denominatorPoints, current.time);
        if (denominator == null || denominator === 0) continue;
        result.push({
            time: current.time,
            value: ((current.value + previous.value) * 2 * 100) / denominator,
        });
    }
    return result;
}

function buildTrailingReturnSeries(numeratorPoints: YahooFinancialPoint[], denominatorPoints: YahooFinancialPoint[]) {
    return numeratorPoints
        .map((point) => {
            const denominator = latestValueAtOrBefore(denominatorPoints, point.time);
            if (denominator == null || denominator === 0) return null;
            return {
                time: point.time,
                value: (point.value * 100) / denominator,
            } satisfies YahooFinancialPoint;
        })
        .filter((point): point is YahooFinancialPoint => point != null);
}

export async function fetchYahooFinancialCatalog(baseDir: string, symbolInput: string): Promise<YahooFinancialCatalog> {
    const symbol = normalizeYahooLookupSymbol(symbolInput);
    const localSnapshot = readLocalMarketSnapshot(baseDir, symbol);
    if (localSnapshot) {
        // Local cache snapshot values are not historical timeseries points.
        // Anchor them at 0 so Pine request.financial can reuse the latest cached
        // value across the visible chart window instead of returning NaN until
        // the exact snapshot timestamp is reached.
        const pointTime = 0;
        const flatPoint = (value: number | null) =>
            value != null && Number.isFinite(value) ? [{ time: pointTime, value }] : [];
        const catalog: YahooFinancialCatalogCache = {
            cacheVersion: YAHOO_FINANCIAL_CACHE_VERSION,
            AUM:
                localSnapshot.kind === 'fund'
                    ? { D: flatPoint(localSnapshot.totalAssets), FQ: flatPoint(localSnapshot.totalAssets), FH: flatPoint(localSnapshot.totalAssets), FY: flatPoint(localSnapshot.totalAssets) }
                    : { D: [], FQ: [], FH: [], FY: [] },
            NAV:
                localSnapshot.kind === 'fund'
                    ? { D: flatPoint(localSnapshot.navPrice), FQ: flatPoint(localSnapshot.navPrice), FH: flatPoint(localSnapshot.navPrice), FY: flatPoint(localSnapshot.navPrice) }
                    : { D: [], FQ: [], FH: [], FY: [] },
            NAV_ALL:
                localSnapshot.kind === 'fund'
                    ? { D: flatPoint(localSnapshot.navPrice), FQ: flatPoint(localSnapshot.navPrice), FH: flatPoint(localSnapshot.navPrice), FY: flatPoint(localSnapshot.navPrice) }
                    : { D: [], FQ: [], FH: [], FY: [] },
            TOTAL_ASSETS: {
                D: localSnapshot.kind === 'fund' ? flatPoint(localSnapshot.totalAssets) : [],
                FQ: flatPoint(localSnapshot.totalAssets),
                FH: flatPoint(localSnapshot.totalAssets),
                FY: flatPoint(localSnapshot.totalAssets),
            },
            TOTAL_EQUITY: {
                D: localSnapshot.kind === 'fund' ? flatPoint(localSnapshot.totalEquity) : [],
                FQ: flatPoint(localSnapshot.totalEquity),
                FH: flatPoint(localSnapshot.totalEquity),
                FY: flatPoint(localSnapshot.totalEquity),
            },
            RETURN_ON_ASSETS: {
                D: [],
                FQ: flatPoint(localSnapshot.returnOnAssets),
                FH: flatPoint(localSnapshot.returnOnAssets),
                FY: flatPoint(localSnapshot.returnOnAssets),
            },
            RETURN_ON_EQUITY: {
                D: [],
                FQ: flatPoint(localSnapshot.returnOnEquity),
                FH: flatPoint(localSnapshot.returnOnEquity),
                FY: flatPoint(localSnapshot.returnOnEquity),
            },
            RETURN_ON_TANG_EQUITY: { D: [], FQ: [], FH: [], FY: [] },
        };
        await writeYahooCache(baseDir, 'yahoo_financials_cache', symbol, catalog, YAHOO_PAGE_TTL_MS, YAHOO_FINANCIAL_CACHE_VERSION);
        return {
            AUM: catalog.AUM,
            NAV: catalog.NAV,
            NAV_ALL: catalog.NAV_ALL,
            TOTAL_ASSETS: catalog.TOTAL_ASSETS,
            TOTAL_EQUITY: catalog.TOTAL_EQUITY,
            RETURN_ON_ASSETS: catalog.RETURN_ON_ASSETS,
            RETURN_ON_EQUITY: catalog.RETURN_ON_EQUITY,
            RETURN_ON_TANG_EQUITY: catalog.RETURN_ON_TANG_EQUITY,
        };
    }

    const cached = await readYahooCache<YahooFinancialCatalogCache>(baseDir, 'yahoo_financials_cache', symbol);
    if (cached?.cacheVersion === YAHOO_FINANCIAL_CACHE_VERSION) {
        const payload = cached.payload;
        return {
            AUM: payload.AUM,
            NAV: payload.NAV,
            NAV_ALL: payload.NAV_ALL,
            TOTAL_ASSETS: payload.TOTAL_ASSETS,
            TOTAL_EQUITY: payload.TOTAL_EQUITY,
            RETURN_ON_ASSETS: payload.RETURN_ON_ASSETS,
            RETURN_ON_EQUITY: payload.RETURN_ON_EQUITY,
            RETURN_ON_TANG_EQUITY: payload.RETURN_ON_TANG_EQUITY,
        };
    }

    const snapshot = await fetchYahooSymbolSnapshot(baseDir, symbol);
    if (snapshot.syminfoType === 'fund') {
        const flatAssets = snapshot.totalAssets != null ? [{ time: 0, value: snapshot.totalAssets }] : [];
        const navValue = snapshot.navPrice ?? snapshot.regularMarketPrice;
        const flatNav = navValue != null ? [{ time: 0, value: navValue }] : [];
        const catalog: YahooFinancialCatalogCache = {
            cacheVersion: YAHOO_FINANCIAL_CACHE_VERSION,
            AUM: { D: flatAssets, FQ: flatAssets, FH: flatAssets, FY: flatAssets },
            NAV: { D: flatNav, FQ: flatNav, FH: flatNav, FY: flatNav },
            NAV_ALL: { D: flatNav, FQ: flatNav, FH: flatNav, FY: flatNav },
            TOTAL_ASSETS: { D: flatAssets, FQ: flatAssets, FH: flatAssets, FY: flatAssets },
            TOTAL_EQUITY: { D: flatAssets, FQ: flatAssets, FH: flatAssets, FY: flatAssets },
            RETURN_ON_ASSETS: { D: [], FQ: [], FH: [], FY: [] },
            RETURN_ON_EQUITY: { D: [], FQ: [], FH: [], FY: [] },
            RETURN_ON_TANG_EQUITY: { D: [], FQ: [], FH: [], FY: [] },
        };
        await writeYahooCache(baseDir, 'yahoo_financials_cache', symbol, catalog, YAHOO_PAGE_TTL_MS, YAHOO_FINANCIAL_CACHE_VERSION);
        return {
            AUM: catalog.AUM,
            NAV: catalog.NAV,
            NAV_ALL: catalog.NAV_ALL,
            TOTAL_ASSETS: catalog.TOTAL_ASSETS,
            TOTAL_EQUITY: catalog.TOTAL_EQUITY,
            RETURN_ON_ASSETS: catalog.RETURN_ON_ASSETS,
            RETURN_ON_EQUITY: catalog.RETURN_ON_EQUITY,
            RETURN_ON_TANG_EQUITY: catalog.RETURN_ON_TANG_EQUITY,
        };
    }

    const types = [
        'quarterlyTotalAssets',
        'annualTotalAssets',
        'quarterlyStockholdersEquity',
        'annualStockholdersEquity',
        'quarterlyNetTangibleAssets',
        'annualNetTangibleAssets',
        'quarterlyNetIncomeCommonStockholders',
        'annualNetIncomeCommonStockholders',
        'trailingNetIncomeCommonStockholders',
    ];
    const url = new URL(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}`);
    url.searchParams.set('merge', 'false');
    url.searchParams.set('padTimeSeries', 'true');
    url.searchParams.set('period1', String(Math.floor(Date.UTC(2000, 0, 1) / 1000)));
    url.searchParams.set('period2', String(Math.floor((Date.now() + 86400000) / 1000)));
    url.searchParams.set('type', types.join(','));
    url.searchParams.set('lang', 'en-US');
    url.searchParams.set('region', 'US');

    const payload = await fetchYahooJson<{
        timeseries?: {
            result?: Array<Record<string, unknown>>;
        };
    }>(url);

    const byType = new Map<string, YahooFinancialPoint[]>();
    for (const item of payload.timeseries?.result ?? []) {
        const type = Array.isArray((item.meta as { type?: string[] } | undefined)?.type)
            ? ((item.meta as { type?: string[] }).type?.[0] ?? '')
            : '';
        if (!type) continue;
        const points = Array.isArray(item[type]) ? item[type].map(pointFromSeriesEntry).filter((point): point is YahooFinancialPoint => point != null) : [];
        byType.set(type, points.sort((a, b) => a.time - b.time));
    }

    const quarterlyAssets = byType.get('quarterlyTotalAssets') ?? [];
    const annualAssets = byType.get('annualTotalAssets') ?? [];
    const quarterlyEquity = byType.get('quarterlyStockholdersEquity') ?? [];
    const annualEquity = byType.get('annualStockholdersEquity') ?? [];
    const quarterlyTangibleEquity = byType.get('quarterlyNetTangibleAssets') ?? [];
    const annualTangibleEquity = byType.get('annualNetTangibleAssets') ?? [];
    const quarterlyNetIncome = byType.get('quarterlyNetIncomeCommonStockholders') ?? [];
    const annualNetIncome = byType.get('annualNetIncomeCommonStockholders') ?? [];
    const trailingNetIncome = byType.get('trailingNetIncomeCommonStockholders') ?? [];

    const yearlyAssets = annualAssets.length > 0 ? annualAssets : deriveAnnualSeries(quarterlyAssets);
    const yearlyEquity = annualEquity.length > 0 ? annualEquity : deriveAnnualSeries(quarterlyEquity);
    const yearlyTangibleEquity = annualTangibleEquity.length > 0 ? annualTangibleEquity : deriveAnnualSeries(quarterlyTangibleEquity);
    const yearlyNetIncome = annualNetIncome.length > 0 ? annualNetIncome : deriveAnnualSeries(quarterlyNetIncome);

    const roaFQ = buildQuarterlyReturnSeries(quarterlyNetIncome, quarterlyAssets, 4);
    const roeFQ = buildQuarterlyReturnSeries(quarterlyNetIncome, quarterlyEquity, 4);
    const roteFQ = buildQuarterlyReturnSeries(quarterlyNetIncome, quarterlyTangibleEquity, 4);

    const roaFH = buildHalfYearReturnSeries(quarterlyNetIncome, quarterlyAssets);
    const roeFH = buildHalfYearReturnSeries(quarterlyNetIncome, quarterlyEquity);
    const roteFH = buildHalfYearReturnSeries(quarterlyNetIncome, quarterlyTangibleEquity);

    const roaFY = trailingNetIncome.length > 0 ? buildTrailingReturnSeries(trailingNetIncome, quarterlyAssets) : buildTrailingReturnSeries(yearlyNetIncome, yearlyAssets);
    const roeFY = trailingNetIncome.length > 0 ? buildTrailingReturnSeries(trailingNetIncome, quarterlyEquity) : buildTrailingReturnSeries(yearlyNetIncome, yearlyEquity);
    const roteFY =
        trailingNetIncome.length > 0 ? buildTrailingReturnSeries(trailingNetIncome, quarterlyTangibleEquity) : buildTrailingReturnSeries(yearlyNetIncome, yearlyTangibleEquity);

    const catalog: YahooFinancialCatalogCache = {
        cacheVersion: YAHOO_FINANCIAL_CACHE_VERSION,
        AUM: { D: [], FQ: [], FH: [], FY: [] },
        NAV: { D: [], FQ: [], FH: [], FY: [] },
        NAV_ALL: { D: [], FQ: [], FH: [], FY: [] },
        TOTAL_ASSETS: {
            D: [],
            FQ: quarterlyAssets,
            FH: deriveSemiAnnualSeries(quarterlyAssets),
            FY: yearlyAssets,
        },
        TOTAL_EQUITY: {
            D: [],
            FQ: quarterlyEquity,
            FH: deriveSemiAnnualSeries(quarterlyEquity),
            FY: yearlyEquity,
        },
        RETURN_ON_ASSETS: {
            D: [],
            FQ: roaFQ,
            FH: roaFH,
            FY: roaFY,
        },
        RETURN_ON_EQUITY: {
            D: [],
            FQ: roeFQ,
            FH: roeFH,
            FY: roeFY,
        },
        RETURN_ON_TANG_EQUITY: {
            D: [],
            FQ: roteFQ,
            FH: roteFH,
            FY: roteFY,
        },
    };

    await writeYahooCache(baseDir, 'yahoo_financials_cache', symbol, catalog, YAHOO_PAGE_TTL_MS, YAHOO_FINANCIAL_CACHE_VERSION);
    return {
        AUM: catalog.AUM,
        NAV: catalog.NAV,
        NAV_ALL: catalog.NAV_ALL,
        TOTAL_ASSETS: catalog.TOTAL_ASSETS,
        TOTAL_EQUITY: catalog.TOTAL_EQUITY,
        RETURN_ON_ASSETS: catalog.RETURN_ON_ASSETS,
        RETURN_ON_EQUITY: catalog.RETURN_ON_EQUITY,
        RETURN_ON_TANG_EQUITY: catalog.RETURN_ON_TANG_EQUITY,
    };
}
