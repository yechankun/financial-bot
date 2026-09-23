import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fromYahooShareClassSymbol, toYahooShareClassSymbol } from './symbols';
import { readIndependentMarketSnapshot } from './independent-market-db';

type LocalStockRow = {
    symbol: string;
    ticker_view_type: string | null;
    market_cap_basic: number | null;
    total_assets_fq: number | null;
    total_equity_fq: number | null;
    return_on_assets_fq: number | null;
    return_on_equity_fq: number | null;
    close: number | null;
    saved_at?: string | null;
};

type LocalEtfRow = {
    etf_symbol: string;
    aggregate_date: string;
    etf_aum: number | null;
    etf_close: number | null;
};

type LocalMarketSnapshot = {
    kind: 'stock' | 'fund';
    symbol: string;
    regularMarketPrice: number | null;
    navPrice: number | null;
    marketCap: number | null;
    sharesOutstanding: number | null;
    totalAssets: number | null;
    totalEquity: number | null;
    returnOnAssets: number | null;
    returnOnEquity: number | null;
    pointTime: number;
};

const AGGREGATE_DB_BASENAME = 'etf_constituent_aggregates.sqlite3';
const aggregateDbHandleCache = new Map<string, { db: DatabaseSync; dev: number; ino: number }>();

function asNumber(value: unknown) {
    if (value == null || value === '' || (typeof value === 'string' && !value.trim())) return Number.NaN;
    return Number(value);
}

function hasTable(db: DatabaseSync, name: string) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function normalizeInputSymbol(value: string) {
    return String(value || '')
        .trim()
        .toUpperCase()
        .replace(/^FINRA:/, '')
        .replace(/_(SHORT_VOLUME|SHORT_EXEMPT_VOLUME|TOTAL_VOLUME|SHORT_RATIO)$/, '');
}

function normalizeSuffixVariant(value: string) {
    const normalized = normalizeInputSymbol(value);
    if (!normalized) return '';
    if (normalized.includes(':')) {
        return normalized;
    }
    const dotted = fromYahooShareClassSymbol(normalized);
    return dotted !== normalized ? dotted : toYahooShareClassSymbol(normalized);
}

function buildLookupCandidates(symbolInput: string) {
    const normalized = normalizeInputSymbol(symbolInput);
    const alternate = normalizeSuffixVariant(normalized);
    const candidates = new Set<string>();
    if (normalized) candidates.add(normalized);
    if (alternate) candidates.add(alternate);
    if (normalized.includes(':')) {
        const suffix = normalized.split(':').at(-1)?.trim();
        if (suffix) candidates.add(suffix);
    }
    return [...candidates].filter(Boolean);
}

function buildCandidateDbPaths(baseDir: string) {
    const explicitDataDir = process.env.INTERNAL_DATA_DIR || process.env.BOT_DATA_DIR;
    if (explicitDataDir) return [path.resolve(explicitDataDir, AGGREGATE_DB_BASENAME)];
    const runtimeRoot = process.env.INTERNAL_RUNTIME_ROOT_DIR || process.env.BOT_RUNTIME_ROOT_DIR;
    if (runtimeRoot) return [path.resolve(runtimeRoot, 'data', AGGREGATE_DB_BASENAME)];
    return [
        process.env.INTERNAL_DATA_DIR ? path.join(process.env.INTERNAL_DATA_DIR, AGGREGATE_DB_BASENAME) : '',
        process.env.BOT_RUNTIME_ROOT_DIR ? path.join(process.env.BOT_RUNTIME_ROOT_DIR, 'data', AGGREGATE_DB_BASENAME) : '',
        path.resolve(baseDir, '..', 'data', AGGREGATE_DB_BASENAME),
        path.resolve(baseDir, '..', '..', 'data', AGGREGATE_DB_BASENAME),
        path.resolve(process.cwd(), 'data', AGGREGATE_DB_BASENAME),
        path.resolve(process.cwd(), '..', 'data', AGGREGATE_DB_BASENAME),
    ].filter(Boolean);
}

function getAggregateDb(baseDir: string) {
    for (const candidate of buildCandidateDbPaths(baseDir)) {
        try {
            const stat = fs.statSync(candidate);
            if (!stat.isFile() || stat.size <= 0) {
                continue;
            }
            const cached = aggregateDbHandleCache.get(candidate);
            if (cached?.dev === stat.dev && cached?.ino === stat.ino) {
                return cached.db;
            }
            if (cached) { cached.db.close(); aggregateDbHandleCache.delete(candidate); }
            const db = new DatabaseSync(candidate, { readOnly: true });
            const hasStockTable = db
                .prepare(
                    `
                      SELECT 1 AS ok
                      FROM sqlite_master
                      WHERE type = 'table'
                        AND name IN ('stock_financial_cache', 'etf_constituent_aggregates')
                      LIMIT 1
                    `,
                )
                .get() as { ok?: number } | undefined;
            if (hasStockTable?.ok === 1) {
                aggregateDbHandleCache.set(candidate, { db, dev: stat.dev, ino: stat.ino });
                return db;
            }
            db.close();
        } catch {
            continue;
        }
    }
    return null;
}

function parseAggregateDateToTime(value: string | null | undefined) {
    const text = String(value || '').trim();
    if (!text) return 0;
    const parsed = Date.parse(`${text}T00:00:00Z`);
    return Number.isFinite(parsed) ? parsed : 0;
}

function parseSavedAtToTime(value: string | null | undefined) {
    const text = String(value || '').trim();
    if (!text) return 0;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : 0;
}

function lookupLocalStockRow(db: DatabaseSync, symbolInput: string) {
    if (!hasTable(db, 'stock_financial_cache')) return null;
    const candidates = buildLookupCandidates(symbolInput).filter((item) => !item.includes(':'));
    const exactCandidates = buildLookupCandidates(symbolInput).filter((item) => item.includes(':'));
    if (candidates.length === 0 && exactCandidates.length === 0) {
        return null;
    }

    const where: string[] = [];
    const params: string[] = [];
    if (exactCandidates.length > 0) {
        where.push(`symbol IN (${exactCandidates.map(() => '?').join(', ')})`);
        params.push(...exactCandidates);
    }
    if (candidates.length > 0) {
        where.push(`substr(symbol, instr(symbol, ':') + 1) IN (${candidates.map(() => '?').join(', ')})`);
        params.push(...candidates);
    }

    return (
        db
            .prepare(
                `
                  SELECT
                    symbol,
                    ticker_view_type,
                    market_cap_basic,
                    total_assets_fq,
                    total_equity_fq,
                    return_on_assets_fq,
                    return_on_equity_fq,
                    close,
                    saved_at
                  FROM stock_financial_cache
                  WHERE ${where.join(' OR ')}
                  ORDER BY market_cap_basic DESC, saved_at DESC
                  LIMIT 1
                `,
            )
            .get(...params) as LocalStockRow | undefined
    ) ?? null;
}

function lookupLocalEtfRow(db: DatabaseSync, symbolInput: string) {
    if (!hasTable(db, 'etf_constituent_aggregates')) return null;
    const candidates = buildLookupCandidates(symbolInput).filter((item) => !item.includes(':'));
    const exactCandidates = buildLookupCandidates(symbolInput).filter((item) => item.includes(':'));
    if (candidates.length === 0 && exactCandidates.length === 0) {
        return null;
    }

    const where: string[] = [];
    const params: string[] = [];
    if (exactCandidates.length > 0) {
        where.push(`etf_symbol IN (${exactCandidates.map(() => '?').join(', ')})`);
        params.push(...exactCandidates);
    }
    if (candidates.length > 0) {
        where.push(`substr(etf_symbol, instr(etf_symbol, ':') + 1) IN (${candidates.map(() => '?').join(', ')})`);
        params.push(...candidates);
    }

    return (
        db
            .prepare(
                `
                  SELECT
                    etf_symbol,
                    aggregate_date,
                    etf_aum,
                    etf_close
                  FROM etf_constituent_aggregates
                  WHERE ${where.join(' OR ')}
                  ORDER BY aggregate_date DESC
                  LIMIT 1
                `,
            )
            .get(...params) as LocalEtfRow | undefined
    ) ?? null;
}

function readLegacyLocalMarketSnapshot(baseDir: string, symbolInput: string) {
    const db = getAggregateDb(baseDir);
    if (!db) {
        return null;
    }

    const stockRow = lookupLocalStockRow(db, symbolInput);
    const etfRow = lookupLocalEtfRow(db, symbolInput);
    const stockViewType = String(stockRow?.ticker_view_type || '').trim().toLowerCase();
    const stockIsFund = stockViewType === 'fund' || stockViewType === 'etf';

    if (stockIsFund || etfRow) {
        const close = asNumber(stockRow?.close);
        const etfClose = asNumber(etfRow?.etf_close);
        const aum = asNumber(etfRow?.etf_aum);
        const snapshot: LocalMarketSnapshot = {
            kind: 'fund',
            symbol: String(etfRow?.etf_symbol || stockRow?.symbol || normalizeInputSymbol(symbolInput)),
            regularMarketPrice: Number.isFinite(close) ? close : Number.isFinite(etfClose) ? etfClose : null,
            navPrice: Number.isFinite(etfClose) ? etfClose : Number.isFinite(close) ? close : null,
            marketCap: null,
            sharesOutstanding: null,
            totalAssets: Number.isFinite(aum)
                ? aum
                : Number.isFinite(asNumber(stockRow?.total_assets_fq))
                  ? asNumber(stockRow?.total_assets_fq)
                  : null,
            totalEquity: Number.isFinite(aum)
                ? aum
                : Number.isFinite(asNumber(stockRow?.total_equity_fq))
                  ? asNumber(stockRow?.total_equity_fq)
                  : null,
            returnOnAssets: Number.isFinite(asNumber(stockRow?.return_on_assets_fq)) ? asNumber(stockRow?.return_on_assets_fq) : null,
            returnOnEquity: Number.isFinite(asNumber(stockRow?.return_on_equity_fq)) ? asNumber(stockRow?.return_on_equity_fq) : null,
            pointTime: etfRow
                ? parseAggregateDateToTime(etfRow.aggregate_date)
                : parseSavedAtToTime(stockRow?.saved_at),
        };
        return snapshot;
    }

    if (stockRow) {
        const close = asNumber(stockRow.close);
        const marketCap = asNumber(stockRow.market_cap_basic);
        const sharesOutstanding =
            Number.isFinite(marketCap) && Number.isFinite(close) && close > 0 ? marketCap / close : Number.NaN;
        const snapshot: LocalMarketSnapshot = {
            kind: 'stock',
            symbol: stockRow.symbol,
            regularMarketPrice: Number.isFinite(close) ? close : null,
            navPrice: null,
            marketCap: Number.isFinite(marketCap) ? marketCap : null,
            sharesOutstanding: Number.isFinite(sharesOutstanding) ? sharesOutstanding : null,
            totalAssets: Number.isFinite(asNumber(stockRow.total_assets_fq)) ? asNumber(stockRow.total_assets_fq) : null,
            totalEquity: Number.isFinite(asNumber(stockRow.total_equity_fq)) ? asNumber(stockRow.total_equity_fq) : null,
            returnOnAssets: Number.isFinite(asNumber(stockRow.return_on_assets_fq)) ? asNumber(stockRow.return_on_assets_fq) : null,
            returnOnEquity: Number.isFinite(asNumber(stockRow.return_on_equity_fq)) ? asNumber(stockRow.return_on_equity_fq) : null,
            pointTime: parseSavedAtToTime(stockRow.saved_at),
        };
        return snapshot;
    }

    if (etfRow) {
        const aum = asNumber(etfRow.etf_aum);
        const close = asNumber(etfRow.etf_close);
        const snapshot: LocalMarketSnapshot = {
            kind: 'fund',
            symbol: etfRow.etf_symbol,
            regularMarketPrice: Number.isFinite(close) ? close : null,
            navPrice: Number.isFinite(close) ? close : null,
            marketCap: null,
            sharesOutstanding: null,
            totalAssets: Number.isFinite(aum) ? aum : null,
            totalEquity: Number.isFinite(aum) ? aum : null,
            returnOnAssets: null,
            returnOnEquity: null,
            pointTime: parseAggregateDateToTime(etfRow.aggregate_date),
        };
        return snapshot;
    }

    return null;
}

export function readLocalMarketSnapshot(baseDir: string, symbolInput: string) {
    return readIndependentMarketSnapshot(baseDir, symbolInput);
}
