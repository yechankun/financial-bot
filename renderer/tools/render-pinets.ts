import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Resvg } from '@resvg/resvg-js';

import { normalizeId, readCustomScriptCode, readRegistry } from '../lib/pinets-registry';
import { loadIndicatorPresetCode } from '../lib/preset-loader';
import {
    type Candle,
    type PinePrimaryResourceLoadOptions,
    type PineLineDrawing,
    type PinePlotPoint,
    type PinePlotSeries,
    type PineShapeMarker,
    type PlotPane,
    loadPrimaryPineResources,
    loadMarketData,
    runPineOnCandles,
} from '../lib/pine-workbench';
import { INDICATOR_PRESETS } from '../src/presets';
import type { DataSource } from '../src/types';

type CliArgs = {
    source?: DataSource;
    symbol?: string;
    symbols?: string;
    timeframe?: string;
    timeframes?: string;
    limit?: number;
    preset?: string;
    script?: string;
    profile?: string;
    codeFile?: string;
    outDir: string;
    outRoot?: string;
    outputs?: string;
    concurrency?: number;
};

type RenderOutput = 'dataset' | 'csv' | 'png' | 'indicator' | 'meta' | 'latest';

const DEFAULT_OUTPUTS: RenderOutput[] = ['dataset', 'csv', 'png', 'indicator', 'meta'];
const VALID_OUTPUTS = new Set<RenderOutput>([...DEFAULT_OUTPUTS, 'latest']);
const DEFAULT_RENDER_WIDTH = 1400;
const PROFILE_BY_TIMEFRAME: Record<string, string> = {
    D: 'druckenmiller-default-stack',
    W: 'druckenmiller-weekly-stack',
    M: 'druckenmiller-monthly-stack',
};

type ResolvedScript = {
    kind: 'preset' | 'custom' | 'code-file';
    id: string;
    label: string;
    code: string;
    warmupBars?: number;
};

function resolvePrimaryResourceLoadOptions(
    resolved: ResolvedScripts,
    target: { source: DataSource; symbol: string; timeframe: string; limit: number },
): PinePrimaryResourceLoadOptions {
    const profileId = resolved.profile?.id ?? null;
    if (target.source === 'yahoo' && profileId === 'short-pressure-stack') {
        return {
            includeYahooSnapshot: false,
            includeYahooSplits: true,
            includeYahooFinancials: false,
            includeFinraCandles: true,
            tolerateYahooSplitFailures: true,
        };
    }

    return {
        includeYahooSnapshot: true,
        includeYahooSplits: true,
        includeYahooFinancials: true,
        includeFinraCandles: true,
        tolerateYahooSplitFailures: false,
    };
}

function invariant(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function buildUsage() {
    return `
Usage:
  bun run render -- --source yahoo --symbol EWY --timeframe D --preset ema-cross --out-dir outputs/ewy
  bun run render -- --source yahoo --symbol EWY --profile trend-stack --out-dir outputs/ewy-profile
  bun run render -- --source yahoo --symbol KORU --script my-rsi,my-macd --out-dir outputs/koru
  bun run render -- --source finra --symbol TSLA_SHORT_VOLUME --timeframe D --preset rsi --out-dir outputs/tsla-finra
  bun run render -- --source yahoo --symbol EWY --code-file ./my-indicator.pine --out-dir outputs/custom
  bun run render -- --source yahoo --symbol EWY --preset ema-cross --outputs dataset,meta --out-dir outputs/json-only
  bun run render -- --source yahoo --symbols AAPL,MSFT,NVDA --timeframes D,W --out-root outputs/batch --concurrency 4
`.trim();
}

function parseCsvList(value: string | undefined) {
    return (value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

function parseRenderOutputs(value: string | undefined) {
    const outputs = value ? parseCsvList(value) : [...DEFAULT_OUTPUTS];
    invariant(outputs.length > 0, '--outputs must include at least one output target.');
    for (const output of outputs) {
        invariant(
            VALID_OUTPUTS.has(output as RenderOutput),
            `Unsupported output target: ${output}. Valid outputs are ${DEFAULT_OUTPUTS.join(', ')}.`,
        );
    }
    return new Set(outputs as RenderOutput[]);
}

function defaultPresetForSource(source?: DataSource) {
    return source === 'finra' ? 'finra-short-volume' : INDICATOR_PRESETS[0].id;
}

function parseCli(): CliArgs {
    const parsed = parseArgs({
        options: {
            source: { type: 'string' },
            symbol: { type: 'string' },
            symbols: { type: 'string' },
            timeframe: { type: 'string' },
            timeframes: { type: 'string' },
            limit: { type: 'string' },
            preset: { type: 'string' },
            script: { type: 'string' },
            profile: { type: 'string' },
            'code-file': { type: 'string' },
            'out-dir': { type: 'string', default: 'outputs/latest' },
            'out-root': { type: 'string' },
            outputs: { type: 'string' },
            concurrency: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
        },
        allowPositionals: false,
    });

    if (parsed.values.help) {
        console.log(buildUsage());
        process.exit(0);
    }

    return {
        source:
            parsed.values.source === 'binance'
                ? 'binance'
                : parsed.values.source === 'finra'
                  ? 'finra'
                  : parsed.values.source === 'yahoo'
                    ? 'yahoo'
                    : undefined,
        symbol: parsed.values.symbol,
        symbols: parsed.values.symbols,
        timeframe: parsed.values.timeframe,
        timeframes: parsed.values.timeframes,
        limit: parsed.values.limit ? Number(parsed.values.limit) : undefined,
        preset: parsed.values.preset,
        script: parsed.values.script,
        profile: parsed.values.profile,
        codeFile: parsed.values['code-file'],
        outDir: parsed.values['out-dir'],
        outRoot: parsed.values['out-root'],
        outputs: parsed.values.outputs,
        concurrency: parsed.values.concurrency ? Number(parsed.values.concurrency) : undefined,
    };
}

async function resolveScripts(baseDir: string, args: CliArgs) {
    if (args.codeFile) {
        return {
            profile: null,
            scripts: [
                {
                    kind: 'code-file' as const,
                    id: 'code-file',
                    label: path.basename(args.codeFile),
                    code: await fs.readFile(path.resolve(baseDir, args.codeFile), 'utf8'),
                    warmupBars: 0,
                },
            ],
        };
    }

    if (args.profile) {
        const registry = await readRegistry(baseDir);
        const profile = registry.profiles.find((item) => item.id === normalizeId(args.profile ?? ''));
        invariant(profile, `Chart profile not found: ${args.profile}`);

        const scripts = await Promise.all(
            profile.items.map(async (item) => {
                if (item.kind === 'preset') {
                    const preset = INDICATOR_PRESETS.find((candidate) => candidate.id === item.id);
                    invariant(preset, `Preset not found in profile '${profile.id}': ${item.id}`);
                    return {
                        kind: 'preset' as const,
                        id: preset.id,
                        label: preset.label,
                        code: await loadIndicatorPresetCode(baseDir, preset),
                        warmupBars: preset.warmupBars ?? 0,
                    };
                }

                const custom = await readCustomScriptCode(baseDir, item.id);
                return {
                    kind: 'custom' as const,
                    id: custom.record.id,
                    label: custom.record.label,
                    code: custom.code,
                    warmupBars: 0,
                };
            }),
        );

        return { profile, scripts };
    }

    const presetIds = parseCsvList(args.preset);
    const scriptIds = parseCsvList(args.script);

    const presets = presetIds.length > 0 ? presetIds : scriptIds.length === 0 ? [defaultPresetForSource(args.source)] : [];
    const resolvedPresets = await Promise.all(presets.map(async (id) => {
        const preset = INDICATOR_PRESETS.find((item) => item.id === id);
        invariant(preset, `Preset not found: ${id}`);
        return {
            kind: 'preset' as const,
            id: preset.id,
            label: preset.label,
            code: await loadIndicatorPresetCode(baseDir, preset),
            warmupBars: preset.warmupBars ?? 0,
        };
    }));

    const resolvedScripts = await Promise.all(
        scriptIds.map(async (id) => {
            const custom = await readCustomScriptCode(baseDir, id);
        return {
            kind: 'custom' as const,
            id: custom.record.id,
            label: custom.record.label,
            code: custom.code,
            warmupBars: 0,
        };
    }),
    );

    return {
        profile: null,
        scripts: [...resolvedPresets, ...resolvedScripts],
    };
}

function resolveRenderTarget(args: CliArgs, profileDefaults?: { source?: DataSource; symbol?: string; timeframe?: string; limit?: number }) {
    return {
        source: args.source ?? profileDefaults?.source ?? 'yahoo',
        symbol: args.symbol ?? profileDefaults?.symbol ?? 'EWY',
        timeframe: args.timeframe ?? profileDefaults?.timeframe ?? 'D',
        limit: args.limit ?? profileDefaults?.limit ?? 320,
    };
}

type ResolvedScripts = Awaited<ReturnType<typeof resolveScripts>>;
type RenderTarget = ReturnType<typeof resolveRenderTarget>;

type RenderSummary = {
    outDir: string;
    outputs: RenderOutput[];
    datasetPath: string | null;
    csvPath: string | null;
    pngPath: string | null;
    codePath: string | null;
    metaPath: string | null;
    latestPath: string | null;
    latestSeries: Record<string, number | null>;
    bars: number;
    series: string[];
    scripts: string[];
    profile: string | null;
    symbol: string;
    timeframe: string;
    source: DataSource;
};

function getLatestFiniteSeriesValue(series: PinePlotSeries) {
    const points = Array.isArray(series.data) ? series.data : [];
    for (let index = points.length - 1; index >= 0; index -= 1) {
        const value = Number(points[index]?.value);
        if (Number.isFinite(value)) {
            return value;
        }
    }
    return null;
}

const RECENT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function buildRecentWindow(visibleCandles: Candle[], mergedSeries: PinePlotSeries[]) {
    const lastOpenTime = Number(visibleCandles.at(-1)?.openTime ?? 0);
    const cutoffTime = Number.isFinite(lastOpenTime) && lastOpenTime > 0 ? lastOpenTime - RECENT_WINDOW_MS : 0;
    const recentCandles = visibleCandles.filter((candle) => Number(candle.openTime) >= cutoffTime);
    const recentSeries = mergedSeries.map((series) => ({
        title: series.title,
        pane: series.pane,
        style: series.style,
        data: (Array.isArray(series.data) ? series.data : []).filter((point) => Number(point?.time) >= cutoffTime),
    }));
    return {
        windowDays: 90,
        cutoffTime,
        candles: recentCandles,
        series: recentSeries,
    };
}

type BatchJob = {
    symbol: string;
    timeframe: string;
    outDir: string;
    resolved: ResolvedScripts;
    target: RenderTarget;
};

function hasExplicitScriptSelection(args: CliArgs) {
    return Boolean(args.codeFile || args.profile || args.preset || args.script);
}

function sanitizeOutputSegment(value: string) {
    return value.replaceAll(':', '_').replaceAll('/', '_');
}

function resolveTimeframeProfile(timeframe: string) {
    const profile = PROFILE_BY_TIMEFRAME[timeframe];
    invariant(profile, `Unsupported timeframe for batch render: ${timeframe}`);
    return profile;
}

async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>,
) {
    const limit = Math.max(1, Math.floor(concurrency));
    const results = new Array<R>(items.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length) {
                return;
            }
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

function prefixSeries(series: PinePlotSeries[], label: string, multiScript: boolean): PinePlotSeries[] {
    if (!multiScript) return series;
    return series.map((item) => ({
        ...item,
        id: `${label}-${item.id}`,
        title: `${label} · ${item.title}`,
    }));
}

function prefixMarkers(markers: PineShapeMarker[], label: string, multiScript: boolean): PineShapeMarker[] {
    if (!multiScript) return markers;
    return markers.map((item) => ({
        ...item,
        id: `${label}-${item.id}`,
        title: `${label} · ${item.title}`,
    }));
}

function formatDate(time: number) {
    const date = new Date(time);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function alignRows(
    candles: Awaited<ReturnType<typeof loadMarketData>>['candles'],
    series: PinePlotSeries[],
) {
    const seriesMaps = new Map(series.map((item) => [item.title, new Map(item.data.map((point) => [point.time, point.value]))]));
    const titles = series.map((item) => item.title);

    const rows = candles.map((candle) => {
        const row: Record<string, number | string> = {
            date: formatDate(candle.openTime),
            openTime: candle.openTime,
            closeTime: candle.closeTime,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
        };

        for (const title of titles) {
            row[title] = seriesMaps.get(title)?.get(candle.openTime) ?? '';
        }

        return row;
    });

    return { rows, titles };
}

function rowsToCsv(rows: Record<string, string | number>[]) {
    if (rows.length === 0) return '';
    const headers = Object.keys(rows[0]);
    const escape = (value: string | number) => {
        const text = String(value);
        if (!/[,"\n]/.test(text)) return text;
        return `"${text.replaceAll('"', '""')}"`;
    };

    return [
        headers.join(','),
        ...rows.map((row) => headers.map((header) => escape(row[header] ?? '')).join(',')),
    ].join('\n');
}

function trimSeriesToVisibleWindow(
    candles: Awaited<ReturnType<typeof loadMarketData>>['candles'],
    series: PinePlotSeries[],
) {
    if (candles.length === 0) return series;
    const firstVisibleTime = candles[0].openTime;
    return series
        .map((item) => ({
            ...item,
            data: item.data.filter((point) => point.time >= firstVisibleTime),
        }))
        .filter((item) => item.data.length > 0);
}

function trimMarkersToVisibleWindow(
    candles: Awaited<ReturnType<typeof loadMarketData>>['candles'],
    markers: PineShapeMarker[],
) {
    if (candles.length === 0) return markers;
    const firstVisibleTime = candles[0].openTime;
    return markers.filter((item) => item.time >= firstVisibleTime);
}

function trimLinesToVisibleWindow(
    candles: Awaited<ReturnType<typeof loadMarketData>>['candles'],
    fullCandleCount: number,
    lines: PineLineDrawing[],
) {
    if (candles.length === 0) return lines;
    const hiddenBars = Math.max(0, fullCandleCount - candles.length);
    const firstVisibleTime = candles[0].openTime;
    const lastVisibleTime = candles[candles.length - 1].openTime;

    return lines
        .map((item) => {
            if (item.xloc === 'bi') {
                return {
                    ...item,
                    x1: item.x1 - hiddenBars,
                    x2: item.x2 - hiddenBars,
                };
            }
            return item;
        })
        .filter((item) => {
            if (item.xloc === 'bi') {
                return !(item.x1 < 0 && item.x2 < 0) && !(item.x1 > candles.length - 1 && item.x2 > candles.length - 1);
            }
            return !(item.x1 < firstVisibleTime && item.x2 < firstVisibleTime) && !(item.x1 > lastVisibleTime && item.x2 > lastVisibleTime);
        });
}

function formatAxisValue(value: number) {
    const abs = Math.abs(value);
    if (abs > 0 && abs < 0.0001) return value.toExponential(2);
    if (abs > 0 && abs < 0.01) return value.toFixed(6);
    if (abs > 0 && abs < 0.1) return value.toFixed(5);
    if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    if (abs >= 100) return value.toFixed(0);
    if (abs >= 10) return value.toFixed(1);
    if (abs >= 1) return value.toFixed(2);
    return value.toFixed(4);
}

function oscillatorGroupKey(title: string) {
    const separator = ' · ';
    const index = title.indexOf(separator);
    return index >= 0 ? title.slice(0, index) : '__single__';
}

function seriesTitleSuffix(title: string) {
    const separator = ' · ';
    const index = title.lastIndexOf(separator);
    return index >= 0 ? title.slice(index + separator.length) : title;
}

function isAnonymousReferenceSeries(item: PinePlotSeries) {
    const suffix = seriesTitleSuffix(item.title).trim();
    return /^#\d+$/.test(suffix);
}

function isConstantSeries(item: PinePlotSeries) {
    if (item.data.length === 0) return false;
    const first = item.data[0]?.value;
    if (!Number.isFinite(first)) return false;
    return item.data.every((point) => point.value === first);
}

function shouldShowLegendSeries(item: PinePlotSeries) {
    if (isAnonymousReferenceSeries(item)) return false;
    if (item.pane === 'oscillator' && isConstantSeries(item)) return false;
    return true;
}

function colorWithAlpha(color: string, alpha: number) {
    if (color.startsWith('#')) {
        let hex = color.slice(1);
        if (hex.length === 3) {
            hex = hex
                .split('')
                .map((char) => char + char)
                .join('');
        }
        if (hex.length === 6) {
            const r = Number.parseInt(hex.slice(0, 2), 16);
            const g = Number.parseInt(hex.slice(2, 4), 16);
            const b = Number.parseInt(hex.slice(4, 6), 16);
            return `rgba(${r},${g},${b},${alpha})`;
        }
    }
    return color;
}

function renderColoredLine(
    points: Array<PinePlotPoint | null>,
    xForIndex: (index: number) => number,
    yForValue: (value: number) => number,
    style: string,
    fallbackColor: string,
    strokeWidth: number,
) {
    const elements: string[] = [];
    let previousPoint: PinePlotPoint | null = null;
    let previousIndex = -1;

    const pointColor = (point: PinePlotPoint | null) =>
        point && typeof point.options?.color === 'string' ? String(point.options.color) : fallbackColor;

    for (let index = 0; index < points.length; index += 1) {
        const point = points[index];
        if (!point) {
            previousPoint = null;
            previousIndex = -1;
            continue;
        }

        if (!previousPoint) {
            previousPoint = point;
            previousIndex = index;
            continue;
        }

        const x1 = xForIndex(previousIndex);
        const y1 = yForValue(previousPoint.value);
        const x2 = xForIndex(index);
        const y2 = yForValue(point.value);
        const stroke = pointColor(point);

        if (style === 'stepline') {
            elements.push(
                `<path d="M ${x1} ${y1} L ${x2} ${y1} L ${x2} ${y2}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" />`,
            );
        } else {
            elements.push(
                `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" />`,
            );
        }

        previousPoint = point;
        previousIndex = index;
    }

    return elements.join('\n');
}

export function renderSvg(
    symbol: string,
    timeframe: string,
    candles: Awaited<ReturnType<typeof loadMarketData>>['candles'],
    series: PinePlotSeries[],
    lines: PineLineDrawing[],
    markers: PineShapeMarker[],
    options?: { showVolumePanel?: boolean },
) {
    const width = DEFAULT_RENDER_WIDTH;
    const margin = { top: 84, right: 156, bottom: 56, left: 74 };
    const plotRightPadding = 34;
    const plotInsetX = 18;
    const overlay = series.filter((item) => item.pane === 'overlay');
    const oscillator = series.filter((item) => item.pane === 'oscillator');
    const overlayMarkers = markers.filter((item) => item.pane === 'overlay');
    const oscillatorMarkers = markers.filter((item) => item.pane === 'oscillator');
    const showMainPanel = true;
    const showVolumePanel = options?.showVolumePanel ?? true;

    const oscillatorGroupMap = new Map<string, { label: string; series: PinePlotSeries[]; markers: PineShapeMarker[] }>();
    const hasPrefixedOscillator = oscillator.some((item) => item.title.includes(' · '));
    for (const item of oscillator) {
        const key = hasPrefixedOscillator ? oscillatorGroupKey(item.title) : '__single__';
        const label = key === '__single__' ? 'Indicator' : key;
        if (!oscillatorGroupMap.has(key)) {
            oscillatorGroupMap.set(key, { label, series: [], markers: [] });
        }
        oscillatorGroupMap.get(key)!.series.push(item);
    }
    for (const item of oscillatorMarkers) {
        const key = hasPrefixedOscillator ? oscillatorGroupKey(item.title) : '__single__';
        const label = key === '__single__' ? 'Indicator' : key;
        if (!oscillatorGroupMap.has(key)) {
            oscillatorGroupMap.set(key, { label, series: [], markers: [] });
        }
        oscillatorGroupMap.get(key)!.markers.push(item);
    }
    const oscillatorGroups = [...oscillatorGroupMap.values()];
    const hasOscillator = oscillatorGroups.length > 0;

    const legendSeries = series.filter(shouldShowLegendSeries);
    const legendColumns = 4;
    const legendRowHeight = 24;
    const legendStartY = 94;
    const legendRows = legendSeries.length > 0 ? Math.ceil(legendSeries.length / legendColumns) : 0;
    const headerBottom = legendStartY + legendRows * legendRowHeight;
    const mainTop = Math.max(margin.top, headerBottom + 22);

    const mainHeight = showMainPanel ? (hasOscillator ? 430 : 620) : 0;
    const volumeHeight = showVolumePanel ? 130 : 0;
    const oscillatorHeight = hasOscillator ? 220 : 0;
    const gap = 28;

    const chartLeft = margin.left;
    const chartRight = width - margin.right - plotRightPadding;
    const chartWidth = chartRight - chartLeft;
    const plotLeft = chartLeft + plotInsetX;
    const plotRight = chartRight - plotInsetX;
    const plotWidth = Math.max(plotRight - plotLeft, 1);
    const volumeTop = mainTop + (showMainPanel ? mainHeight + gap : 0);
    const firstOscillatorTop = volumeTop + (showVolumePanel ? volumeHeight + gap : 0);
    const totalOscillatorHeight = hasOscillator ? oscillatorGroups.length * oscillatorHeight + Math.max(0, oscillatorGroups.length - 1) * gap : 0;
    const height = Math.max(
        1000,
        firstOscillatorTop + totalOscillatorHeight + margin.bottom,
    );
    const overlayValues = overlay.flatMap((item) => item.data.map((point) => point.value));
    const priceMin = Math.min(...candles.map((c) => c.low), ...overlayValues);
    const priceMax = Math.max(...candles.map((c) => c.high), ...overlayValues);
    const priceSpan = Math.max(priceMax - priceMin, Math.max(Math.abs(priceMax) * 0.001, 1e-6));
    const volumeMax = Math.max(...candles.map((c) => c.volume), 1);

    const xStep = plotWidth / Math.max(candles.length, 1);
    const candleBodyWidth = Math.max(2, Math.min(10, xStep * 0.6));

    const xForIndex = (index: number) => plotLeft + (index + 0.5) * xStep;
    const yForPrice = (value: number) => mainTop + ((priceMax - value) / priceSpan) * mainHeight;
    const yForVolume = (value: number) => volumeTop + volumeHeight - (value / volumeMax) * volumeHeight;

    const buildAxisLabels = (
        values: number[],
        yForValue: (value: number) => number,
        x: number,
        width = 64,
        textColor = '#cfe0d7',
    ) =>
        values
            .map((value) => {
                const y = yForValue(value);
                return `
<line x1="${chartLeft}" y1="${y}" x2="${chartRight}" y2="${y}" stroke="rgba(90,120,106,0.16)" stroke-width="1" />
<rect x="${x}" y="${y - 11}" width="${width}" height="22" rx="8" fill="rgba(15,22,18,0.94)" stroke="#2a3d34" />
<text x="${x + width / 2}" y="${y + 5}" fill="${textColor}" font-size="12" text-anchor="middle" font-family="IBM Plex Mono, monospace">${formatAxisValue(
                    value,
                )}</text>`;
            })
            .join('\n');

    const priceTicks = Array.from({ length: 5 }, (_, index) => priceMin + (priceSpan * index) / 4).reverse();
    const volumeTicks = [volumeMax, volumeMax * 0.5, 0];
    const priceAxis = showMainPanel ? buildAxisLabels(priceTicks, yForPrice, chartRight + 10, 72) : '';
    const volumeAxis = showVolumePanel ? buildAxisLabels(volumeTicks, yForVolume, chartRight + 10, 72, '#b7c8bf') : '';

    const candleElements = showMainPanel
        ? candles
              .map((candle, index) => {
                  const x = xForIndex(index);
                  const wickTop = yForPrice(candle.high);
                  const wickBottom = yForPrice(candle.low);
                  const openY = yForPrice(candle.open);
                  const closeY = yForPrice(candle.close);
                  const bodyTop = Math.min(openY, closeY);
                  const bodyHeight = Math.max(1.5, Math.abs(closeY - openY));
                  const fill = candle.close >= candle.open ? '#d66b4d' : '#2f9b72';

                  return `
<line x1="${x}" y1="${wickTop}" x2="${x}" y2="${wickBottom}" stroke="${fill}" stroke-width="1.4" />
<rect x="${x - candleBodyWidth / 2}" y="${bodyTop}" width="${candleBodyWidth}" height="${bodyHeight}" fill="${fill}" rx="1.4" />`;
              })
              .join('\n')
        : '';

    const volumeElements = showVolumePanel
        ? candles
              .map((candle, index) => {
                  const x = xForIndex(index);
                  const y = yForVolume(candle.volume);
                  const h = volumeTop + volumeHeight - y;
                  const fill = candle.close >= candle.open ? 'rgba(214,107,77,0.55)' : 'rgba(47,155,114,0.55)';
                  return `<rect x="${x - candleBodyWidth / 2}" y="${y}" width="${candleBodyWidth}" height="${h}" fill="${fill}" rx="1" />`;
              })
              .join('\n')
        : '';

    const alignSeriesPoints = (title: string) => {
        const map = new Map(series.find((item) => item.title === title)?.data.map((point) => [point.time, point]));
        return candles.map((candle) => map.get(candle.openTime) ?? null);
    };

    const alignSeriesValues = (title: string) => alignSeriesPoints(title).map((point) => point?.value ?? null);

    const buildPath = (values: Array<number | null>, yForValue: (value: number) => number, style = 'line') => {
        let pathData = '';
        let segmentOpen = false;
        let prevY = 0;
        values.forEach((value, index) => {
            if (value == null) {
                if (style === 'linebr') {
                    segmentOpen = false;
                }
                return;
            }
            const x = xForIndex(index);
            const y = yForValue(value);
            if (style === 'linebr') {
                pathData += segmentOpen ? ` L ${x} ${y}` : ` M ${x} ${y}`;
                segmentOpen = true;
                prevY = y;
                return;
            }
            if (style === 'stepline') {
                if (!segmentOpen) {
                    pathData += `M ${x} ${y}`;
                    segmentOpen = true;
                } else {
                    pathData += ` L ${x} ${prevY} L ${x} ${y}`;
                }
                prevY = y;
                return;
            }
            pathData += pathData ? ` L ${x} ${y}` : `M ${x} ${y}`;
            prevY = y;
        });
        return pathData.trim();
    };

    const buildAreaPaths = (
        upperValues: Array<number | null>,
        lowerValues: Array<number | null>,
        yForValue: (value: number) => number,
        fill: string,
    ) => {
        const paths: string[] = [];
        let index = 0;
        while (index < upperValues.length) {
            while (index < upperValues.length && (upperValues[index] == null || lowerValues[index] == null)) {
                index += 1;
            }

            const upperPoints: string[] = [];
            const lowerPoints: string[] = [];
            while (index < upperValues.length && upperValues[index] != null && lowerValues[index] != null) {
                upperPoints.push(`${xForIndex(index)} ${yForValue(upperValues[index] as number)}`);
                lowerPoints.push(`${xForIndex(index)} ${yForValue(lowerValues[index] as number)}`);
                index += 1;
            }

            if (upperPoints.length >= 2) {
                paths.push(
                    `<path d="M ${upperPoints.join(' L ')} L ${lowerPoints.reverse().join(' L ')} Z" fill="${fill}" stroke="none" />`,
                );
            }
        }

        return paths.join('\n');
    };

    const overlayPaths = showMainPanel
        ? overlay
              .map(
                  (item) =>
                      renderColoredLine(
                          alignSeriesPoints(item.title),
                          xForIndex,
                          yForPrice,
                          item.style,
                          item.color,
                          2.2,
                      ),
              )
              .join('\n')
        : '';

    const indexForTime = (time: number) => {
        let bestIndex = 0;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let index = 0; index < candles.length; index += 1) {
            const distance = Math.abs(candles[index].openTime - time);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestIndex = index;
            }
        }
        return bestIndex;
    };

    const lineStrokeDasharray = (style: string) => {
        if (style === 'style_dotted') return '2 5';
        if (style === 'style_dashed') return '8 6';
        return undefined;
    };

    const overlayLineElements = showMainPanel
        ? lines
              .map((item) => {
                  const x1Index = item.xloc === 'bt' ? indexForTime(item.x1) : Math.max(0, Math.min(candles.length - 1, Math.round(item.x1)));
                  const x2Index = item.xloc === 'bt' ? indexForTime(item.x2) : Math.max(0, Math.min(candles.length - 1, Math.round(item.x2)));
                  const dasharray = lineStrokeDasharray(item.style);
                  const dashAttr = dasharray ? ` stroke-dasharray="${dasharray}"` : '';
                  return `<line x1="${xForIndex(x1Index)}" y1="${yForPrice(item.y1)}" x2="${xForIndex(x2Index)}" y2="${yForPrice(item.y2)}" stroke="${item.color}" stroke-width="${Math.max(
                      1,
                      item.width,
                  )}" stroke-linecap="round"${dashAttr} />`;
              })
              .join('\n')
        : '';

    const markerElements = (items: PineShapeMarker[], paneTop: number, paneHeight: number) =>
        items
            .map((item) => {
                const index = indexForTime(item.time);
                const x = xForIndex(index);
                const location = item.location.toLowerCase();
                const isBottom =
                    location === 'bottom' ||
                    location === 'belowbar' ||
                    location === 'below_bar' ||
                    location === 'below bar';
                const y = isBottom ? paneTop + paneHeight - 18 : paneTop + 18;
                const fill = item.color || (isBottom ? '#00E676' : '#FF1744');
                const text = item.text || '!';
                return `
<g>
  <circle cx="${x}" cy="${y}" r="10" fill="${fill}" stroke="rgba(10,15,13,0.72)" stroke-width="1.5" />
  <text x="${x}" y="${y + 4}" fill="#f7fbf8" font-size="12" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-weight="700">${text}</text>
</g>`;
            })
            .join('\n');

    const overlayMarkerElements = showMainPanel
        ? overlayMarkers
              .map((item) => {
                  const index = indexForTime(item.time);
                  const x = xForIndex(index);
                  const candle = candles[index];
                  const location = item.location.toLowerCase();
                  const isBelowBar =
                      location === 'belowbar' ||
                      location === 'below_bar' ||
                      location === 'below bar' ||
                      location === 'bottom';
                  const anchorY = isBelowBar ? yForPrice(candle.low) + 16 : yForPrice(candle.high) - 16;
                  const y = Math.max(mainTop + 14, Math.min(mainTop + mainHeight - 14, anchorY));
                  const fill = item.color || (isBelowBar ? '#00E676' : '#FF1744');
                  const text = item.text || '!';
                  return `
<g>
  <circle cx="${x}" cy="${y}" r="10" fill="${fill}" stroke="rgba(10,15,13,0.72)" stroke-width="1.5" />
  <text x="${x}" y="${y + 4}" fill="#f7fbf8" font-size="12" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-weight="700">${text}</text>
</g>`;
              })
              .join('\n')
        : '';

    const oscillatorPaneBlocks = oscillatorGroups
        .map((group, groupIndex) => {
            const top = firstOscillatorTop + groupIndex * (oscillatorHeight + gap);
            const values = group.series.flatMap((item) => item.data.map((point) => point.value));
            const rawMin = values.length ? Math.min(...values) : -1;
            const rawMax = values.length ? Math.max(...values) : 1;
            const rawSpan = Math.max(rawMax - rawMin, 0);
            const padding = values.length ? Math.max(rawSpan * 0.08, rawSpan === 0 ? Math.max(Math.abs(rawMax) * 0.1, 1) : 0) : 0;
            const min = rawMin - padding;
            const max = rawMax + padding;
            const span = Math.max(max - min, 1e-9);
            const baseline = min > 0 ? min : max < 0 ? max : 0;
            const yForOsc = (value: number) => top + ((max - value) / span) * oscillatorHeight;
            const ticks = [max, (max + min) / 2, min];
            const axis = buildAxisLabels(ticks, yForOsc, chartRight + 10, 72, '#b7c8bf');
            const zeroLine =
                min <= 0 && 0 <= max
                    ? `<line x1="${chartLeft}" y1="${yForOsc(0)}" x2="${chartRight}" y2="${yForOsc(0)}" stroke="rgba(240,166,96,0.35)" stroke-width="1" stroke-dasharray="4 4" />`
                    : '';
            const basisSeries = group.series.find((item) => seriesTitleSuffix(item.title) === 'Basis');
            const oscillatorFills =
                basisSeries != null
                    ? group.series
                          .filter((item) => /^BB_Upper\d+$/.test(seriesTitleSuffix(item.title)))
                          .sort((a, b) => seriesTitleSuffix(a.title).localeCompare(seriesTitleSuffix(b.title)))
                          .map((item, index) =>
                              buildAreaPaths(
                                  alignSeriesValues(item.title),
                                  alignSeriesValues(basisSeries.title),
                                  yForOsc,
                                  colorWithAlpha(item.color, Math.max(0.08, 0.22 - index * 0.035)),
                              ),
                          )
                          .join('\n')
                    : '';
            const seriesElements = group.series
                .map((item) => {
                    const alignedPoints = alignSeriesPoints(item.title);
                    const aligned = alignedPoints.map((point) => point?.value ?? null);
                    if (item.style === 'histogram' || item.style === 'columns') {
                        return alignedPoints
                            .map((point, index) => {
                                const value = point?.value ?? null;
                                if (value == null) return '';
                                const x = xForIndex(index);
                                const baselineY = yForOsc(baseline);
                                const valueY = yForOsc(value);
                                const y = Math.min(baselineY, valueY);
                                const h = Math.max(1, Math.abs(baselineY - valueY));
                                const pointColor =
                                    typeof point?.options?.color === 'string' && point.options.color
                                        ? colorWithAlpha(String(point.options.color), 0.85)
                                        : colorWithAlpha(item.color, 0.75);
                                return `<rect x="${x - candleBodyWidth / 2}" y="${y}" width="${candleBodyWidth}" height="${h}" fill="${pointColor}" rx="1" />`;
                            })
                            .join('\n');
                    }
                    return renderColoredLine(
                        alignedPoints,
                        xForIndex,
                        yForOsc,
                        item.style,
                        item.color,
                        2,
                    );
                })
                .join('\n');
            const markerSvg = markerElements(group.markers, top, oscillatorHeight);
            const label =
                hasPrefixedOscillator && group.label !== '__single__'
                    ? `<text x="${chartLeft + 16}" y="${top + 24}" fill="#b7c8bf" font-size="13" font-family="IBM Plex Mono, monospace">${group.label}</text>`
                    : '';
            const rect = `<rect x="${chartLeft}" y="${top}" width="${chartWidth}" height="${oscillatorHeight}" fill="rgba(13,19,16,0.9)" stroke="#22342c" rx="16" />`;

            return `${rect}
  ${label}
  ${zeroLine}
  ${oscillatorFills}
  ${seriesElements}
  ${markerSvg}
  ${axis}`;
        })
        .join('\n');

    const legendItems = legendSeries
        .map((item, index) => {
            const row = Math.floor(index / legendColumns);
            const col = index % legendColumns;
            const x = chartLeft + col * 320;
            const y = legendStartY + row * legendRowHeight;
            return `
<circle cx="${x}" cy="${y}" r="5" fill="${item.color}" />
<text x="${x + 14}" y="${y + 5}" fill="#d9e3dd" font-size="16" font-family="Space Grotesk, sans-serif">${item.title}</text>`;
        })
        .join('\n');

    const xLabels = [0, Math.floor(candles.length / 2), candles.length - 1]
        .filter((value, index, self) => self.indexOf(value) === index)
        .map((index) => {
            const x = xForIndex(index);
            return `<text x="${x}" y="${height - 18}" fill="#8da39a" font-size="14" text-anchor="middle" font-family="IBM Plex Mono, monospace">${formatDate(
                candles[index].openTime,
            )}</text>`;
        })
        .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#121d18" />
      <stop offset="100%" stop-color="#0a0f0d" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)" rx="26" />
  <text x="${chartLeft}" y="34" fill="#f1f6f2" font-size="26" font-family="Space Grotesk, sans-serif">${symbol} · ${timeframe}</text>
  <text x="${chartLeft}" y="62" fill="#97a89f" font-size="15" font-family="IBM Plex Mono, monospace">Generated with PineTS local renderer</text>
  ${legendItems}

  ${
      showMainPanel
          ? `<rect x="${chartLeft}" y="${mainTop}" width="${chartWidth}" height="${mainHeight}" fill="rgba(16,25,21,0.88)" stroke="#22342c" rx="20" />`
          : ''
  }
  ${
      showVolumePanel
          ? `<rect x="${chartLeft}" y="${volumeTop}" width="${chartWidth}" height="${volumeHeight}" fill="rgba(13,19,16,0.9)" stroke="#22342c" rx="16" />`
          : ''
  }
  ${
      hasOscillator ? oscillatorPaneBlocks : ''
  }

  ${candleElements}
  ${overlayLineElements}
  ${overlayPaths}
  ${overlayMarkerElements}
  ${volumeElements}
  ${priceAxis}
  ${volumeAxis}
  ${xLabels}
</svg>`;
}

async function main() {
    const baseDir = process.cwd();
    const args = parseCli();
    const selectedOutputs = parseRenderOutputs(args.outputs);

    const renderSingle = async ({
        resolved,
        target,
        outDir,
    }: {
        resolved: ResolvedScripts;
        target: RenderTarget;
        outDir: string;
    }): Promise<RenderSummary> => {
        invariant(resolved.scripts.length > 0, 'No scripts resolved to render.');
        const maxWarmupBars = Math.max(0, ...resolved.scripts.map((script) => script.warmupBars ?? 0));
        const market = await loadMarketData({
            ...target,
            limit: target.limit + maxWarmupBars,
            baseDir,
        });
        const primaryResourceLoadOptions = resolvePrimaryResourceLoadOptions(resolved, target);
        const primaryResources = await loadPrimaryPineResources({
            source: market.source,
            symbol: market.symbol,
            baseDir,
            timeframe: market.timeframe,
            limit: market.limit,
            loadOptions: primaryResourceLoadOptions,
        });
        const sharedFinraCache = new Map<string, Promise<Candle[]>>();
        const sharedLowerTfCandleCache = new Map<string, Promise<Candle[]>>();

        const analyses = await Promise.all(
            resolved.scripts.map(async (script) => {
                const result = await runPineOnCandles(market.candles, script.code, {
                    source: market.source,
                    symbol: market.symbol,
                    timeframe: market.timeframe,
                    limit: market.limit,
                    baseDir,
                    primaryYahooSnapshot: primaryResources.primaryYahooSnapshot,
                    primaryYahooSplits: primaryResources.primaryYahooSplits,
                    primaryYahooFinancials: primaryResources.primaryYahooFinancials,
                    primaryFinraCandles: primaryResources.primaryFinraCandles,
                    primaryFinraTimeframe: primaryResources.primaryFinraTimeframe,
                    sharedFinraCache,
                    sharedLowerTfCandleCache,
                });
                return {
                    script,
                    result,
                };
            }),
        );

        const visibleCandles = market.candles.slice(-target.limit);
        const multiScript = analyses.length > 1;
        const mergedSeries = trimSeriesToVisibleWindow(
            visibleCandles,
            analyses.flatMap(({ script, result }) => prefixSeries(result.series, script.label, multiScript)),
        );
        const mergedLines = trimLinesToVisibleWindow(
            visibleCandles,
            market.candles.length,
            analyses.flatMap(({ result }) => result.lines),
        );
        const mergedMarkers = trimMarkersToVisibleWindow(
            visibleCandles,
            analyses.flatMap(({ script, result }) => prefixMarkers(result.markers, script.label, multiScript)),
        );
        const warnings = [
            ...primaryResources.warnings,
            ...analyses.flatMap(({ script, result }) => result.warnings.map((warning) => `${script.label}: ${warning}`)),
        ];

        await fs.mkdir(outDir, { recursive: true });

        const datasetPath = path.join(outDir, 'dataset.json');
        const csvPath = path.join(outDir, 'dataset.csv');
        const pngPath = path.join(outDir, 'chart.png');
        const codePath = path.join(outDir, 'indicator.pine');
        const metaPath = path.join(outDir, 'meta.json');
        const latestPath = path.join(outDir, 'latest.json');
        const needsTabularRows = selectedOutputs.has('dataset') || selectedOutputs.has('csv');
        const rows = needsTabularRows ? alignRows(visibleCandles, mergedSeries).rows : [];
        const needsPng = selectedOutputs.has('png');
        const pngBytes = needsPng
            ? (() => {
                  const svgMarkup = renderSvg(market.symbol, market.timeframe, visibleCandles, mergedSeries, mergedLines, mergedMarkers);
                  const resvg = new Resvg(svgMarkup, {
                      fitTo: {
                          mode: 'width',
                          value: DEFAULT_RENDER_WIDTH,
                      },
                      font: {
                          loadSystemFonts: true,
                      },
                  });
                  return resvg.render().asPng();
              })()
            : null;
        const combinedCode = analyses
            .map(({ script }) => `// ${script.kind}:${script.id}\n${script.code.trim()}`)
            .join('\n\n');
        const latestSeries = Object.fromEntries(
            mergedSeries.map((item) => [item.title, getLatestFiniteSeriesValue(item)]),
        );
        const recentWindow = buildRecentWindow(visibleCandles, mergedSeries);

        const writes: Promise<unknown>[] = [];

        if (selectedOutputs.has('dataset')) {
            writes.push(
                fs.writeFile(
                    datasetPath,
                    JSON.stringify(
                        {
                            source: market.source,
                            symbol: market.symbol,
                            timeframe: market.timeframe,
                            limit: target.limit,
                            candles: visibleCandles,
                            series: mergedSeries,
                            lines: mergedLines,
                            markers: mergedMarkers,
                            warnings,
                            scripts: analyses.map(({ script }) => ({
                                kind: script.kind,
                                id: script.id,
                                label: script.label,
                            })),
                            profile: resolved.profile
                                ? {
                                      id: resolved.profile.id,
                                      label: resolved.profile.label,
                                  }
                                : null,
                        },
                        null,
                        2,
                    ),
                ),
            );
        }

        if (selectedOutputs.has('csv')) {
            writes.push(fs.writeFile(csvPath, rowsToCsv(rows)));
        }

        if (selectedOutputs.has('png') && pngBytes) {
            writes.push(fs.writeFile(pngPath, pngBytes));
        }

        if (selectedOutputs.has('indicator')) {
            writes.push(fs.writeFile(codePath, combinedCode + '\n'));
        }

        if (selectedOutputs.has('meta')) {
            writes.push(
                fs.writeFile(
                    metaPath,
                    JSON.stringify(
                        {
                            source: market.source,
                            symbol: market.symbol,
                            timeframe: market.timeframe,
                            bars: visibleCandles.length,
                            series: mergedSeries.map((item) => ({
                                title: item.title,
                                pane: item.pane,
                                style: item.style,
                            })),
                            lines: mergedLines.map((item) => ({
                                id: item.id,
                                style: item.style,
                                width: item.width,
                                color: item.color,
                            })),
                            markers: mergedMarkers.map((item) => ({
                                id: item.id,
                                title: item.title,
                                pane: item.pane,
                                shape: item.shape,
                                location: item.location,
                                color: item.color,
                            })),
                            scripts: analyses.map(({ script }) => ({
                                kind: script.kind,
                                id: script.id,
                                label: script.label,
                            })),
                            profile: resolved.profile
                                ? {
                                      id: resolved.profile.id,
                                      label: resolved.profile.label,
                                  }
                                : null,
                            warnings,
                        },
                        null,
                        2,
                    ),
                ),
            );
        }

        if (selectedOutputs.has('latest')) {
            writes.push(
                fs.writeFile(
                    latestPath,
                    JSON.stringify(
                        {
                            source: market.source,
                            symbol: market.symbol,
                            timeframe: market.timeframe,
                            latestSeries,
                            recentWindow,
                            warnings,
                            profile: resolved.profile
                                ? {
                                      id: resolved.profile.id,
                                      label: resolved.profile.label,
                                  }
                                : null,
                        },
                        null,
                        2,
                    ),
                ),
            );
        }

        await Promise.all(writes);

        return {
            outDir,
            outputs: [...selectedOutputs],
            datasetPath: selectedOutputs.has('dataset') ? datasetPath : null,
            csvPath: selectedOutputs.has('csv') ? csvPath : null,
            pngPath: selectedOutputs.has('png') ? pngPath : null,
            codePath: selectedOutputs.has('indicator') ? codePath : null,
            metaPath: selectedOutputs.has('meta') ? metaPath : null,
            latestPath: selectedOutputs.has('latest') ? latestPath : null,
            latestSeries,
            bars: visibleCandles.length,
            series: mergedSeries.map((item) => item.title),
            scripts: analyses.map(({ script }) => script.id),
            profile: resolved.profile?.id ?? null,
            symbol: market.symbol,
            timeframe: market.timeframe,
            source: market.source,
        };
    };

    const isBatchMode = Boolean(args.symbols || args.timeframes || args.outRoot);
    if (!isBatchMode) {
        const resolved = await resolveScripts(baseDir, args);
        const target = resolveRenderTarget(args, resolved.profile?.defaults);
        const summary = await renderSingle({
            resolved,
            target,
            outDir: path.resolve(args.outDir),
        });
        console.log(JSON.stringify(summary, null, 2));
        return;
    }

    invariant(!args.codeFile || !args.outRoot || !!args.symbols || !!args.timeframes, 'Batch render with --code-file requires explicit batch targets.');
    const symbols = parseCsvList(args.symbols ?? args.symbol);
    const timeframes = parseCsvList(args.timeframes ?? args.timeframe).map((item) => item.toUpperCase());
    invariant(symbols.length > 0, 'Batch render requires at least one symbol via --symbols or --symbol.');
    invariant(timeframes.length > 0, 'Batch render requires at least one timeframe via --timeframes or --timeframe.');

    const outRoot = path.resolve(args.outRoot ?? args.outDir);
    await fs.mkdir(outRoot, { recursive: true });

    const explicitSelection = hasExplicitScriptSelection(args);
    const selectionCache = new Map<string, Promise<ResolvedScripts>>();
    const getResolvedSelection = (timeframe: string) => {
        const cacheKey = explicitSelection ? 'explicit-selection' : `timeframe:${timeframe}`;
        const cached = selectionCache.get(cacheKey);
        if (cached) {
            return cached;
        }
        const nextArgs = explicitSelection ? args : { ...args, profile: resolveTimeframeProfile(timeframe) };
        const promise = resolveScripts(baseDir, nextArgs);
        selectionCache.set(cacheKey, promise);
        return promise;
    };

    const jobs: BatchJob[] = [];
    for (const symbol of symbols) {
        for (const timeframe of timeframes) {
            const resolved = await getResolvedSelection(timeframe);
            const target = resolveRenderTarget(
                {
                    ...args,
                    symbol,
                    timeframe,
                },
                resolved.profile?.defaults,
            );
            jobs.push({
                symbol,
                timeframe,
                outDir: path.join(outRoot, sanitizeOutputSegment(symbol), timeframe),
                resolved,
                target,
            });
        }
    }

    const concurrency = Math.max(1, args.concurrency ?? 4);
    const entries = await mapWithConcurrency(jobs, concurrency, async (job) => {
        try {
            const summary = await renderSingle(job);
            return {
                status: 'ok' as const,
                ...summary,
            };
        } catch (error) {
            return {
                status: 'error' as const,
                symbol: job.symbol,
                timeframe: job.timeframe,
                outDir: job.outDir,
                profile: job.resolved.profile?.id ?? null,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    });

    const manifestPath = path.join(outRoot, 'manifest.json');
    const manifest = {
        source: args.source ?? 'yahoo',
        outputs: [...selectedOutputs],
        concurrency,
        symbols,
        timeframes,
        entries,
        summary: {
            total: entries.length,
            succeeded: entries.filter((entry) => entry.status === 'ok').length,
            failed: entries.filter((entry) => entry.status === 'error').length,
        },
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    const failures = entries.filter((entry) => entry.status === 'error');
    if (failures.length > 0) {
        throw new Error(
            `Batch render failed for ${failures.length}/${entries.length} jobs. First failure: ${failures[0].symbol} ${failures[0].timeframe} - ${failures[0].error}`,
        );
    }

    console.log(
        JSON.stringify(
            {
                manifestPath,
                ...manifest.summary,
            },
            null,
            2,
        ),
    );
}

const entrypointHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entrypointHref === import.meta.url) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
