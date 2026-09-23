import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, beforeEach, test } from 'node:test';
import { backfillFinraDates } from '../lib/finra';
import { getRendererCacheDb } from '../lib/cache-db';
import { readLocalMarketSnapshot } from '../lib/market-cache-db';
import { fetchYahooText, normalizeYahooLookupSymbol } from '../lib/yahoo';
import { normalizeYahooSymbol, runPineOnCandles } from '../lib/pine-workbench';
import { renderSvg } from '../tools/render-pinets';
import { Resvg } from '@resvg/resvg-js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'financial-renderer-test-'));
const originalFetch = globalThis.fetch;
let baseDir: string;
beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(root, 'case-'));
  delete process.env.INTERNAL_DATA_DIR;
  delete process.env.INTERNAL_RUNTIME_ROOT_DIR;
  delete process.env.BOT_RUNTIME_ROOT_DIR;
  process.env.BOT_DATA_DIR = path.join(baseDir, 'data');
  globalThis.fetch = async () => { throw new Error('Unexpected network call during offline test'); };
});
after(async () => { globalThis.fetch = originalFetch; await fs.rm(root, { recursive: true, force: true }); });

const finraText = (date: string) => `Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market\n${date}|AAPL|12|1|100|B,Q,N\n`;

test('FINRA 404/holiday-403 cache expires and malformed responses never poison the cache', async () => {
  let requests = 0;
  globalThis.fetch = async (_input, init) => { requests++; assert.ok(init?.signal); return new Response('', { status: 404 }); };
  await backfillFinraDates(baseDir, ['20260910']);
  await backfillFinraDates(baseDir, ['20260910']);
  assert.equal(requests, 1);
  const { db } = await getRendererCacheDb(baseDir);
  db.prepare('UPDATE finra_file_state SET fetched_at = 0').run();
  globalThis.fetch = async () => { requests++; return new Response(finraText('20260910')); };
  await backfillFinraDates(baseDir, ['20260910']);
  assert.equal(requests, 2);
  assert.equal(db.prepare('SELECT short_volume FROM finra_daily WHERE symbol = ?').get('AAPL')?.short_volume, 12);
  globalThis.fetch = async () => new Response('', { status: 403 });
  await backfillFinraDates(baseDir, ['20260909']);
  db.prepare('UPDATE finra_file_state SET fetched_at = 0 WHERE date = ?').run('20260909');
  globalThis.fetch = async () => new Response(finraText('20260909'));
  await backfillFinraDates(baseDir, ['20260909']);
  assert.equal(db.prepare('SELECT status FROM finra_file_state WHERE date = ?').get('20260909')?.status, 'ready');
  globalThis.fetch = async () => new Response('<html>unavailable</html>');
  await assert.rejects(backfillFinraDates(baseDir, ['20260908']), /incomplete/);
  assert.equal(db.prepare('SELECT status FROM finra_file_state WHERE date = ?').get('20260908'), undefined);
});

test('overlapping FINRA requests share fetches and retain good dates when another date fails', async () => {
  const counts = new Map<string, number>();
  globalThis.fetch = async (input) => {
    const date = String(input).match(/shvol(\d+)\.txt/)![1];
    counts.set(date, (counts.get(date) || 0) + 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return date === '20260909' ? new Response('', { status: 503 }) : new Response(finraText(date));
  };
  const results = await Promise.allSettled([
    backfillFinraDates(baseDir, ['20260910', '20260909']),
    backfillFinraDates(baseDir, ['20260910']),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(counts.get('20260910'), 1);
  const { db } = await getRendererCacheDb(baseDir);
  assert.equal(db.prepare('SELECT status FROM finra_file_state WHERE date = ?').get('20260910')?.status, 'ready');
});

async function stockDatabase(target: string, close: number | null = null) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  db.exec(`CREATE TABLE dataset_manifests(dataset_version TEXT,status TEXT);
    CREATE TABLE published_datasets(dataset_name TEXT,dataset_version TEXT);
    CREATE TABLE read_listings(dataset_version TEXT,listing_id TEXT,security_id TEXT,company_id TEXT,ticker TEXT,security_type TEXT,security_name TEXT,company_name TEXT,cik TEXT,currency TEXT,fund_id TEXT);
    CREATE TABLE read_financial_facts(dataset_version TEXT,fact_id TEXT,company_id TEXT,standard_item TEXT,period_end TEXT,filed_at TEXT,currency TEXT,unit TEXT,value REAL);
    CREATE TABLE read_price_facts(dataset_version TEXT,price_fact_id TEXT,listing_id TEXT,price_time TEXT,close REAL,market_cap REAL,shares_outstanding REAL,currency TEXT);
    CREATE TABLE read_fund_facts(dataset_version TEXT,fund_id TEXT,fact_type TEXT,as_of_date TEXT,value REAL);
    INSERT INTO dataset_manifests VALUES('d1','published');
    INSERT INTO published_datasets VALUES('market','d1');
    INSERT INTO read_listings VALUES('d1','lst:aapl','sec:aapl','cik:1','AAPL','common_stock','Apple Inc','Apple Inc','1','USD',NULL);`);
  if (close != null) db.prepare("INSERT INTO read_price_facts VALUES('d1','px','lst:aapl','2026-09-10T00:00:00Z',?,NULL,NULL,'USD')").run(close);
  return db;
}

test('local DB honors BOT_DATA_DIR, preserves NULL, and observes updates and file replacements', async () => {
  const dbPath = path.join(process.env.BOT_DATA_DIR!, 'market_read_model.sqlite3');
  assert.equal(readLocalMarketSnapshot(baseDir, 'AAPL'), null);
  const db = await stockDatabase(dbPath);
  const first = readLocalMarketSnapshot(baseDir, 'AAPL')!;
  assert.equal(first.totalAssets, null);
  assert.equal(first.returnOnAssets, null);
  assert.equal(first.regularMarketPrice, null);
  db.exec(`INSERT INTO read_price_facts VALUES('d1','px','lst:aapl','2026-09-10T00:00:00Z',100,NULL,NULL,'USD');
    INSERT INTO read_financial_facts VALUES('d1','assets','cik:1','assets','2025-12-31','2026-02-01','USD','USD',100);
    INSERT INTO read_financial_facts VALUES('d1','income','cik:1','net_income_common','2025-12-31','2026-02-01','USD','USD',0);`);
  assert.equal(readLocalMarketSnapshot(baseDir, 'AAPL')?.regularMarketPrice, 100);
  assert.equal(readLocalMarketSnapshot(baseDir, 'AAPL')?.returnOnAssets, 0);
  db.close();
  const replacement = `${dbPath}.new`;
  const next = await stockDatabase(replacement, 200);
  next.close();
  await fs.rename(replacement, dbPath);
  assert.equal(readLocalMarketSnapshot(baseDir, 'AAPL')?.regularMarketPrice, 200);
});

test('ETF-only databases are supported without a stock table', async () => {
  const dbPath = path.join(process.env.BOT_DATA_DIR!, 'market_read_model.sqlite3');
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE dataset_manifests(dataset_version TEXT,status TEXT);
    CREATE TABLE published_datasets(dataset_name TEXT,dataset_version TEXT);
    CREATE TABLE read_listings(dataset_version TEXT,listing_id TEXT,security_id TEXT,company_id TEXT,ticker TEXT,security_type TEXT,security_name TEXT,company_name TEXT,cik TEXT,currency TEXT,fund_id TEXT);
    CREATE TABLE read_financial_facts(dataset_version TEXT,fact_id TEXT,company_id TEXT,standard_item TEXT,period_end TEXT,filed_at TEXT,currency TEXT,unit TEXT,value REAL);
    CREATE TABLE read_price_facts(dataset_version TEXT,price_fact_id TEXT,listing_id TEXT,price_time TEXT,close REAL,market_cap REAL,shares_outstanding REAL,currency TEXT);
    CREATE TABLE read_fund_facts(dataset_version TEXT,fund_id TEXT,fact_type TEXT,as_of_date TEXT,value REAL);
    INSERT INTO dataset_manifests VALUES('d1','published');
    INSERT INTO published_datasets VALUES('market','d1');
    INSERT INTO read_listings VALUES('d1','lst:spy','sec:spy',NULL,'SPY','etf','SPDR S&P 500 ETF','', '', 'USD','US:SPY');
    INSERT INTO read_price_facts VALUES('d1','px','lst:spy','2026-09-10T00:00:00Z',500,NULL,NULL,'USD');`);
  const snapshot = readLocalMarketSnapshot(baseDir, 'SPY');
  assert.equal(snapshot?.kind, 'fund');
  assert.equal(snapshot?.totalAssets, null);
  assert.equal(snapshot?.regularMarketPrice, 500);
  db.close();
});

test('legacy FINRA migration reads WAL data and retains the source database', async () => {
  const legacyPath = path.join(baseDir, '.pinets', 'cache', 'finra', 'finra.sqlite3');
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`PRAGMA journal_mode=WAL;
    PRAGMA wal_autocheckpoint=0;
    CREATE TABLE finra_file_state(date TEXT PRIMARY KEY,status TEXT,fetched_at INTEGER);
    CREATE TABLE finra_daily(date TEXT,symbol TEXT,short_volume INTEGER,short_exempt_volume INTEGER,total_volume INTEGER,market TEXT,PRIMARY KEY(date,symbol));
    INSERT INTO finra_file_state VALUES('20260910','ready',100);
    INSERT INTO finra_daily VALUES('20260910','AAPL',12,1,100,'Q');`);
  const { db } = await getRendererCacheDb(baseDir);
  assert.equal(db.prepare('SELECT short_volume FROM finra_daily').get()?.short_volume, 12);
  assert.ok(await fs.stat(legacyPath));
  legacy.close();
});

test('Yahoo requests carry a deadline', async () => {
  globalThis.fetch = async (_input, init) => { assert.ok(init?.signal); return new Response('fixture'); };
  assert.equal(await fetchYahooText('https://fixture.invalid'), 'fixture');
});

test('RSI and EMA execute deterministically with supplied candles and no network', async () => {
  const candles = Array.from({ length: 160 }, (_, i) => ({
    openTime: Date.UTC(2025, 0, 1) + i * 86400000, closeTime: Date.UTC(2025, 0, 2) + i * 86400000 - 1,
    open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 100000 + i,
  }));
  for (const preset of ['rsi', 'ema-cross']) {
    const code = await fs.readFile(new URL(`../presets/${preset}.pine`, import.meta.url), 'utf8');
    const result = await runPineOnCandles(candles, code, {
      source: 'yahoo', timeframe: 'D', primaryYahooSnapshot: null,
      primaryYahooSplits: [], primaryYahooFinancials: null, primaryFinraCandles: [],
    });
    const last = (title: string) => result.series.find((series) => series.title === title)!.data.at(-1)!.value;
    if (preset === 'rsi') assert.equal(last('RSI'), 100);
    else { assert.equal(last('EMA 9'), 256); assert.equal(last('EMA 21'), 250); }
    assert.deepEqual(result.warnings, []);
    const svg = renderSvg('FIXTURE', 'D', candles, result.series, result.lines, result.markers);
    const png = new Resvg(svg).render().asPng();
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.ok(png.length > 1000);
  }
});

test('share-class suffixes become dashes but exchange suffixes keep their dot', () => {
  const cases: Array<[string, string]> = [
    ['BRK.B', 'BRK-B'], ['bf.b', 'BF-B'], ['RELIANCE.NS', 'RELIANCE.NS'], ['SHOP.TO', 'SHOP.TO'],
    ['VOD.L', 'VOD.L'], ['SAP.DE', 'SAP.DE'], ['7203.T', '7203.T'], ['005930.KS', '005930.KS'],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeYahooSymbol(input), expected, input);
  assert.equal(normalizeYahooLookupSymbol('NYSE:BRK.B'), 'BRK-B');
  assert.equal(normalizeYahooLookupSymbol('NSE:RELIANCE.NS'), 'RELIANCE.NS');
});
