import { DatabaseSync } from 'node:sqlite';

import { getRendererCacheDb } from './cache-db';
import type { Candle } from './pine-workbench';

export type FinraMetric = 'short-volume' | 'short-exempt-volume' | 'total-volume' | 'short-ratio';

type FinraRecord = {
    date: string;
    symbol: string;
    shortVolume: number;
    shortExemptVolume: number;
    totalVolume: number;
    market: string;
};

const FINRA_BASE_URL = 'https://cdn.finra.org/equity/regsho/daily';
const FINRA_PREFIX = 'CNMS';
const FINRA_BACKFILL_FETCH_CONCURRENCY = 6;
const FINRA_UNAVAILABLE_TTL_MS = 60 * 60 * 1000;

const finraDateBackfillInFlight = new Map<string, Promise<void>>();

function invariant(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function formatDateId(date: Date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}

function dateIdToOpenTime(dateId: string) {
    return Date.UTC(Number(dateId.slice(0, 4)), Number(dateId.slice(4, 6)) - 1, Number(dateId.slice(6, 8)));
}

function addDays(date: Date, offset: number) {
    return new Date(date.getTime() + offset * 86400000);
}

function weekKey(time: number) {
    const date = new Date(time);
    const weekday = date.getUTCDay();
    const offset = weekday === 0 ? -6 : 1 - weekday;
    return formatDateId(addDays(date, offset));
}

function monthKey(time: number) {
    const date = new Date(time);
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}01`;
}

export function normalizeFinraSymbol(input: string) {
    const normalized = input.trim().toUpperCase().replace(/^FINRA:/, '');
    if (normalized.endsWith('_SHORT_VOLUME')) {
        return { baseSymbol: normalized.slice(0, -'_SHORT_VOLUME'.length), metric: 'short-volume' as const };
    }
    if (normalized.endsWith('_SHORT_EXEMPT_VOLUME')) {
        return { baseSymbol: normalized.slice(0, -'_SHORT_EXEMPT_VOLUME'.length), metric: 'short-exempt-volume' as const };
    }
    if (normalized.endsWith('_TOTAL_VOLUME')) {
        return { baseSymbol: normalized.slice(0, -'_TOTAL_VOLUME'.length), metric: 'total-volume' as const };
    }
    if (normalized.endsWith('_SHORT_RATIO')) {
        return { baseSymbol: normalized.slice(0, -'_SHORT_RATIO'.length), metric: 'short-ratio' as const };
    }
    return { baseSymbol: normalized, metric: 'short-volume' as const };
}

function metricValue(record: FinraRecord, metric: FinraMetric) {
    if (metric === 'short-exempt-volume') return record.shortExemptVolume;
    if (metric === 'total-volume') return record.totalVolume;
    if (metric === 'short-ratio') return record.totalVolume > 0 ? record.shortVolume / record.totalVolume : 0;
    return record.shortVolume;
}

async function getFinraDb(baseDir: string) {
    return getRendererCacheDb(baseDir);
}

async function fetchRemoteDailyFile(dateId: string) {
    const url = `${FINRA_BASE_URL}/${FINRA_PREFIX}shvol${dateId}.txt`;
    const response = await fetch(url, {
        signal: AbortSignal.timeout(20_000),
        headers: {
            'user-agent': 'Mozilla/5.0 PineTS-Local-Workbench',
        },
    });
    // FINRA's CDN also returns AccessDenied/403 for unpublished dates (e.g. holidays).
    // Cache this only briefly so a later publication or access recovery is retried.
    if (response.status === 404 || response.status === 403) {
        return { status: 'unavailable' as const, text: null };
    }
    if (!response.ok) {
        throw new Error(`FINRA request failed with ${response.status} for ${dateId}.`);
    }

    const text = await response.text();
    if (!text.startsWith('Date|Symbol|') || !text.includes(`${dateId}|`)) {
        throw new Error(`Invalid FINRA daily file for ${dateId}.`);
    }
    return { status: 'ready' as const, text };
}

function parseFinraDailyText(text: string, dateId: string) {
    const records: FinraRecord[] = [];
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        if (!line || !line.startsWith(`${dateId}|`)) continue;
        const [, symbol, shortVolume, shortExemptVolume, totalVolume, market] = line.split('|');
        if (!symbol) continue;
        const parsedShortVolume = Number(shortVolume);
        const parsedShortExemptVolume = Number(shortExemptVolume);
        const parsedTotalVolume = Number(totalVolume);
        if ([parsedShortVolume, parsedShortExemptVolume, parsedTotalVolume].some((value) => !Number.isFinite(value) || value < 0 || !Number.isInteger(value))) continue;
        records.push({
            date: dateId,
            symbol,
            shortVolume: parsedShortVolume,
            shortExemptVolume: parsedShortExemptVolume,
            totalVolume: parsedTotalVolume,
            market: market ?? '',
        });
    }
    return records;
}

function persistFetchedDates(
    db: DatabaseSync,
    items: Array<{
        dateId: string;
        remote: Awaited<ReturnType<typeof fetchRemoteDailyFile>>;
        fetchedAt: number;
    }>,
) {
    if (items.length === 0) return;

    const insertDaily = db.prepare(`
        INSERT OR REPLACE INTO finra_daily(
            date,
            symbol,
            short_volume,
            short_exempt_volume,
            total_volume,
            market
        ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const upsertState = db.prepare('INSERT OR REPLACE INTO finra_file_state(date, status, fetched_at) VALUES (?, ?, ?)');
    db.exec('BEGIN IMMEDIATE');
    try {
        for (const { dateId, remote, fetchedAt } of items) {
            if (remote.status === 'ready' && remote.text) {
                const records = parseFinraDailyText(remote.text, dateId);
                for (const record of records) {
                    insertDaily.run(
                        record.date,
                        record.symbol,
                        record.shortVolume,
                        record.shortExemptVolume,
                        record.totalVolume,
                        record.market,
                    );
                }
            }
            upsertState.run(dateId, remote.status, fetchedAt);
        }
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

async function ensureDateBackfilled(baseDir: string, dateId: string) {
    const { db, dbPath } = await getFinraDb(baseDir);
    const inflightKey = `${dbPath}:${dateId}`;
    const inflight = finraDateBackfillInFlight.get(inflightKey);
    if (inflight) return inflight;

    const promise = (async () => {
        const existing = db.prepare('SELECT status, fetched_at FROM finra_file_state WHERE date = ?').get(dateId) as { status: string; fetched_at: number } | undefined;
        if (existing?.status === 'ready' && db.prepare('SELECT 1 FROM finra_daily WHERE date = ? LIMIT 1').get(dateId)) return;
        if (existing?.status === 'unavailable' && Date.now() - existing.fetched_at < FINRA_UNAVAILABLE_TTL_MS) return;

        const remote = await fetchRemoteDailyFile(dateId);
        const fetchedAt = Date.now();
        persistFetchedDates(db, [{ dateId, remote, fetchedAt }]);
    })().finally(() => {
        finraDateBackfillInFlight.delete(inflightKey);
    });

    finraDateBackfillInFlight.set(inflightKey, promise);
    return promise;
}

export async function backfillFinraDates(baseDir: string, dateIds: string[]) {
    if (dateIds.some((dateId) => !/^\d{8}$/.test(dateId))) throw new Error('Invalid FINRA date.');
    let cursor = 0;
    const failures: unknown[] = [];
    const worker = async () => {
        while (cursor < dateIds.length) {
            const dateId = dateIds[cursor++];
            try {
                // Each successful date is committed immediately, and overlapping symbol
                // requests share one fetch for that date.
                await ensureDateBackfilled(baseDir, dateId);
            } catch (error) {
                failures.push(error);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(FINRA_BACKFILL_FETCH_CONCURRENCY, dateIds.length) }, worker));
    if (failures.length) throw new AggregateError(failures, 'FINRA backfill incomplete; successful dates were retained.');
}

async function fetchDailyRecordsFromDb(baseDir: string, symbol: string, dateIds: string[]) {
    if (dateIds.length === 0) return [] as FinraRecord[];
    const { db } = await getFinraDb(baseDir);
    const placeholders = dateIds.map(() => '?').join(', ');
    const rows = db.prepare(
        `
            SELECT
                date,
                symbol,
                short_volume AS shortVolume,
                short_exempt_volume AS shortExemptVolume,
                total_volume AS totalVolume,
                market
            FROM finra_daily
            WHERE symbol = ?
              AND date IN (${placeholders})
            ORDER BY date DESC
        `,
    ).all(symbol, ...dateIds) as FinraRecord[];
    return rows;
}

function aggregateSyntheticCandles(candles: Candle[], timeframe: 'D' | 'W' | 'M') {
    if (timeframe === 'D') return candles;
    const groups = new Map<string, Candle[]>();
    for (const candle of candles) {
        const key = timeframe === 'W' ? weekKey(candle.openTime) : monthKey(candle.openTime);
        const existing = groups.get(key) ?? [];
        existing.push(candle);
        groups.set(key, existing);
    }

    return [...groups.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([, group]) => {
            const first = group[0];
            const last = group[group.length - 1];
            const summedMetric = group.reduce((sum, item) => sum + item.close, 0);
            return {
                openTime: first.openTime,
                closeTime: last.closeTime,
                open: summedMetric,
                high: summedMetric,
                low: summedMetric,
                close: summedMetric,
                volume: group.reduce((sum, item) => sum + item.volume, 0),
            } satisfies Candle;
        });
}

export async function fetchFinraCandles(
    baseDir: string,
    symbolInput: string,
    timeframe: 'D' | 'W' | 'M',
    limit: number,
): Promise<Candle[]> {
    const { baseSymbol, metric } = normalizeFinraSymbol(symbolInput);
    invariant(baseSymbol, 'A FINRA symbol is required.');

    const records: FinraRecord[] = [];
    const today = new Date();
    const maxLookbackDays = timeframe === 'M' ? Math.max(limit * 31, 800) : timeframe === 'W' ? Math.max(limit * 8, 320) : Math.max(limit * 3, 450);
    const targetRecords = timeframe === 'M' ? limit * 22 : timeframe === 'W' ? limit * 5 : limit;
    const candidateDates: string[] = [];

    for (let offset = 0; offset < maxLookbackDays; offset += 1) {
        const current = addDays(today, -offset);
        const weekday = current.getUTCDay();
        if (weekday === 0 || weekday === 6) continue;
        candidateDates.push(formatDateId(current));
    }

    const batchSize = timeframe === 'D' ? 120 : timeframe === 'W' ? 80 : 60;
    for (let index = 0; index < candidateDates.length; index += batchSize) {
        const batch = candidateDates.slice(index, index + batchSize);
        await backfillFinraDates(baseDir, batch);
        const batchRecords = await fetchDailyRecordsFromDb(baseDir, baseSymbol, batch);
        for (const record of batchRecords) {
            if (record) records.push(record);
        }
        if (records.length >= targetRecords) break;
    }

    const candles = records
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((record) => {
            const value = metricValue(record, metric);
            const openTime = dateIdToOpenTime(record.date);
            return {
                openTime,
                closeTime: openTime + 86400000,
                open: value,
                high: value,
                low: value,
                close: value,
                volume: record.totalVolume,
            } satisfies Candle;
        });

    const aggregated = aggregateSyntheticCandles(candles, timeframe);
    return aggregated.slice(-limit);
}

export function resolveFinraFieldName(expression: unknown, data: Record<string, unknown>) {
    const entries = [
        ['open', data.open],
        ['high', data.high],
        ['low', data.low],
        ['close', data.close],
        ['volume', data.volume],
    ] as const;
    for (const [name, ref] of entries) {
        if (expression === ref) return name;
    }
    return null;
}

export function inferFinraFieldFromParam(
    paramValues: unknown[] | undefined,
    data: Record<string, { data?: unknown[] }>,
) {
    if (!Array.isArray(paramValues) || paramValues.length === 0) return null;
    const candidates = ['open', 'high', 'low', 'close', 'volume'] as const;

    for (const field of candidates) {
        const source = Array.isArray(data[field]?.data) ? data[field].data : [];
        const sampleSize = Math.min(paramValues.length, source.length, 8);
        if (sampleSize === 0) continue;

        let matches = true;
        for (let index = 0; index < sampleSize; index += 1) {
            if (paramValues[index] !== source[index]) {
                matches = false;
                break;
            }
        }

        if (matches) return field;
    }

    return null;
}

export function alignSecondaryValue(
    primaryOpenTime: number,
    primaryCloseTime: number,
    secondaryCandles: Candle[],
    field: 'open' | 'high' | 'low' | 'close' | 'volume',
) {
    for (let index = secondaryCandles.length - 1; index >= 0; index -= 1) {
        const candle = secondaryCandles[index];
        if (candle.openTime <= primaryOpenTime && primaryOpenTime < candle.closeTime) {
            return candle[field];
        }
        if (candle.closeTime <= primaryCloseTime && candle.openTime <= primaryOpenTime) {
            return candle[field];
        }
    }
    return Number.NaN;
}
