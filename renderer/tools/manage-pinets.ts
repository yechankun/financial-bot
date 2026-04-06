import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
    deleteCustomScript,
    deleteProfile,
    parseScriptReferenceList,
    readCustomScriptCode,
    readRegistry,
    upsertCustomScript,
    upsertProfile,
} from '../lib/pinets-registry';
import { INDICATOR_PRESETS } from '../src/presets';
import type { DataSource } from '../src/types';

function invariant(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function usage() {
    return `
Usage:
  bun run pinets:config -- scripts list
  bun run pinets:config -- scripts add --id my-rsi --file ./my-rsi.pine --label "My RSI"
  bun run pinets:config -- scripts update --id my-rsi --file ./my-rsi-v2.pine
  bun run pinets:config -- scripts delete --id my-rsi
  bun run pinets:config -- scripts show --id my-rsi
  bun run pinets:config -- profiles list
  bun run pinets:config -- profiles upsert --id trend-stack --items preset:ema-cross,custom:my-rsi
  bun run pinets:config -- profiles show --id trend-stack
  bun run pinets:config -- profiles delete --id trend-stack
`.trim();
}

function parseCli() {
    const parsed = parseArgs({
        options: {
            id: { type: 'string' },
            label: { type: 'string' },
            description: { type: 'string' },
            file: { type: 'string' },
            items: { type: 'string' },
            source: { type: 'string' },
            symbol: { type: 'string' },
            timeframe: { type: 'string' },
            limit: { type: 'string' },
            help: { type: 'boolean', short: 'h' },
        },
        allowPositionals: true,
    });

    if (parsed.values.help) {
        console.log(usage());
        process.exit(0);
    }

    const [scope, action] = parsed.positionals;
    invariant(scope === 'scripts' || scope === 'profiles', 'First positional must be scripts or profiles.');
    invariant(action, 'Second positional must be an action.');

    return {
        scope,
        action,
        values: parsed.values,
    };
}

async function listScripts(baseDir: string) {
    const registry = await readRegistry(baseDir);
    console.log(
        JSON.stringify(
            {
                presets: INDICATOR_PRESETS.map((item) => ({
                    id: item.id,
                    label: item.label,
                    description: item.description,
                })),
                custom: registry.scripts,
            },
            null,
            2,
        ),
    );
}

async function addOrUpdateScript(baseDir: string, values: Record<string, string | boolean | undefined>, action: string) {
    invariant(typeof values.id === 'string' && values.id, '--id is required.');
    invariant(typeof values.file === 'string' && values.file, '--file is required.');
    const code = await fs.readFile(path.resolve(baseDir, values.file), 'utf8');
    const result = await upsertCustomScript(baseDir, {
        id: values.id,
        label: typeof values.label === 'string' ? values.label : undefined,
        description: typeof values.description === 'string' ? values.description : undefined,
        code,
    });

    console.log(
        JSON.stringify(
            {
                action,
                script: result.record,
                file: result.absoluteFile,
            },
            null,
            2,
        ),
    );
}

async function showScript(baseDir: string, values: Record<string, string | boolean | undefined>) {
    invariant(typeof values.id === 'string' && values.id, '--id is required.');
    const result = await readCustomScriptCode(baseDir, values.id);
    console.log(
        JSON.stringify(
            {
                script: result.record,
                file: result.scriptPath,
                code: result.code,
            },
            null,
            2,
        ),
    );
}

async function removeScript(baseDir: string, values: Record<string, string | boolean | undefined>) {
    invariant(typeof values.id === 'string' && values.id, '--id is required.');
    const removed = await deleteCustomScript(baseDir, values.id);
    console.log(
        JSON.stringify(
            {
                action: 'delete',
                script: removed,
            },
            null,
            2,
        ),
    );
}

async function listProfiles(baseDir: string) {
    const registry = await readRegistry(baseDir);
    console.log(JSON.stringify({ profiles: registry.profiles }, null, 2));
}

async function upsertProfileCommand(baseDir: string, values: Record<string, string | boolean | undefined>) {
    invariant(typeof values.id === 'string' && values.id, '--id is required.');
    invariant(typeof values.items === 'string' && values.items, '--items is required.');
    const profile = await upsertProfile(baseDir, {
        id: values.id,
        label: typeof values.label === 'string' ? values.label : undefined,
        description: typeof values.description === 'string' ? values.description : undefined,
        items: parseScriptReferenceList(values.items),
        defaults: {
            source: values.source === 'binance' ? 'binance' : values.source === 'yahoo' ? ('yahoo' as DataSource) : undefined,
            symbol: typeof values.symbol === 'string' ? values.symbol : undefined,
            timeframe: typeof values.timeframe === 'string' ? values.timeframe : undefined,
            limit: typeof values.limit === 'string' ? Number(values.limit) : undefined,
        },
    });

    console.log(
        JSON.stringify(
            {
                action: 'upsert',
                profile,
            },
            null,
            2,
        ),
    );
}

async function showProfile(baseDir: string, values: Record<string, string | boolean | undefined>) {
    invariant(typeof values.id === 'string' && values.id, '--id is required.');
    const registry = await readRegistry(baseDir);
    const profile = registry.profiles.find((item) => item.id === values.id || item.id === values.id.toLowerCase());
    invariant(profile, `Chart profile not found: ${values.id}`);
    console.log(JSON.stringify({ profile }, null, 2));
}

async function removeProfile(baseDir: string, values: Record<string, string | boolean | undefined>) {
    invariant(typeof values.id === 'string' && values.id, '--id is required.');
    const removed = await deleteProfile(baseDir, values.id);
    console.log(
        JSON.stringify(
            {
                action: 'delete',
                profile: removed,
            },
            null,
            2,
        ),
    );
}

async function main() {
    const baseDir = process.cwd();
    const cli = parseCli();

    if (cli.scope === 'scripts') {
        if (cli.action === 'list') return listScripts(baseDir);
        if (cli.action === 'add' || cli.action === 'update') return addOrUpdateScript(baseDir, cli.values, cli.action);
        if (cli.action === 'show') return showScript(baseDir, cli.values);
        if (cli.action === 'delete') return removeScript(baseDir, cli.values);
    }

    if (cli.scope === 'profiles') {
        if (cli.action === 'list') return listProfiles(baseDir);
        if (cli.action === 'upsert') return upsertProfileCommand(baseDir, cli.values);
        if (cli.action === 'show') return showProfile(baseDir, cli.values);
        if (cli.action === 'delete') return removeProfile(baseDir, cli.values);
    }

    throw new Error(`Unsupported command: ${cli.scope} ${cli.action}`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
