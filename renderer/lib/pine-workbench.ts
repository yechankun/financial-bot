import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PineTS, Provider } from 'pinets';
import { readYahooChartCache, writeYahooChartCache } from './cache-db';
import { toYahooShareClassSymbol } from './symbols';
import { alignSecondaryValue, fetchFinraCandles, inferFinraFieldFromParam, resolveFinraFieldName } from './finra';
import {
    fetchYahooJson,
    fetchYahooFinancialCatalog,
    fetchYahooSplits,
    fetchYahooSymbolSnapshot,
    normalizeYahooLookupSymbol,
    type YahooFinancialCatalog,
    type YahooFinancialMetric,
    type YahooFinancialPeriod,
    type YahooFinancialPoint,
    type YahooSplitEvent,
    type YahooSymbolSnapshot,
} from './yahoo';

export type DataSource = 'yahoo' | 'binance' | 'finra';
export type PlotPane = 'overlay' | 'oscillator';

export type Candle = {
    openTime: number;
    closeTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
};

export type PinePlotPoint = {
    title: string;
    time: number;
    value: number;
    options?: Record<string, unknown>;
};

export type PinePlotSeries = {
    id: string;
    title: string;
    color: string;
    style: string;
    pane: PlotPane;
    data: PinePlotPoint[];
};

export type PineLineDrawing = {
    id: number;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    xloc: string;
    extend: string;
    color: string;
    style: string;
    width: number;
    forceOverlay: boolean;
};

export type PineShapeMarker = {
    id: string;
    title: string;
    time: number;
    color: string;
    text: string;
    shape: string;
    location: string;
    size: string;
    pane: PlotPane;
};

type RawPlot = {
    data?: Array<{
        time?: number;
        value?: unknown;
        options?: Record<string, unknown>;
    }>;
};

type PlotDirective = {
    title: string;
    style?: string;
    display?: string;
};

type IndicatorDirective = {
    kind?: 'indicator' | 'strategy';
    overlay?: boolean;
};

export type RunAnalysisOptions = {
    source: DataSource;
    symbol: string;
    timeframe: string;
    limit?: number;
    pineCode: string;
    baseDir?: string;
};

export type RunAnalysisResult = {
    source: DataSource;
    symbol: string;
    timeframe: string;
    limit: number;
    candles: Candle[];
    series: PinePlotSeries[];
    lines: PineLineDrawing[];
    markers: PineShapeMarker[];
    warnings: string[];
};

export type LoadedMarketData = {
    source: DataSource;
    symbol: string;
    timeframe: string;
    limit: number;
    candles: Candle[];
};

type PinePatchOptions = {
    source: DataSource;
    symbol: string;
    timeframe: string;
    limit: number;
    baseDir: string;
    primaryCandles?: Candle[];
    primaryYahooSnapshot?: YahooSymbolSnapshot | null;
    primaryYahooSplits?: YahooSplitEvent[];
    primaryYahooFinancials?: YahooFinancialCatalog | null;
    primaryFinraCandles?: Candle[];
    primaryFinraTimeframe?: 'D' | 'W' | 'M' | null;
    sharedFinraCache?: Map<string, Promise<Candle[]>>;
    sharedLowerTfCandleCache?: Map<string, Promise<Candle[]>>;
};

export type PinePrimaryResources = {
    primaryYahooSnapshot: YahooSymbolSnapshot | null;
    primaryYahooSplits: YahooSplitEvent[];
    primaryYahooFinancials: YahooFinancialCatalog | null;
    primaryFinraCandles: Candle[];
    primaryFinraTimeframe: 'D' | 'W' | 'M' | null;
    warnings: string[];
};

export type PinePrimaryResourceLoadOptions = {
    includeYahooSnapshot?: boolean;
    includeYahooSplits?: boolean;
    includeYahooFinancials?: boolean;
    includeFinraCandles?: boolean;
    tolerateYahooSplitFailures?: boolean;
};

type LowerTfField = 'open' | 'high' | 'low' | 'close' | 'volume' | 'hl2' | 'hlc3' | 'ohlc4';
type LowerTfExpressionSpec =
    | { kind: 'field'; field: LowerTfField }
    | { kind: 'denom'; priceField: LowerTfField }
    | { kind: 'cumAdj'; enabled: boolean };

type YahooChartResult = {
    timestamp?: number[];
    meta?: {
        exchangeTimezoneName?: string;
        regularMarketTime?: number;
    };
    indicators?: {
        quote?: Array<{
            open?: number[];
            high?: number[];
            low?: number[];
            close?: number[];
            volume?: number[];
        }>;
    };
};

type YahooChartCacheEntry = {
    symbol: string;
    interval: string;
    range: string;
    promise: Promise<YahooChartCacheValue>;
    fetchedAt: number;
};

type YahooChartCacheValue = {
    result: YahooChartResult | undefined;
    candles: Candle[];
};

const PINE_CONTEXT_PATCHED = Symbol.for('financial-bot.pine-context-patched');
const PINE_PROTOTYPE_PATCHED = Symbol.for('financial-bot.pine-prototype-patched');
const PINE_PATCH_OPTIONS_BY_SOURCE = new WeakMap<object, PinePatchOptions>();
const LOWER_TF_PRICE_FIELDS: LowerTfField[] = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4'];
const LOWER_TF_ALL_FIELDS: LowerTfField[] = [...LOWER_TF_PRICE_FIELDS, 'volume'];

const YAHOO_INTERVAL_MAP: Record<string, string> = {
    D: '1d',
    W: '1wk',
    M: '1mo',
    '60': '60m',
};

const ONE_DAY_MS = 86400000;
const RENDERER_BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZONED_PARTS_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
const ZONED_PARTS_CACHE = new Map<string, ReturnType<typeof parseZonedParts>>();
const ZONED_MIDNIGHT_CACHE = new Map<string, number>();
const YAHOO_CHART_CACHE_TTL_MS = 30000;
const YAHOO_CHART_CACHE_VERSION = 1;
const YAHOO_CHART_CACHE = new Map<string, YahooChartCacheEntry>();

const YAHOO_RANGE_BY_LIMIT = (limit: number, timeframe: string) => {
    if (timeframe === '60') {
        if (limit <= 100) return '1mo';
        if (limit <= 500) return '6mo';
        return '2y';
    }

    if (timeframe === 'W') {
        if (limit <= 104) return '5y';
        return '10y';
    }

    if (timeframe === 'M') return 'max';

    if (limit <= 130) return '1y';
    if (limit <= 260) return '2y';
    if (limit <= 780) return '5y';
    return '10y';
};

function invariant(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function pad2(value: number) {
    return String(value).padStart(2, '0');
}

function parseZonedParts(parts: Intl.DateTimeFormatPart[]) {
    const read = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return {
        year: Number(read('year')),
        month: Number(read('month')),
        day: Number(read('day')),
        weekday: read('weekday'),
        hour: Number(read('hour')),
        minute: Number(read('minute')),
        second: Number(read('second')),
    };
}

function getZonedPartsFormatter(timeZone: string) {
    const cached = ZONED_PARTS_FORMATTER_CACHE.get(timeZone);
    if (cached) return cached;
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
    ZONED_PARTS_FORMATTER_CACHE.set(timeZone, formatter);
    return formatter;
}

export function clampLimit(limit: number | undefined, fallback = 300) {
    if (!Number.isFinite(limit)) return fallback;
    return Math.max(50, Math.min(2000, Math.floor(limit ?? fallback)));
}

export function normalizeSource(value: string | undefined): DataSource {
    if (value === 'binance') return 'binance';
    if (value === 'finra') return 'finra';
    return 'yahoo';
}

export function normalizeYahooSymbol(symbol: string) {
    return toYahooShareClassSymbol(symbol.trim().toUpperCase());
}

export function normalizeBinanceSymbol(symbol: string) {
    return symbol.replace(/[/.:-]/g, '').trim().toUpperCase();
}

export function normalizeTimeframe(source: DataSource, timeframe: string | undefined) {
    const normalized = (timeframe ?? 'D').toUpperCase();
    if (source === 'finra') {
        if (!['D', 'W', 'M'].includes(normalized)) {
            throw new Error('FINRA source currently supports D, W, and M timeframes.');
        }
        return normalized;
    }
    if (source === 'yahoo') {
        if (!['D', 'W', 'M', '60'].includes(normalized)) {
            throw new Error('Yahoo source currently supports D, W, M, and 60 timeframes.');
        }
        return normalized;
    }
    if (!['1', '3', '5', '15', '30', '60', '120', '240', 'D', 'W', 'M'].includes(normalized)) {
        throw new Error('Unsupported Binance timeframe.');
    }
    return normalized;
}

function getZonedParts(time: number, timeZone: string) {
    const cacheKey = `${timeZone}:${Math.floor(time / 1000)}`;
    const cached = ZONED_PARTS_CACHE.get(cacheKey);
    if (cached) return cached;
    const parsed = parseZonedParts(getZonedPartsFormatter(timeZone).formatToParts(new Date(time)));
    ZONED_PARTS_CACHE.set(cacheKey, parsed);
    return parsed;
}

function getTimeZoneOffsetMs(time: number, timeZone: string) {
    const zoned = getZonedParts(time, timeZone);
    const asUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second);
    const rounded = Math.floor(time / 1000) * 1000;
    return asUtc - rounded;
}

function zonedMidnightToUtc(year: number, month: number, day: number, timeZone: string) {
    const cacheKey = `${timeZone}:${year}-${pad2(month)}-${pad2(day)}`;
    const cached = ZONED_MIDNIGHT_CACHE.get(cacheKey);
    if (cached !== undefined) return cached;
    let guess = Date.UTC(year, month - 1, day, 0, 0, 0);
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const offset = getTimeZoneOffsetMs(guess, timeZone);
        const resolved = Date.UTC(year, month - 1, day, 0, 0, 0) - offset;
        if (resolved === guess) {
            ZONED_MIDNIGHT_CACHE.set(cacheKey, resolved);
            return resolved;
        }
        guess = resolved;
    }
    ZONED_MIDNIGHT_CACHE.set(cacheKey, guess);
    return guess;
}

function startOfWeekInTimeZone(time: number, timeZone: string) {
    const zoned = getZonedParts(time, timeZone);
    const weekdayIndexMap: Record<string, number> = {
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
        Sun: 0,
    };
    const weekday = weekdayIndexMap[zoned.weekday] ?? 0;
    const offset = weekday === 0 ? -6 : 1 - weekday;
    const localDate = new Date(Date.UTC(zoned.year, zoned.month - 1, zoned.day));
    localDate.setUTCDate(localDate.getUTCDate() + offset);
    return zonedMidnightToUtc(localDate.getUTCFullYear(), localDate.getUTCMonth() + 1, localDate.getUTCDate(), timeZone);
}

function makeYahooChartCacheKey(symbol: string, interval: string, range: string) {
    return `${symbol}:${interval}:${range}`;
}

function getYahooChartCacheTtlMs(interval: string) {
    if (interval === '60m') return 5 * 60 * 1000;
    return 60 * 60 * 1000;
}

function mapYahooChartResultToCandles(result: {
    timestamp?: number[];
    meta?: {
        exchangeTimezoneName?: string;
    };
    indicators?: {
        quote?: Array<{
            open?: number[];
            high?: number[];
            low?: number[];
            close?: number[];
            volume?: number[];
        }>;
    };
} | undefined, symbol: string) {
    const timestamps: number[] | undefined = result?.timestamp;
    const quote = result?.indicators?.quote?.[0];
    invariant(Array.isArray(timestamps) && quote, `No Yahoo candle data for ${symbol}.`);

    const candles: Candle[] = [];
    for (let i = 0; i < timestamps.length; i += 1) {
        const open = Number(quote.open?.[i]);
        const high = Number(quote.high?.[i]);
        const low = Number(quote.low?.[i]);
        const close = Number(quote.close?.[i]);
        const volume = Number(quote.volume?.[i] ?? 0);
        const openTime = timestamps[i] * 1000;
        if (![open, high, low, close].every(Number.isFinite)) continue;

        candles.push({
            openTime,
            closeTime: i < timestamps.length - 1 ? timestamps[i + 1] * 1000 : openTime,
            open,
            high,
            low,
            close,
            volume: Number.isFinite(volume) ? volume : 0,
        });
    }

    return candles;
}

async function fetchYahooChartCached(symbol: string, interval: string, range: string) {
    const now = Date.now();
    const cacheKey = makeYahooChartCacheKey(symbol, interval, range);
    const cached = YAHOO_CHART_CACHE.get(cacheKey);
    if (cached && now - cached.fetchedAt <= YAHOO_CHART_CACHE_TTL_MS) {
        return cached.promise;
    }

    const diskCached = await readYahooChartCache<YahooChartResult>(RENDERER_BASE_DIR, cacheKey);
    if (diskCached?.cacheVersion === YAHOO_CHART_CACHE_VERSION) {
        try {
            const value = {
                result: diskCached.payload,
                candles: mapYahooChartResultToCandles(diskCached.payload, symbol),
            } satisfies YahooChartCacheValue;
            const promise = Promise.resolve(value);
            YAHOO_CHART_CACHE.set(cacheKey, {
                symbol,
                interval,
                range,
                promise,
                fetchedAt: now,
            });
            return value;
        } catch {
            // Ignore corrupt cache rows and refresh from Yahoo.
        }
    }

    const promise = (async () => {
        const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
        url.searchParams.set('interval', interval);
        url.searchParams.set('range', range);
        url.searchParams.set('includePrePost', 'false');
        url.searchParams.set('events', 'div,splits');

        const payload = await fetchYahooJson<{
            chart?: {
                result?: YahooChartResult[];
            };
        }>(url);
        const result = payload?.chart?.result?.[0];
        const candles = mapYahooChartResultToCandles(result, symbol);
        await writeYahooChartCache(RENDERER_BASE_DIR, {
            cacheKey,
            symbol,
            interval,
            range,
            payload: result ?? null,
            ttlMs: getYahooChartCacheTtlMs(interval),
            cacheVersion: YAHOO_CHART_CACHE_VERSION,
        });
        return { result, candles } satisfies YahooChartCacheValue;
    })();

    YAHOO_CHART_CACHE.set(cacheKey, {
        symbol,
        interval,
        range,
        promise,
        fetchedAt: now,
    });

    try {
        return await promise;
    } catch (error) {
        const current = YAHOO_CHART_CACHE.get(cacheKey);
        if (current?.promise === promise) {
            YAHOO_CHART_CACHE.delete(cacheKey);
        }
        throw error;
    }
}

function findReusableYahooDailyCache(symbol: string, minimumCandles: number) {
    const now = Date.now();
    const candidates = [...YAHOO_CHART_CACHE.values()]
        .filter((entry) => entry.symbol === symbol && entry.interval === '1d' && now - entry.fetchedAt <= YAHOO_CHART_CACHE_TTL_MS)
        .sort((a, b) => b.fetchedAt - a.fetchedAt);
    return (async () => {
        for (const candidate of candidates) {
            const value = await candidate.promise;
            if (value.candles.length >= minimumCandles) {
                return value;
            }
        }
        return null;
    })();
}

function aggregateWeeklyYahooCandlesFromDaily(candles: Candle[], timeZone: string, regularMarketTimeMs?: number) {
    const weeklyCandles: Candle[] = [];
    let currentWeekStart: number | null = null;
    let currentWeekly: Candle | null = null;

    for (const candle of sortCandlesAscending(candles)) {
        const weekStart = startOfWeekInTimeZone(candle.openTime, timeZone);
        if (weekStart !== currentWeekStart) {
            if (currentWeekly) {
                currentWeekly.closeTime = weekStart;
                weeklyCandles.push(currentWeekly);
            }
            currentWeekStart = weekStart;
            currentWeekly = {
                openTime: weekStart,
                closeTime: weekStart,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume,
            };
            continue;
        }

        currentWeekly!.high = Math.max(currentWeekly!.high, candle.high);
        currentWeekly!.low = Math.min(currentWeekly!.low, candle.low);
        currentWeekly!.close = candle.close;
        currentWeekly!.volume += candle.volume;
    }

    if (currentWeekly) {
        if (Number.isFinite(regularMarketTimeMs)) {
            currentWeekly.closeTime = regularMarketTimeMs as number;
        } else {
            const nextWeek = new Date(currentWeekly.openTime);
            nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);
            currentWeekly.closeTime = zonedMidnightToUtc(nextWeek.getUTCFullYear(), nextWeek.getUTCMonth() + 1, nextWeek.getUTCDate(), timeZone);
        }
        weeklyCandles.push(currentWeekly);
    }

    return weeklyCandles;
}

function yahooDailyRangeForWeeklyLimit(limit: number) {
    if (limit <= 180) return '5y';
    return '10y';
}

export async function fetchYahooCandles(symbol: string, timeframe: string, limit: number): Promise<Candle[]> {
    if (timeframe === 'W') {
        const dailyRange = yahooDailyRangeForWeeklyLimit(limit);
        const minimumDailyCandles = Math.max(limit * 5, 260);
        const reusableDaily = await findReusableYahooDailyCache(symbol, minimumDailyCandles);
        const dailyChart = reusableDaily ?? (await fetchYahooChartCached(symbol, '1d', dailyRange));
        const chartResult = dailyChart.result;
        const dailyCandles = dailyChart.candles;
        const timeZone = chartResult?.meta?.exchangeTimezoneName ?? 'UTC';
        const regularMarketTimeMs = Number(chartResult?.meta?.regularMarketTime) * 1000;
        const weeklyCandles = aggregateWeeklyYahooCandlesFromDaily(dailyCandles, timeZone, regularMarketTimeMs);
        return weeklyCandles.slice(-limit);
    }

    const interval = YAHOO_INTERVAL_MAP[timeframe];
    invariant(interval, `Unsupported Yahoo timeframe: ${timeframe}`);

    const range = YAHOO_RANGE_BY_LIMIT(limit, timeframe);
    const chart = await fetchYahooChartCached(symbol, interval, range);
    return chart.candles.slice(-limit);
}

export function sortCandlesAscending(candles: Candle[]) {
    return [...candles].sort((a, b) => a.openTime - b.openTime);
}

function splitTopLevelArgs(input: string) {
    const args: string[] = [];
    let current = '';
    let depth = 0;
    let quote: '"' | "'" | null = null;

    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];
        const prev = input[index - 1];

        if (quote) {
            current += char;
            if (char === quote && prev !== '\\') {
                quote = null;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            current += char;
            continue;
        }

        if (char === '(' || char === '[' || char === '{') {
            depth += 1;
            current += char;
            continue;
        }

        if (char === ')' || char === ']' || char === '}') {
            depth = Math.max(0, depth - 1);
            current += char;
            continue;
        }

        if (char === ',' && depth === 0) {
            args.push(current.trim());
            current = '';
            continue;
        }

        current += char;
    }

    if (current.trim()) {
        args.push(current.trim());
    }

    return args;
}

function normalizePlotStyleName(style: string) {
    if (!style.startsWith('style_')) return style;
    return style.slice('style_'.length);
}

function extractDeclarationCall(source: string, directive: 'indicator' | 'strategy') {
    const needle = `${directive}(`;
    const start = source.indexOf(needle);
    if (start < 0) return null;

    let cursor = start + needle.length;
    let depth = 1;
    let quote: '"' | "'" | null = null;
    let call = '';

    while (cursor < source.length && depth > 0) {
        const char = source[cursor];
        const prev = source[cursor - 1];

        if (quote) {
            call += char;
            if (char === quote && prev !== '\\') {
                quote = null;
            }
            cursor += 1;
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            call += char;
            cursor += 1;
            continue;
        }

        if (char === '(') {
            depth += 1;
            call += char;
            cursor += 1;
            continue;
        }

        if (char === ')') {
            depth -= 1;
            if (depth > 0) {
                call += char;
            }
            cursor += 1;
            continue;
        }

        call += char;
        cursor += 1;
    }

    return call;
}

function extractIndicatorDirective(pineCode: string): IndicatorDirective {
    const source = pineCode ?? '';
    const indicatorCall = extractDeclarationCall(source, 'indicator');
    const strategyCall = indicatorCall ? null : extractDeclarationCall(source, 'strategy');
    const call = indicatorCall ?? strategyCall;
    const kind: 'indicator' | 'strategy' | undefined = indicatorCall ? 'indicator' : strategyCall ? 'strategy' : undefined;
    if (!call) return {};
    const args = splitTopLevelArgs(call);
    const overlayArg = args.find((arg) => arg.startsWith('overlay=') || arg.startsWith('overlay ='));
    if (!overlayArg) {
        return {
            kind,
            overlay: kind === 'indicator' ? false : kind === 'strategy' ? true : undefined,
        };
    }
    const overlayMatch = overlayArg.match(/overlay\s*=\s*(true|false)/);
    return overlayMatch ? { kind, overlay: overlayMatch[1] === 'true' } : { kind };
}

function extractPlotDirectives(pineCode: string) {
    const directives = new Map<string, PlotDirective>();
    const source = pineCode ?? '';

    for (let index = 0; index < source.length; index += 1) {
        if (!source.startsWith('plot(', index)) continue;
        let cursor = index + 'plot('.length;
        let depth = 1;
        let quote: '"' | "'" | null = null;
        let call = '';

        while (cursor < source.length && depth > 0) {
            const char = source[cursor];
            const prev = source[cursor - 1];

            if (quote) {
                call += char;
                if (char === quote && prev !== '\\') {
                    quote = null;
                }
                cursor += 1;
                continue;
            }

            if (char === '"' || char === "'") {
                quote = char;
                call += char;
                cursor += 1;
                continue;
            }

            if (char === '(') {
                depth += 1;
                call += char;
                cursor += 1;
                continue;
            }

            if (char === ')') {
                depth -= 1;
                if (depth > 0) {
                    call += char;
                }
                cursor += 1;
                continue;
            }

            call += char;
            cursor += 1;
        }

        index = cursor;

        const args = splitTopLevelArgs(call);
        if (args.length < 2) continue;

        const positionalTitleMatch = args[1]?.match(/^["'](.+?)["']$/);
        const namedTitleArg = args.find((arg) => arg.startsWith('title=') || arg.startsWith('title ='));
        const namedTitleMatch = namedTitleArg?.match(/title\s*=\s*["'](.+?)["']/);
        const title = positionalTitleMatch?.[1] ?? namedTitleMatch?.[1];
        if (!title) continue;

        const styleArg = args.find((arg) => arg.startsWith('style=') || arg.startsWith('style ='));
        const styleMatch = styleArg?.match(/style\s*=\s*plot\.(style_[A-Za-z0-9_]+)/);
        const displayArg = args.find((arg) => arg.startsWith('display=') || arg.startsWith('display ='));
        const displayMatch = displayArg?.match(/display\s*=\s*display\.([A-Za-z0-9_]+)/);

        directives.set(title, {
            title,
            style: styleMatch ? normalizePlotStyleName(styleMatch[1]) : undefined,
            display: displayMatch?.[1],
        });
    }

    return directives;
}

export function normalizePlotData(
    rawPlots: Record<string, RawPlot>,
    candles: Candle[],
    directives?: Map<string, PlotDirective>,
    indicatorDirective?: IndicatorDirective,
): PinePlotSeries[] {
    const priceMin = Math.min(...candles.map((c) => c.low));
    const priceMax = Math.max(...candles.map((c) => c.high));
    const priceRange = Math.max(priceMax - priceMin, 1);

    return Object.entries(rawPlots)
        .filter(([key]) => !key.startsWith('__'))
        .map(([title, plot]) => {
            const normalizedPoints: PinePlotPoint[] = (plot.data ?? [])
                .filter((point) => Number.isFinite(point?.time) && Number.isFinite(point?.value))
                .map((point) => ({
                    title,
                    time: Number(point.time),
                    value: Number(point.value),
                    options: point.options ?? {},
                }))
                .sort((a, b) => a.time - b.time);

            if (normalizedPoints.length === 0) {
                return null;
            }

            const sampleOptions = normalizedPoints.find((point) => point.options)?.options ?? {};
            const directive = directives?.get(title);
            if (directive?.display === 'none' || directive?.display === 'data_window') {
                return null;
            }
            const style =
                typeof sampleOptions.style === 'string'
                    ? sampleOptions.style
                    : directive?.style
                      ? directive.style
                      : 'line';
            const color = typeof sampleOptions.color === 'string' ? sampleOptions.color : '#f4b942';
            const values = normalizedPoints.map((point) => point.value);
            const min = Math.min(...values);
            const max = Math.max(...values);
            if (/^#\d+$/.test(title.trim()) && min === max) {
                return null;
            }
            const pane: PlotPane =
                indicatorDirective?.overlay === false
                    ? 'oscillator'
                    : style === 'histogram' ||
                        style === 'columns' ||
                        min < priceMin - priceRange * 0.35 ||
                        max > priceMax + priceRange * 0.35
                      ? 'oscillator'
                      : 'overlay';

            return {
                id: title,
                title,
                color,
                style,
                pane,
                data: normalizedPoints,
            };
        })
        .filter((item): item is PinePlotSeries => item != null);
}

export function normalizeLineDrawings(rawPlots: Record<string, RawPlot>): PineLineDrawing[] {
    const rawLineSnapshots = rawPlots.__lines__?.data ?? [];
    const lineMap = new Map<number, PineLineDrawing>();

    for (const snapshot of rawLineSnapshots) {
        const drawings = Array.isArray(snapshot?.value) ? snapshot.value : [];
        for (const drawing of drawings) {
            if (!drawing || typeof drawing !== 'object') continue;
            const raw = drawing as Record<string, unknown>;
            const id = Number(raw.id);
            if (!Number.isFinite(id)) continue;
            if (raw._deleted === true) {
                lineMap.delete(id);
                continue;
            }

            lineMap.set(id, {
                id,
                x1: Number(raw.x1),
                y1: Number(raw.y1),
                x2: Number(raw.x2),
                y2: Number(raw.y2),
                xloc: typeof raw.xloc === 'string' ? raw.xloc : 'bi',
                extend: typeof raw.extend === 'string' ? raw.extend : 'none',
                color: typeof raw.color === 'string' && raw.color ? raw.color : '#5AB1BB',
                style: typeof raw.style === 'string' ? raw.style : 'style_solid',
                width: Number.isFinite(Number(raw.width)) ? Number(raw.width) : 1,
                forceOverlay: raw.force_overlay === true,
            });
        }
    }

    return [...lineMap.values()];
}

export function normalizeShapeMarkers(
    rawPlots: Record<string, RawPlot>,
    indicatorDirective?: IndicatorDirective,
): PineShapeMarker[] {
    const pane: PlotPane = indicatorDirective?.overlay === false ? 'oscillator' : 'overlay';

    return Object.entries(rawPlots)
        .filter(([key]) => !key.startsWith('__'))
        .flatMap(([title, plot]) =>
            (plot.data ?? [])
                .filter(
                    (point) =>
                        point?.value === true &&
                        Number.isFinite(point?.time) &&
                        typeof point.options?.shape === 'string',
                )
                .map((point, index) => {
                    const options = point.options ?? {};
                    return {
                        id: `${title}-${Number(point.time)}-${index}`,
                        title,
                        time: Number(point.time),
                        color: typeof options.color === 'string' ? options.color : '#f4b942',
                        text: typeof options.text === 'string' && options.text ? options.text : title.slice(0, 1),
                        shape: typeof options.shape === 'string' ? options.shape : 'shape_label_up',
                        location: typeof options.location === 'string' ? options.location : 'Top',
                        size: typeof options.size === 'string' ? options.size : 'small',
                        pane,
                    };
                }),
        );
}

export async function loadMarketData(options: Omit<RunAnalysisOptions, 'pineCode'>): Promise<LoadedMarketData> {
    const source = normalizeSource(options.source);
    const timeframe = normalizeTimeframe(source, options.timeframe);
    const limit = clampLimit(options.limit);
    const baseDir = options.baseDir ?? RENDERER_BASE_DIR;

    if (source === 'finra') {
        const symbol = options.symbol.trim().toUpperCase();
        const candles = await fetchFinraCandles(baseDir, symbol, timeframe as 'D' | 'W' | 'M', limit);
        invariant(candles.length > 20, `Not enough FINRA data returned for ${symbol}.`);
        return {
            source,
            symbol,
            timeframe,
            limit,
            candles: sortCandlesAscending(candles),
        };
    }

    if (source === 'binance') {
        const symbol = normalizeBinanceSymbol(options.symbol);
        const pine = new PineTS(Provider.Binance, symbol, timeframe, limit);
        const context = await pine.run(`//@version=6
indicator("Price Only", overlay=true)
`);
        const candles = sortCandlesAscending((context.marketData as Candle[]) ?? []);
        invariant(candles.length > 30, `Not enough candle data returned for ${symbol}.`);
        return {
            source,
            symbol,
            timeframe,
            limit,
            candles,
        };
    }

    const symbol = normalizeYahooSymbol(options.symbol);
    const candles = await fetchYahooCandles(symbol, timeframe, limit);
    invariant(candles.length > 30, `Not enough candle data returned for ${symbol}.`);
    return {
        source,
        symbol,
        timeframe,
        limit,
        candles: sortCandlesAscending(candles),
    };
}

function patchSecurity(
    pine: PineTS,
    options: PinePatchOptions,
) {
    ensurePineContextPatchInstalled();
    (pine as PineTS & { __financialBotPatchOptions?: PinePatchOptions }).__financialBotPatchOptions = options;
    pine.source = options.source === 'binance' ? new PineTS(Provider.Binance, options.symbol, options.timeframe, options.limit).source : pine.source;
    if (pine.source && typeof pine.source === 'object') {
        PINE_PATCH_OPTIONS_BY_SOURCE.set(pine.source as object, options);
    }
    pine.tickerId = options.symbol;
    pine.timeframe = options.timeframe;
    pine.limit = options.limit;
    pine.sDate = candlesStart(pine.data);
    pine.eDate = candlesEnd(pine.data);
}

function ensurePineContextPatchInstalled() {
    const prototype = PineTS.prototype as PineTS & {
        _initializeContext: (code: unknown, inputs?: Record<string, unknown>, isSecondary?: boolean) => any;
        __financialBotPatchOptions?: PinePatchOptions;
        [PINE_PROTOTYPE_PATCHED]?: boolean;
    };

    if (prototype[PINE_PROTOTYPE_PATCHED]) {
        return;
    }

    const originalInitializeContext = prototype._initializeContext;
    prototype._initializeContext = function patchedInitializeContext(code, inputs = {}, isSecondary = false) {
        const context = originalInitializeContext.call(this, code, inputs, isSecondary);
        const options =
            (this as PineTS & { __financialBotPatchOptions?: PinePatchOptions }).__financialBotPatchOptions ??
            (((this as PineTS & { source?: unknown }).source &&
                typeof (this as PineTS & { source?: unknown }).source === 'object'
                ? PINE_PATCH_OPTIONS_BY_SOURCE.get((this as PineTS & { source?: object }).source as object)
                : undefined) as PinePatchOptions | undefined) ??
            (context?.__financialBotPatchOptions as PinePatchOptions | undefined) ??
            (context?.fullContext?.__financialBotPatchOptions as PinePatchOptions | undefined) ??
            null;

        if (options) {
            context.__financialBotPatchOptions = options;
            decoratePineContext(context, options);
        }

        return context;
    };

    prototype[PINE_PROTOTYPE_PATCHED] = true;
}

function decoratePineContext(context: any, options: PinePatchOptions) {
    if (context[PINE_CONTEXT_PATCHED]) {
        return;
    }

    context[PINE_CONTEXT_PATCHED] = true;
    context.__financialBotPatchOptions = options;

    const fallbackSecurity = context.pine.request.security;
    const finraCache = options.sharedFinraCache ?? new Map<string, Promise<Candle[]>>();
    const lowerTfCandleCache = options.sharedLowerTfCandleCache ?? new Map<string, Promise<Candle[]>>();
    const fieldCache = new Map<string, LowerTfExpressionSpec>();
    const alignedFinraSeriesCache = new Map<string, number[]>();
    const alignedFinancialSeriesCache = new Map<string, number[]>();
    const splitSeriesCache = new Map<'numerator' | 'denominator', number[]>();
    const fallbackIndicator = typeof context.pine.indicator === 'function' ? context.pine.indicator.bind(context.pine) : null;

    if (fallbackIndicator && typeof context.pine.strategy !== 'function') {
        context.pine.strategy = (...args: unknown[]) => fallbackIndicator(...args);
    }

    const rawTickerId =
        typeof context.tickerId === 'string' && context.tickerId.length > 0 ? context.tickerId : options.symbol;
    const existingPineSyminfo = (context.pine?.syminfo as Record<string, unknown> | undefined) ?? {};
    const existingSyminfo = (context.syminfo as Record<string, unknown> | undefined) ?? {};
    const primaryTicker = normalizeYahooLookupSymbol(options.symbol);
    const primaryFinraTicker = `FINRA:${primaryTicker}_SHORT_VOLUME`;
    const normalizedRawTicker = normalizeYahooLookupSymbol(rawTickerId.replace(/^[A-Z]+:/, ''));
    const isPrimaryTicker = rawTickerId === options.symbol || normalizedRawTicker === primaryTicker;
    const primaryCandles = options.primaryCandles ?? context.marketData ?? [];
    const primaryOpenTimes = primaryCandles.map((candle: Candle) => candle.openTime);
    const primaryCloseTimes = primaryCandles.map((candle: Candle) => candle.closeTime);
    const primaryIndexByOpenTime = buildPrimaryIndexByOpenTime(primaryOpenTimes);
    const syminfo = {
        ...existingPineSyminfo,
        ...existingSyminfo,
        ticker: rawTickerId.includes(':') ? rawTickerId.split(':').slice(1).join(':') : normalizedRawTicker,
        tickerid: rawTickerId,
        type:
            isPrimaryTicker
                ? options.primaryYahooSnapshot?.syminfoType ?? (existingPineSyminfo.type ?? 'stock')
                : (existingPineSyminfo.type ?? existingSyminfo.type ?? 'stock'),
    };

    context.syminfo = {
        ...syminfo,
    };
    context.pine.syminfo = syminfo;

    context.pine.request.financial = (...args: unknown[]) => {
        const symbolArg = extractSecurityArg(args[0]);
        const metricArg = extractSecurityArg(args[1]);
        if (typeof symbolArg !== 'string' || typeof metricArg !== 'string') {
            return Number.NaN;
        }

        const normalized = normalizeYahooLookupSymbol(symbolArg);
        const snapshot = normalized === primaryTicker ? options.primaryYahooSnapshot : null;
        if (!snapshot) {
            context.warn('request.financial currently supports the active chart symbol only.', 'request.financial');
            return Number.NaN;
        }

        const metric = metricArg.toUpperCase();
        const periodArg = extractSecurityArg(args[2]);
        const period =
            typeof periodArg === 'string' && ['D', 'FQ', 'FH', 'FY'].includes(periodArg.toUpperCase())
                ? (periodArg.toUpperCase() as YahooFinancialPeriod)
                : 'FQ';

        if (metric === 'TOTAL_SHARES_OUTSTANDING') {
            return snapshot.sharesOutstanding ?? Number.NaN;
        }

        if (
            metric === 'AUM' ||
            metric === 'NAV' ||
            metric === 'NAV_ALL' ||
            metric === 'TOTAL_ASSETS' ||
            metric === 'TOTAL_EQUITY' ||
            metric === 'RETURN_ON_ASSETS' ||
            metric === 'RETURN_ON_EQUITY' ||
            metric === 'RETURN_ON_TANG_EQUITY'
        ) {
            const catalog = options.primaryYahooFinancials;
            if (!catalog) return Number.NaN;
            const points = catalog[metric as YahooFinancialMetric]?.[period] ?? [];
            const cacheKey = `${metric}:${period}`;
            if (!alignedFinancialSeriesCache.has(cacheKey)) {
                alignedFinancialSeriesCache.set(cacheKey, buildAlignedFinancialSeries(primaryOpenTimes, points));
            }
            const currentIndex = primaryIndexByOpenTime.get(context.data.openTime.get(0));
            return currentIndex == null ? Number.NaN : alignedFinancialSeriesCache.get(cacheKey)![currentIndex];
        }

        context.warn(`Unsupported request.financial metric: ${metricArg}.`, 'request.financial');
        return Number.NaN;
    };

    context.pine.request.splits = (...args: unknown[]) => {
        const symbolArg = extractSecurityArg(args[0]);
        const splitFieldArg = extractSecurityArg(args[1]);
        if (typeof symbolArg !== 'string' || typeof splitFieldArg !== 'string') {
            return Number.NaN;
        }

        const splitField =
            splitFieldArg === context.pine.splits?.numerator || splitFieldArg === 'splits_numerator'
                ? 'numerator'
                : splitFieldArg === context.pine.splits?.denominator || splitFieldArg === 'splits_denominator'
                  ? 'denominator'
                  : null;
        if (!splitField) {
            context.warn('Unsupported request.splits field. Use splits.numerator or splits.denominator.', 'request.splits');
            return Number.NaN;
        }

        const normalized = normalizeYahooLookupSymbol(symbolArg);
        const splits = normalized === primaryTicker ? options.primaryYahooSplits ?? [] : [];
        if (normalized !== primaryTicker) {
            context.warn('request.splits currently supports the active chart symbol only.', 'request.splits');
            return Number.NaN;
        }
        if (!splitSeriesCache.has(splitField)) {
            splitSeriesCache.set(splitField, buildSplitValueSeries(context.marketData ?? [], splits, splitField));
        }
        const currentIndex = primaryIndexByOpenTime.get(context.data.openTime.get(0));
        return currentIndex == null ? Number.NaN : splitSeriesCache.get(splitField)![currentIndex];
    };

    context.pine.request.security = (...args: unknown[]) => {
        const symbolArg = extractSecurityArg(args[0]);
        if (typeof symbolArg !== 'string' || !symbolArg.toUpperCase().startsWith('FINRA:')) {
            if (options.source === 'binance' && typeof fallbackSecurity === 'function') {
                return fallbackSecurity(...(args as never[]));
            }
            return Number.NaN;
        }

        const timeframeArg = extractSecurityArg(args[1]);
        const timeframe = normalizeTimeframe('finra', typeof timeframeArg === 'string' ? timeframeArg : 'D') as 'D' | 'W' | 'M';
        const expressionArg = Array.isArray(args[2]) ? args[2][0] : args[2];
        const paramId = Array.isArray(args[2]) && typeof args[2][1] === 'string' ? args[2][1] : null;
        let field =
            resolveFinraFieldName(expressionArg, context.data) ??
            (paramId ? fieldCache.get(paramId) ?? null : null) ??
            (paramId ? inferFinraFieldFromParam(context.params?.[paramId], context.data as Record<string, { data?: unknown[] }>) : null);

        if (paramId && field) {
            fieldCache.set(paramId, field);
        }

        if (!field) {
            context.warn('Unsupported FINRA request.security expression. Use open/high/low/close/volume.', 'request.security');
            return Number.NaN;
        }

        const cacheKey = `${symbolArg}:${timeframe}`;
        const canUsePrimaryFinraSeries =
            symbolArg.toUpperCase() === primaryFinraTicker.toUpperCase() &&
            timeframe === options.primaryFinraTimeframe &&
            Array.isArray(options.primaryFinraCandles) &&
            options.primaryFinraCandles.length > 0;

        if (!canUsePrimaryFinraSeries) {
            context.warn(
                'Local renderer currently supports FINRA request.security for the active chart symbol/timeframe only.',
                'request.security',
            );
            return Number.NaN;
        }

        const secondaryCandles = options.primaryFinraCandles ?? [];
        const alignedCacheKey = `${cacheKey}:${field}`;
        if (!alignedFinraSeriesCache.has(alignedCacheKey)) {
            alignedFinraSeriesCache.set(
                alignedCacheKey,
                buildAlignedSecondarySeries(primaryOpenTimes, primaryCloseTimes, secondaryCandles, field),
            );
        }
        const currentOpenTime = context.data.openTime.get(0);
        const currentIndex = primaryIndexByOpenTime.get(currentOpenTime);
        if (currentIndex == null) return Number.NaN;
        return alignedFinraSeriesCache.get(alignedCacheKey)![currentIndex];
    };

    context.pine.request.security_lower_tf = async (...args: unknown[]) => {
        const symbolArgRaw = extractSecurityArg(args[0]);
        const timeframeArgRaw = extractSecurityArg(args[1]);
        const expressionArg = Array.isArray(args[2]) ? args[2][0] : args[2];
        const paramId = Array.isArray(args[2]) && typeof args[2][1] === 'string' ? args[2][1] : null;
        const ignoreInvalidSymbol = Boolean(extractSecurityArg(args[3]));

        if (context.isSecondaryContext) {
            return createPineArrayLike(context, [expressionArg]);
        }

        const symbolArg = typeof symbolArgRaw === 'string' && symbolArgRaw.length > 0 ? symbolArgRaw : context.tickerId;
        const requestedTimeframe = normalizeRequestedTimeframe(typeof timeframeArgRaw === 'string' ? timeframeArgRaw : 'D');
        const spec = resolveLowerTfExpressionSpec(context, symbolArg, expressionArg, paramId, fieldCache, options);

        if (!spec) {
            context.warn('Unsupported request.security_lower_tf expression in local renderer.', 'request.security_lower_tf');
            return createPineArrayLike(context, []);
        }

        const cacheKey = `${symbolArg}:${requestedTimeframe}`;
        if (!lowerTfCandleCache.has(cacheKey)) {
            lowerTfCandleCache.set(cacheKey, fetchLowerTfCandles(options, symbolArg, requestedTimeframe, context.marketData?.length ?? options.limit));
        }

        let lowerCandles: Candle[] = [];
        try {
            lowerCandles = await lowerTfCandleCache.get(cacheKey)!;
        } catch (error) {
            if (!ignoreInvalidSymbol) throw error;
            return createPineArrayLike(context, []);
        }

        const lowerValues = buildLowerTfValues(lowerCandles, spec, options);
        const myOpenTime = context.data.openTime.get(0);
        const myCloseTime = context.data.closeTime.get(0);
        const result: number[] = [];

        for (let index = 0; index < lowerCandles.length; index += 1) {
            const candle = lowerCandles[index];
            if (candle.closeTime <= myOpenTime) continue;
            if (candle.openTime >= myCloseTime) break;
            if (candle.openTime >= myOpenTime && candle.openTime < myCloseTime) {
                result.push(lowerValues[index]);
            }
        }

        return createPineArrayLike(context, result);
    };
}

function extractSecurityArg(value: unknown) {
    if (Array.isArray(value)) value = value[0];
    if (value && typeof value === 'object' && 'get' in value && typeof (value as { get: (index: number) => unknown }).get === 'function') {
        return (value as { get: (index: number) => unknown }).get(0);
    }
    return value;
}

function buildPrimaryIndexByOpenTime(openTimes: number[]) {
    const indexByOpenTime = new Map<number, number>();
    for (let index = 0; index < openTimes.length; index += 1) {
        indexByOpenTime.set(openTimes[index], index);
    }
    return indexByOpenTime;
}

function buildAlignedFinancialSeries(openTimes: number[], points: YahooFinancialPoint[]) {
    const result = new Array<number>(openTimes.length).fill(Number.NaN);
    let pointIndex = 0;
    let lastValue = Number.NaN;

    for (let index = 0; index < openTimes.length; index += 1) {
        const openTime = openTimes[index];
        while (pointIndex < points.length && points[pointIndex].time <= openTime) {
            lastValue = points[pointIndex].value;
            pointIndex += 1;
        }
        result[index] = lastValue;
    }

    return result;
}

function buildSplitValueSeries(candles: Candle[], splits: YahooSplitEvent[] | undefined, field: 'numerator' | 'denominator') {
    const result = new Array<number>(candles.length).fill(Number.NaN);
    if (!splits || splits.length === 0 || candles.length === 0) {
        return result;
    }

    const sortedSplits = [...splits].sort((left, right) => left.time - right.time);
    let splitIndex = 0;
    for (let candleIndex = 0; candleIndex < candles.length; candleIndex += 1) {
        const candle = candles[candleIndex];
        while (splitIndex < sortedSplits.length && sortedSplits[splitIndex].time < candle.openTime) {
            splitIndex += 1;
        }
        const split = sortedSplits[splitIndex];
        if (split && candle.openTime <= split.time && split.time < candle.closeTime) {
            result[candleIndex] = split[field];
        }
    }

    return result;
}

function buildAlignedSecondarySeries(
    primaryOpenTimes: number[],
    primaryCloseTimes: number[],
    secondaryCandles: Candle[],
    field: 'open' | 'high' | 'low' | 'close' | 'volume',
) {
    const result = new Array<number>(primaryOpenTimes.length).fill(Number.NaN);
    if (primaryOpenTimes.length === 0 || secondaryCandles.length === 0) {
        return result;
    }

    let secondaryIndex = -1;
    for (let index = 0; index < primaryOpenTimes.length; index += 1) {
        const primaryOpenTime = primaryOpenTimes[index];
        const primaryCloseTime = primaryCloseTimes[index];

        while (
            secondaryIndex + 1 < secondaryCandles.length &&
            secondaryCandles[secondaryIndex + 1].openTime <= primaryOpenTime
        ) {
            secondaryIndex += 1;
        }

        if (secondaryIndex < 0) continue;
        const candle = secondaryCandles[secondaryIndex];
        if (
            (candle.openTime <= primaryOpenTime && primaryOpenTime < candle.closeTime) ||
            (candle.closeTime <= primaryCloseTime && candle.openTime <= primaryOpenTime)
        ) {
            result[index] = candle[field];
        }
    }

    return result;
}

function normalizeRequestedTimeframe(timeframe: string) {
    const normalized = timeframe.trim().toUpperCase();
    if (normalized === '1D') return 'D';
    if (normalized === '1W') return 'W';
    if (normalized === '1M') return 'M';
    if (normalized === '1H') return '60';
    return normalized;
}

function getContextSeriesData(context: any, field: LowerTfField) {
    const source = context.data?.[field];
    return Array.isArray(source?.data) ? source.data : [];
}

function getContextNumericSeries(context: any, key: string) {
    const source = context.data?.[key];
    return Array.isArray(source?.data) ? source.data : [];
}

function valuesMatch(left: unknown, right: unknown) {
    if (Number.isNaN(left) && Number.isNaN(right)) return true;
    if (typeof left === 'number' && typeof right === 'number') {
        return Math.abs(left - right) <= 1e-8 * Math.max(1, Math.abs(left), Math.abs(right));
    }
    return left === right;
}

function sampleSeriesMatches(candidate: unknown[], sample: unknown[] | undefined) {
    if (!Array.isArray(sample) || sample.length === 0 || candidate.length === 0) return false;
    const sampleSize = Math.min(sample.length, candidate.length, 8);
    if (sampleSize === 0) return false;

    for (let index = 0; index < sampleSize; index += 1) {
        if (!valuesMatch(candidate[index], sample[index])) {
            return false;
        }
    }

    return true;
}

function buildContextDenominatorSeries(context: any, options: PinePatchOptions, priceField: LowerTfField) {
    const openTimes = getContextNumericSeries(context, 'openTime');
    const priceSeries = getContextSeriesData(context, priceField);
    if ((options.primaryYahooSnapshot?.syminfoType ?? 'stock') === 'fund') {
        const points = options.primaryYahooFinancials?.AUM?.D ?? [];
        return buildAlignedFinancialSeries(openTimes, points);
    }

    const sharesOutstanding = options.primaryYahooSnapshot?.sharesOutstanding;
    if (!Number.isFinite(sharesOutstanding)) {
        return openTimes.map(() => Number.NaN);
    }

    return priceSeries.map((price: number) => (Number.isFinite(price) ? sharesOutstanding * price : Number.NaN));
}

function buildCumulativeAdjustmentSeriesFromCandles(candles: Candle[], splits: YahooSplitEvent[] | undefined, enabled: boolean) {
    if (!enabled) {
        return candles.map(() => 1);
    }

    let cumulativeAdjustment = 1;
    const sortedSplits = [...(splits ?? [])].sort((left, right) => left.time - right.time);
    let splitIndex = 0;
    return candles.map((candle) => {
        while (splitIndex < sortedSplits.length && sortedSplits[splitIndex].time < candle.openTime) {
            splitIndex += 1;
        }
        const hasSplit = sortedSplits[splitIndex];
        if (hasSplit && hasSplit.numerator !== 0 && candle.openTime <= hasSplit.time && hasSplit.time < candle.closeTime) {
            cumulativeAdjustment *= hasSplit.denominator / hasSplit.numerator;
        }
        return cumulativeAdjustment;
    });
}

function resolveLowerTfExpressionSpec(
    context: any,
    symbolArg: string,
    expressionArg: unknown,
    paramId: string | null,
    fieldCache: Map<string, LowerTfExpressionSpec>,
    options: PinePatchOptions,
): LowerTfExpressionSpec | null {
    if (paramId && fieldCache.has(paramId)) {
        return fieldCache.get(paramId) ?? null;
    }

    const paramValues = paramId ? context.params?.[paramId] : undefined;
    const rawField =
        resolveFinraFieldName(expressionArg, context.data) ??
        inferExtendedFieldFromParam(paramValues, context);

    if (rawField) {
        const spec: LowerTfExpressionSpec = { kind: 'field', field: rawField };
        if (paramId) fieldCache.set(paramId, spec);
        return spec;
    }

    if (!symbolArg.toUpperCase().startsWith('FINRA:')) {
        for (const priceField of LOWER_TF_PRICE_FIELDS) {
            const denomSeries = buildContextDenominatorSeries(context, options, priceField);
            if (sampleSeriesMatches(denomSeries, paramValues)) {
                const spec: LowerTfExpressionSpec = { kind: 'denom', priceField };
                if (paramId) fieldCache.set(paramId, spec);
                return spec;
            }
        }

        const disabledCumAdj = buildCumulativeAdjustmentSeriesFromCandles(context.marketData ?? [], options.primaryYahooSplits, false);
        if (sampleSeriesMatches(disabledCumAdj, paramValues)) {
            const spec: LowerTfExpressionSpec = { kind: 'cumAdj', enabled: false };
            if (paramId) fieldCache.set(paramId, spec);
            return spec;
        }

        const enabledCumAdj = buildCumulativeAdjustmentSeriesFromCandles(context.marketData ?? [], options.primaryYahooSplits, true);
        if (sampleSeriesMatches(enabledCumAdj, paramValues)) {
            const spec: LowerTfExpressionSpec = { kind: 'cumAdj', enabled: true };
            if (paramId) fieldCache.set(paramId, spec);
            return spec;
        }
    }

    return null;
}

function inferExtendedFieldFromParam(paramValues: unknown[] | undefined, context: any): LowerTfField | null {
    for (const field of LOWER_TF_ALL_FIELDS) {
        if (sampleSeriesMatches(getContextSeriesData(context, field), paramValues)) {
            return field;
        }
    }
    return null;
}

async function fetchLowerTfCandles(options: PinePatchOptions, symbolArg: string, timeframe: string, currentBarCount: number) {
    const normalizedTimeframe = normalizeRequestedTimeframe(timeframe);
    const limit = Math.min(2000, Math.max(currentBarCount * 8, options.limit * 8, 400));

    if (symbolArg.toUpperCase().startsWith('FINRA:')) {
        const finraTimeframe = normalizeTimeframe('finra', normalizedTimeframe) as 'D' | 'W' | 'M';
        return fetchFinraCandles(options.baseDir, symbolArg, finraTimeframe, limit);
    }

    if (options.source === 'yahoo' || options.source === 'finra') {
        const yahooTimeframe = normalizeTimeframe('yahoo', normalizedTimeframe);
        return fetchYahooCandles(normalizeYahooLookupSymbol(symbolArg), yahooTimeframe, limit);
    }

    if (options.source === 'binance') {
        const pine = new PineTS(Provider.Binance, symbolArg, normalizedTimeframe, limit);
        const context = await pine.run(`//@version=6
indicator("Lower TF Fetch", overlay=true)
`);
        return sortCandlesAscending((context.marketData as Candle[]) ?? []);
    }

    return [];
}

function valueFromCandle(candle: Candle, field: LowerTfField) {
    if (field === 'hl2') return (candle.high + candle.low) / 2;
    if (field === 'hlc3') return (candle.high + candle.low + candle.close) / 3;
    if (field === 'ohlc4') return (candle.open + candle.high + candle.low + candle.close) / 4;
    return candle[field];
}

function buildLowerTfValues(candles: Candle[], spec: LowerTfExpressionSpec, options: PinePatchOptions) {
    if (spec.kind === 'field') {
        return candles.map((candle) => valueFromCandle(candle, spec.field));
    }

    if (spec.kind === 'cumAdj') {
        return buildCumulativeAdjustmentSeriesFromCandles(candles, options.primaryYahooSplits, spec.enabled);
    }

    if ((options.primaryYahooSnapshot?.syminfoType ?? 'stock') === 'fund') {
        const points = options.primaryYahooFinancials?.AUM?.D ?? [];
        return buildAlignedFinancialSeries(
            candles.map((candle) => candle.openTime),
            points,
        );
    }

    const sharesOutstanding = options.primaryYahooSnapshot?.sharesOutstanding;
    return candles.map((candle) => {
        const price = valueFromCandle(candle, spec.priceField);
        return Number.isFinite(sharesOutstanding) && Number.isFinite(price) ? sharesOutstanding * price : Number.NaN;
    });
}

function createPineArrayLike(context: any, values: unknown[]) {
    return {
        array: values,
        size: () => values.length,
        get: (index: number) => {
            const resolvedIndex = index < 0 ? values.length + index : index;
            if (resolvedIndex < 0 || resolvedIndex >= values.length) {
                context.warn(`Index ${resolvedIndex} is out of bounds, array size is ${values.length}.`, 'array.get');
                return Number.NaN;
            }
            return values[resolvedIndex];
        },
        [Symbol.iterator]: function* iterator() {
            yield* values;
        },
    };
}

function candlesStart(candles: Candle[]) {
    return candles.length > 0 ? candles[0].openTime : undefined;
}

function candlesEnd(candles: Candle[]) {
    return candles.length > 0 ? candles[candles.length - 1].closeTime : undefined;
}

export async function runPineOnCandles(
    candles: Candle[],
    pineCode: string,
    options?: {
        source?: DataSource;
        symbol?: string;
        timeframe?: string;
        limit?: number;
        baseDir?: string;
        primaryYahooSnapshot?: YahooSymbolSnapshot | null;
        primaryYahooSplits?: YahooSplitEvent[];
        primaryYahooFinancials?: YahooFinancialCatalog | null;
        primaryFinraCandles?: Candle[];
        primaryFinraTimeframe?: 'D' | 'W' | 'M' | null;
        sharedFinraCache?: Map<string, Promise<Candle[]>>;
        sharedLowerTfCandleCache?: Map<string, Promise<Candle[]>>;
    },
) {
    const normalizedCandles = sortCandlesAscending(candles);
    const code = pineCode?.trim();
    invariant(code, 'Pine code is required.');
    const primaryYahooSnapshot =
        options?.primaryYahooSnapshot !== undefined
            ? options.primaryYahooSnapshot
            : options?.source && options.source !== 'binance' && options?.symbol
              ? await fetchYahooSymbolSnapshot(options?.baseDir ?? process.cwd(), options.symbol)
              : null;
    const primaryYahooSplits =
        options?.primaryYahooSplits !== undefined
            ? options.primaryYahooSplits
            : options?.source && options.source !== 'binance' && options?.symbol
              ? await fetchYahooSplits(options?.baseDir ?? process.cwd(), options.symbol)
              : [];
    const primaryYahooFinancials =
        options?.primaryYahooFinancials !== undefined
            ? options.primaryYahooFinancials
            : options?.source && options.source !== 'binance' && options?.symbol
              ? await fetchYahooFinancialCatalog(options?.baseDir ?? process.cwd(), options.symbol)
              : null;
    const normalizedPrimaryFinraTimeframe =
        options?.primaryFinraTimeframe ??
        (options?.timeframe && ['D', 'W', 'M'].includes(options.timeframe.toUpperCase())
            ? (options.timeframe.toUpperCase() as 'D' | 'W' | 'M')
            : null);
    const primaryFinraCandles =
        options?.primaryFinraCandles !== undefined
            ? options.primaryFinraCandles
            : options?.symbol && normalizedPrimaryFinraTimeframe
              ? await fetchFinraCandles(
                    options?.baseDir ?? process.cwd(),
                    `FINRA:${normalizeYahooLookupSymbol(options.symbol)}_SHORT_VOLUME`,
                    normalizedPrimaryFinraTimeframe,
                    Math.max(options?.limit ?? normalizedCandles.length, normalizedCandles.length),
                )
              : [];
    const pine = new PineTS(normalizedCandles);
    patchSecurity(pine, {
        source: options?.source ?? 'yahoo',
        symbol: options?.symbol ?? '',
        timeframe: options?.timeframe ?? 'D',
        limit: options?.limit ?? normalizedCandles.length,
        baseDir: options?.baseDir ?? process.cwd(),
        primaryCandles: normalizedCandles,
        primaryYahooSnapshot,
        primaryYahooSplits,
        primaryYahooFinancials,
        primaryFinraCandles,
        primaryFinraTimeframe: normalizedPrimaryFinraTimeframe,
        sharedFinraCache: options?.sharedFinraCache,
        sharedLowerTfCandleCache: options?.sharedLowerTfCandleCache,
    });
    const context = await pine.run(code);
    const plotDirectives = extractPlotDirectives(code);
    const indicatorDirective = extractIndicatorDirective(code);
    const warnings = (context.warnings ?? []).map((warning) => {
        if (typeof warning === 'string') return warning;
        if (warning && typeof warning === 'object' && 'message' in warning) {
            return String((warning as { message?: unknown }).message ?? '');
        }
        return String(warning);
    });

    return {
        candles: normalizedCandles,
        series: normalizePlotData(context.plots ?? {}, normalizedCandles, plotDirectives, indicatorDirective),
        lines: normalizeLineDrawings(context.plots ?? {}),
        markers: normalizeShapeMarkers(context.plots ?? {}, indicatorDirective),
        warnings,
    };
}

export async function loadPrimaryPineResources(
    options: {
        source?: DataSource;
        symbol?: string;
        baseDir?: string;
        timeframe?: string;
        limit?: number;
        loadOptions?: PinePrimaryResourceLoadOptions;
    },
): Promise<PinePrimaryResources> {
    if (!options?.source || options.source === 'binance' || !options?.symbol) {
        return {
            primaryYahooSnapshot: null,
            primaryYahooSplits: [],
            primaryYahooFinancials: null,
            primaryFinraCandles: [],
            primaryFinraTimeframe: null,
            warnings: [],
        };
    }

    const baseDir = options.baseDir ?? process.cwd();
    const loadOptions = options.loadOptions ?? {};
    const includeYahooSnapshot = loadOptions.includeYahooSnapshot ?? true;
    const includeYahooSplits = loadOptions.includeYahooSplits ?? true;
    const includeYahooFinancials = loadOptions.includeYahooFinancials ?? true;
    const includeFinraCandles = loadOptions.includeFinraCandles ?? true;
    const tolerateYahooSplitFailures = loadOptions.tolerateYahooSplitFailures ?? false;
    const warnings: string[] = [];
    const primaryFinraTimeframe =
        options?.timeframe && ['D', 'W', 'M'].includes(options.timeframe.toUpperCase())
            ? (options.timeframe.toUpperCase() as 'D' | 'W' | 'M')
            : null;
    const primaryYahooSnapshotPromise = includeYahooSnapshot
        ? fetchYahooSymbolSnapshot(baseDir, options.symbol)
        : Promise.resolve(null);
    const primaryYahooSplitsPromise = includeYahooSplits
        ? fetchYahooSplits(baseDir, options.symbol).catch((error) => {
              if (!tolerateYahooSplitFailures) {
                  throw error;
              }
              warnings.push(
                  `Yahoo splits unavailable for ${options.symbol}: ${error instanceof Error ? error.message : String(error)}`,
              );
              return [];
          })
        : Promise.resolve([]);
    const primaryYahooFinancialsPromise = includeYahooFinancials
        ? fetchYahooFinancialCatalog(baseDir, options.symbol)
        : Promise.resolve(null);
    const primaryFinraCandlesPromise =
        includeFinraCandles && primaryFinraTimeframe
            ? fetchFinraCandles(
                  baseDir,
                  `FINRA:${normalizeYahooLookupSymbol(options.symbol)}_SHORT_VOLUME`,
                  primaryFinraTimeframe,
                  Math.max(options.limit ?? 300, 300),
              )
            : Promise.resolve([]);
    const [primaryYahooSnapshot, primaryYahooSplits, primaryYahooFinancials, primaryFinraCandles] = await Promise.all([
        primaryYahooSnapshotPromise,
        primaryYahooSplitsPromise,
        primaryYahooFinancialsPromise,
        primaryFinraCandlesPromise,
    ]);

    return {
        primaryYahooSnapshot,
        primaryYahooSplits,
        primaryYahooFinancials,
        primaryFinraCandles,
        primaryFinraTimeframe,
        warnings,
    };
}

export async function runPineAnalysis(options: RunAnalysisOptions): Promise<RunAnalysisResult> {
    const pineCode = options.pineCode?.trim();
    invariant(pineCode, 'Pine code is required.');
    const market = await loadMarketData(options);
    const result = await runPineOnCandles(market.candles, pineCode, {
        source: market.source,
        symbol: market.symbol,
        timeframe: market.timeframe,
        limit: market.limit,
        baseDir: options.baseDir ?? RENDERER_BASE_DIR,
    });

    return {
        source: market.source,
        symbol: market.symbol,
        timeframe: market.timeframe,
        limit: market.limit,
        candles: result.candles,
        series: result.series,
        lines: result.lines,
        markers: result.markers,
        warnings: result.warnings,
    };
}
