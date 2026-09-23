import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fromYahooShareClassSymbol, toYahooShareClassSymbol } from './symbols';

export type IndependentMarketSnapshot = {
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

const READ_MODEL_DB_BASENAME = 'market_read_model.sqlite3';
const handles = new Map<string, { db: DatabaseSync; dev: number; ino: number }>();

function candidatePaths(baseDir: string) {
    const explicit = process.env.MARKET_READ_MODEL_DB_PATH;
    if (explicit) return [path.resolve(explicit)];
    const dataDir = process.env.INTERNAL_DATA_DIR || process.env.BOT_DATA_DIR;
    if (dataDir) return [path.resolve(dataDir, READ_MODEL_DB_BASENAME)];
    const runtime = process.env.INTERNAL_RUNTIME_ROOT_DIR || process.env.BOT_RUNTIME_ROOT_DIR;
    if (runtime) return [path.resolve(runtime, 'data', READ_MODEL_DB_BASENAME)];
    return [
        path.resolve(baseDir, '..', 'data', READ_MODEL_DB_BASENAME),
        path.resolve(baseDir, '..', '..', 'data', READ_MODEL_DB_BASENAME),
        path.resolve(process.cwd(), 'data', READ_MODEL_DB_BASENAME),
        path.resolve(process.cwd(), '..', 'data', READ_MODEL_DB_BASENAME),
    ];
}

function readModelDb(baseDir: string) {
    for (const candidate of candidatePaths(baseDir)) {
        try {
            const stat = fs.statSync(candidate);
            if (!stat.isFile() || stat.size <= 0) continue;
            const cached = handles.get(candidate);
            if (cached?.dev === stat.dev && cached?.ino === stat.ino) return cached.db;
            if (cached) { cached.db.close(); handles.delete(candidate); }
            const db = new DatabaseSync(candidate, { readOnly: true });
            db.exec('PRAGMA query_only=1');
            const valid = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='read_price_facts'").get() as { ok?: number } | undefined;
            if (valid?.ok === 1) {
                handles.set(candidate, { db, dev: stat.dev, ino: stat.ino });
                return db;
            }
            db.close();
        } catch {}
    }
    return null;
}

function normalize(value: string) {
    return String(value || '').trim().toUpperCase().replace(/^FINRA:/, '')
        .replace(/_(SHORT_VOLUME|SHORT_EXEMPT_VOLUME|TOTAL_VOLUME|SHORT_RATIO)$/, '');
}

function candidates(value: string) {
    const direct = normalize(value);
    const suffix = direct.split(':').at(-1) || direct;
    const dotted = fromYahooShareClassSymbol(suffix);
    const alternate = dotted !== suffix ? dotted : toYahooShareClassSymbol(suffix);
    return [...new Set([direct, suffix, alternate].filter(Boolean))];
}

function epoch(value: unknown) {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : 0;
}

export function readIndependentMarketSnapshot(baseDir: string, symbolInput: string): IndependentMarketSnapshot | null {
    const db = readModelDb(baseDir);
    if (!db) return null;
    const dataset = db.prepare(`
      SELECT m.dataset_version FROM published_datasets p
      JOIN dataset_manifests m USING(dataset_version)
      WHERE p.dataset_name='market' AND m.status='published'
    `).get() as { dataset_version?: string } | undefined;
    if (!dataset?.dataset_version) return null;
    const symbols = candidates(symbolInput);
    if (!symbols.length) return null;
    const row = db.prepare(`
      SELECT * FROM read_listings
      WHERE dataset_version=? AND UPPER(ticker) IN (${symbols.map(() => '?').join(',')})
      ORDER BY CASE WHEN UPPER(ticker)=? THEN 0 ELSE 1 END LIMIT 1
    `).get(dataset.dataset_version, ...symbols, normalize(symbolInput).split(':').at(-1)) as Record<string, unknown> | undefined;
    if (!row) return null;
    const price = db.prepare(`
      SELECT * FROM read_price_facts WHERE dataset_version=? AND listing_id=? LIMIT 1
    `).get(dataset.dataset_version, row.listing_id) as Record<string, unknown> | undefined;
    const facts = row.company_id ? db.prepare(`
      SELECT * FROM read_financial_facts WHERE dataset_version=? AND company_id=?
    `).all(dataset.dataset_version, row.company_id) as Array<Record<string, unknown>> : [];
    const byName = new Map(facts.map((fact) => [String(fact.standard_item), fact]));
    const assets = byName.get('assets');
    const equity = byName.get('equity_common');
    const income = byName.get('net_income_common');
    const shares = byName.get('shares_outstanding');
    const samePeriod = (left?: Record<string, unknown>, right?: Record<string, unknown>) =>
        Boolean(left && right && String(left.period_end) === String(right.period_end)
            && String(left.currency || left.unit) === String(right.currency || right.unit));
    const incomeValue = Number(income?.value);
    const assetsValue = Number(assets?.value);
    const equityValue = Number(equity?.value);
    const aum = row.fund_id ? db.prepare(`
      SELECT * FROM read_fund_facts
      WHERE dataset_version=? AND fund_id=? AND fact_type='aum' LIMIT 1
    `).get(dataset.dataset_version, row.fund_id) as Record<string, unknown> | undefined : undefined;
    const close = Number(price?.close);
    const marketCap = Number(price?.market_cap);
    const sharesValue = Number(price?.shares_outstanding ?? shares?.value);
    const isFund = String(row.security_type) === 'etf';
    return {
        kind: isFund ? 'fund' : 'stock',
        symbol: String(row.ticker || symbolInput),
        regularMarketPrice: Number.isFinite(close) ? close : null,
        navPrice: null,
        marketCap: Number.isFinite(marketCap) ? marketCap : null,
        sharesOutstanding: Number.isFinite(sharesValue) ? sharesValue : null,
        totalAssets: isFund && Number.isFinite(Number(aum?.value))
            ? Number(aum?.value) : Number.isFinite(assetsValue) ? assetsValue : null,
        totalEquity: isFund && Number.isFinite(Number(aum?.value))
            ? Number(aum?.value) : Number.isFinite(equityValue) ? equityValue : null,
        returnOnAssets: samePeriod(income, assets) && Number.isFinite(incomeValue) && assetsValue > 0
            ? incomeValue / assetsValue : null,
        returnOnEquity: samePeriod(income, equity) && Number.isFinite(incomeValue) && equityValue > 0
            ? incomeValue / equityValue : null,
        pointTime: Math.max(epoch(price?.price_time), epoch(income?.filed_at), epoch(aum?.as_of_date)),
    };
}
