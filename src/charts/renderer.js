import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { config } from "../config.js";

function normalizeListingMarket(value) {
  return String(value || "").trim().toUpperCase();
}

function sanitizeProcessOutput(value) {
  return String(value || "")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return false;
      }
      if (trimmed.includes("ExperimentalWarning: SQLite is an experimental feature")) {
        return false;
      }
      if (trimmed.includes("Use `node --trace-warnings")) {
        return false;
      }
      return true;
    })
    .join("\n")
    .trim();
}

export function normalizeYahooSymbol(row = {}) {
  const explicit = String(row.yahoo_symbol || "").trim();
  if (explicit) {
    return explicit;
  }

  const tvSymbol = String(row.tv_symbol || row.symbol || "").trim();
  if (!tvSymbol) {
    return "";
  }

  const parts = tvSymbol.split(":");
  const market = normalizeListingMarket(row.listing_market || parts[0] || "");
  const raw = String(parts.at(-1) || "").trim();
  if (!raw) {
    return "";
  }

  if (raw.includes(".")) {
    return raw;
  }

  if (market === "KOSPI" || market === "KRX" || market === "KSE") {
    return `${raw}.KS`;
  }

  if (market === "KOSDAQ") {
    return `${raw}.KQ`;
  }

  if (market === "NSE") {
    return `${raw}.NS`;
  }

  if (market === "BSE" || market === "BOM") {
    return `${raw}.BO`;
  }

  return raw;
}

function uniqueStrings(items) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function getRendererDir() {
  const preferred = path.join(config.workspaceDir, "renderer");
  if (fsSync.existsSync(path.join(preferred, "tools", "render-pinets.ts"))) {
    return preferred;
  }

  return preferred;
}

function normalizeInputSymbols(symbols = []) {
  return uniqueStrings(
    symbols.map((symbol) => {
      if (symbol && typeof symbol === "object") {
        return normalizeYahooSymbol(symbol);
      }
      return String(symbol || "").trim();
    }),
  );
}

export async function loadCandidateTickers(candidateTickersJsonPath) {
  const raw = await fs.readFile(candidateTickersJsonPath, "utf8");
  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];

  const explicitTickers = Array.isArray(parsed?.tickers)
    ? parsed.tickers.map((ticker) => ({ yahoo_symbol: ticker }))
    : [];

  const symbols = uniqueStrings([...rows, ...explicitTickers].map((row) => normalizeYahooSymbol(row)));

  if (symbols.length === 0) {
    throw new Error("차트 생산에 쓸 후보 티커가 없다냥.");
  }

  return {
    symbols,
    rows
  };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

export async function renderRendererBatch({
  symbols,
  outRoot,
  source = "yahoo",
  timeframes = ["D", "W"],
  profile = "",
  outputs = [],
  concurrency = config.chartRenderConcurrency,
}) {
  const normalizedSymbols = normalizeInputSymbols(symbols);
  if (normalizedSymbols.length === 0) {
    throw new Error("차트 생산에 쓸 후보 티커가 없다냥.");
  }

  await fs.mkdir(outRoot, { recursive: true });

  const args = [
    "run",
    "render",
    "--",
    "--source",
    String(source || "yahoo"),
    "--symbols",
    normalizedSymbols.join(","),
    "--timeframes",
    uniqueStrings(timeframes).join(","),
    "--out-root",
    outRoot,
    "--concurrency",
    String(Math.max(1, Number(concurrency) || 1)),
  ];

  if (String(profile || "").trim()) {
    args.push("--profile", String(profile).trim());
  }

  const outputList = uniqueStrings(outputs);
  if (outputList.length > 0) {
    args.push("--outputs", outputList.join(","));
  }

  const result = await runProcess("npm", args, {
    cwd: getRendererDir(),
  });

  const sanitizedStdout = sanitizeProcessOutput(result.stdout);
  const sanitizedStderr = sanitizeProcessOutput(result.stderr);
  const manifestPath = path.join(outRoot, "manifest.json");

  const tryReadManifest = async () => {
    try {
      const manifestRaw = await fs.readFile(manifestPath, "utf8");
      return JSON.parse(manifestRaw);
    } catch {
      return null;
    }
  };

  if (result.code !== 0) {
    const manifest = await tryReadManifest();
    if (manifest) {
      return {
        symbols: normalizedSymbols,
        timeframes: uniqueStrings(timeframes),
        manifestPath,
        manifest,
        stdout: sanitizedStdout,
        stderr: sanitizedStderr,
        exitCode: result.code,
      };
    }

    throw new Error(
      sanitizedStderr || sanitizedStdout || `차트 생산이 ${result.code} 코드로 끝났다냥.`,
    );
  }

  const manifestRaw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw);

  return {
    symbols: normalizedSymbols,
    timeframes: uniqueStrings(timeframes),
    manifestPath,
    manifest,
    stdout: sanitizedStdout,
    stderr: sanitizedStderr,
    exitCode: result.code,
  };
}

export async function renderCandidateCharts({
  candidateTickersJsonPath,
  outRoot,
  timeframes = ["D", "W"]
}) {
  const { symbols } = await loadCandidateTickers(candidateTickersJsonPath);
  await fs.mkdir(outRoot, { recursive: true });

  const result = await runProcess(
    "python3",
    [
      config.chartRenderScriptPath,
      "--symbols",
      symbols.join(","),
      "--timeframes",
      timeframes.join(","),
      "--out-root",
      outRoot,
      "--concurrency",
      String(Math.max(1, Number(config.chartRenderConcurrency) || 1)),
    ],
    {
      cwd: config.workspaceDir
    }
  );

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `차트 생산이 ${result.code} 코드로 끝났다냥.`);
  }

  const manifestPath = path.join(outRoot, "manifest.json");
  const manifestRaw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw);

  return {
    symbols,
    timeframes,
    manifestPath,
    manifest,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}
