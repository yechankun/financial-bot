import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CACHE_ROOT_DIR = path.join('.pinets', 'cache');
const CACHE_DB_FILENAME = 'renderer-cache.sqlite3';
const LEGACY_MIGRATION_KEY = 'legacy_cache_migration_v1';

const dbCache = new Map<string, DatabaseSync>();
const dbPromiseCache = new Map<string, Promise<{ db: DatabaseSync; dbPath: string }>>();

export type YahooCacheTable =
    | 'yahoo_snapshot_cache'
    | 'yahoo_splits_cache'
    | 'yahoo_financials_cache';

export type YahooChartCacheRow<T> = {
    payload: T;
    cacheVersion: number | null;
};

function escapeSqlitePath(input: string) {
    return input.replaceAll("'", "''");
}

async function ensureCacheRoot(baseDir: string) {
    const cacheRoot = path.resolve(baseDir, CACHE_ROOT_DIR);
    await fs.mkdir(cacheRoot, { recursive: true });
    return cacheRoot;
}

async function pathExists(targetPath: string) {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

function createSchema(db: DatabaseSync) {
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS cache_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS yahoo_snapshot_cache (
            symbol TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            cache_version INTEGER,
            fetched_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS yahoo_splits_cache (
            symbol TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            cache_version INTEGER,
            fetched_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS yahoo_financials_cache (
            symbol TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            cache_version INTEGER,
            fetched_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS yahoo_chart_cache (
            cache_key TEXT PRIMARY KEY,
            symbol TEXT NOT NULL,
            interval TEXT NOT NULL,
            range_value TEXT NOT NULL,
            payload TEXT NOT NULL,
            cache_version INTEGER,
            fetched_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS yahoo_chart_cache_symbol_idx
            ON yahoo_chart_cache(symbol, interval, range_value, expires_at DESC);
        CREATE TABLE IF NOT EXISTS finra_file_state (
            date TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            fetched_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS finra_daily (
            date TEXT NOT NULL,
            symbol TEXT NOT NULL,
            short_volume INTEGER NOT NULL,
            short_exempt_volume INTEGER NOT NULL,
            total_volume INTEGER NOT NULL,
            market TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (date, symbol)
        );
        CREATE INDEX IF NOT EXISTS finra_daily_symbol_date_idx
            ON finra_daily(symbol, date DESC);
    `);
}

async function migrateLegacyFinraDb(baseDir: string, db: DatabaseSync, dbPath: string) {
    const legacyDbPath = path.resolve(baseDir, '.pinets', 'cache', 'finra', 'finra.sqlite3');
    if (legacyDbPath === dbPath || !(await pathExists(legacyDbPath))) return;

    const attachedName = 'legacy_finra';
    db.exec(`ATTACH DATABASE '${escapeSqlitePath(legacyDbPath)}' AS ${attachedName};`);
    try {
        db.exec(`
            INSERT OR IGNORE INTO finra_file_state(date, status, fetched_at)
            SELECT date, status, fetched_at FROM ${attachedName}.finra_file_state;

            INSERT OR IGNORE INTO finra_daily(date, symbol, short_volume, short_exempt_volume, total_volume, market)
            SELECT date, symbol, short_volume, short_exempt_volume, total_volume, market
            FROM ${attachedName}.finra_daily;
        `);
    } finally {
        db.exec(`DETACH DATABASE ${attachedName};`);
    }
}

async function migrateLegacyYahooFiles(baseDir: string, db: DatabaseSync) {
    const legacyDir = path.resolve(baseDir, '.pinets', 'cache', 'yahoo');
    if (!(await pathExists(legacyDir))) return;

    const entries = await fs.readdir(legacyDir, { withFileTypes: true });
    const records: Array<{
        table: YahooCacheTable;
        symbol: string;
        payload: string;
        cacheVersion: number | null;
        fetchedAt: number;
        expiresAt: number;
    }> = [];

    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const match = entry.name.match(/^(.*)-(snapshot|splits|financials)\.json$/);
        if (!match) continue;

        const symbol = match[1].trim().toUpperCase();
        const kind = match[2];
        const fullPath = path.join(legacyDir, entry.name);
        const [stats, payload] = await Promise.all([
            fs.stat(fullPath),
            fs.readFile(fullPath, 'utf8'),
        ]);

        let parsed: unknown = null;
        try {
            parsed = JSON.parse(payload);
        } catch {
            continue;
        }

        const cacheVersion =
            parsed && typeof parsed === 'object' && 'cacheVersion' in parsed && typeof parsed.cacheVersion === 'number'
                ? parsed.cacheVersion
                : null;
        const fetchedAt = Math.trunc(stats.mtimeMs);
        const ttlMs =
            kind === 'splits'
                ? 7 * 24 * 60 * 60 * 1000
                : 12 * 60 * 60 * 1000;
        const expiresAt = fetchedAt + ttlMs;
        const table =
            kind === 'snapshot'
                ? 'yahoo_snapshot_cache'
                : kind === 'splits'
                  ? 'yahoo_splits_cache'
                  : 'yahoo_financials_cache';

        records.push({
            table,
            symbol,
            payload,
            cacheVersion,
            fetchedAt,
            expiresAt,
        });
    }

    if (records.length === 0) return;

    db.exec('BEGIN IMMEDIATE');
    try {
        const statements = new Map<YahooCacheTable, ReturnType<DatabaseSync['prepare']>>();
        for (const record of records) {
            let statement = statements.get(record.table);
            if (!statement) {
                statement = db.prepare(
                    `
                        INSERT INTO ${record.table}(symbol, payload, cache_version, fetched_at, expires_at)
                        VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(symbol) DO UPDATE SET
                          payload=excluded.payload, cache_version=excluded.cache_version,
                          fetched_at=excluded.fetched_at, expires_at=excluded.expires_at
                        WHERE excluded.fetched_at > ${record.table}.fetched_at
                    `,
                );
                statements.set(record.table, statement);
            }
            statement.run(
                record.symbol,
                record.payload,
                record.cacheVersion,
                record.fetchedAt,
                record.expiresAt,
            );
        }
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

async function migrateLegacyCaches(baseDir: string, db: DatabaseSync, dbPath: string) {
    const existing = db.prepare('SELECT value FROM cache_meta WHERE key = ?').get(LEGACY_MIGRATION_KEY) as { value: string } | undefined;
    if (existing?.value === 'done') return;

    await migrateLegacyFinraDb(baseDir, db, dbPath);
    await migrateLegacyYahooFiles(baseDir, db);
    db.prepare('INSERT OR REPLACE INTO cache_meta(key, value) VALUES (?, ?)').run(LEGACY_MIGRATION_KEY, 'done');
    // Retain legacy sources: copying a live SQLite file loses WAL data, and deleting
    // its directory can destroy another process's active cache.
}

export async function getRendererCacheDb(baseDir: string) {
    const cacheRoot = await ensureCacheRoot(baseDir);
    const dbPath = path.join(cacheRoot, CACHE_DB_FILENAME);
    const cached = dbCache.get(dbPath);
    if (cached) return { db: cached, dbPath };
    const pending = dbPromiseCache.get(dbPath);
    if (pending) return pending;

    const opening = (async () => {
        const db = new DatabaseSync(dbPath);
        db.exec('PRAGMA busy_timeout = 5000;');
        try {
            createSchema(db);
            await migrateLegacyCaches(baseDir, db, dbPath);
            dbCache.set(dbPath, db);
            return { db, dbPath };
        } catch (error) {
            db.close();
            throw error;
        }
    })();

    dbPromiseCache.set(dbPath, opening);
    try {
        const result = await opening;
        dbPromiseCache.delete(dbPath);
        return result;
    } catch (error) {
        dbPromiseCache.delete(dbPath);
        throw error;
    }
}

export async function readYahooCache<T>(
    baseDir: string,
    table: YahooCacheTable,
    symbol: string,
): Promise<{ payload: T; cacheVersion: number | null } | null> {
    const { db } = await getRendererCacheDb(baseDir);
    const now = Date.now();
    const row = db.prepare(
        `
            SELECT payload, cache_version AS cacheVersion
            FROM ${table}
            WHERE symbol = ?
              AND expires_at >= ?
        `,
    ).get(symbol, now) as { payload: string; cacheVersion: number | null } | undefined;
    if (!row) return null;

    try {
        return {
            payload: JSON.parse(row.payload) as T,
            cacheVersion: row.cacheVersion,
        };
    } catch {
        return null;
    }
}

export async function writeYahooCache(
    baseDir: string,
    table: YahooCacheTable,
    symbol: string,
    payload: unknown,
    ttlMs: number,
    cacheVersion: number | null = null,
) {
    const { db } = await getRendererCacheDb(baseDir);
    const now = Date.now();
    db.prepare(
        `
            INSERT OR REPLACE INTO ${table}(symbol, payload, cache_version, fetched_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
        `,
    ).run(symbol, JSON.stringify(payload), cacheVersion, now, now + ttlMs);
}

export async function readYahooChartCache<T>(
    baseDir: string,
    cacheKey: string,
): Promise<YahooChartCacheRow<T> | null> {
    const { db } = await getRendererCacheDb(baseDir);
    const now = Date.now();
    const row = db.prepare(
        `
            SELECT payload, cache_version AS cacheVersion
            FROM yahoo_chart_cache
            WHERE cache_key = ?
              AND expires_at >= ?
        `,
    ).get(cacheKey, now) as { payload: string; cacheVersion: number | null } | undefined;
    if (!row) return null;

    try {
        return {
            payload: JSON.parse(row.payload) as T,
            cacheVersion: row.cacheVersion,
        };
    } catch {
        return null;
    }
}

export async function writeYahooChartCache(
    baseDir: string,
    options: {
        cacheKey: string;
        symbol: string;
        interval: string;
        range: string;
        payload: unknown;
        ttlMs: number;
        cacheVersion?: number | null;
    },
) {
    const { db } = await getRendererCacheDb(baseDir);
    const now = Date.now();
    db.prepare(
        `
            INSERT OR REPLACE INTO yahoo_chart_cache(
                cache_key,
                symbol,
                interval,
                range_value,
                payload,
                cache_version,
                fetched_at,
                expires_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
    ).run(
        options.cacheKey,
        options.symbol,
        options.interval,
        options.range,
        JSON.stringify(options.payload),
        options.cacheVersion ?? null,
        now,
        now + options.ttlMs,
    );
}
