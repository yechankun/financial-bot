import fs from 'node:fs/promises';
import path from 'node:path';

import type { IndicatorPreset } from '../src/types';

const presetCodeCache = new Map<string, Promise<string>>();

export async function loadIndicatorPresetCode(baseDir: string, preset: IndicatorPreset) {
    const resolvedPath = path.resolve(baseDir, preset.sourcePath);
    const cached = presetCodeCache.get(resolvedPath);
    if (cached) {
        return cached;
    }

    const pending = fs.readFile(resolvedPath, 'utf8');
    presetCodeCache.set(resolvedPath, pending);

    try {
        return await pending;
    } catch (error) {
        presetCodeCache.delete(resolvedPath);
        throw error;
    }
}
