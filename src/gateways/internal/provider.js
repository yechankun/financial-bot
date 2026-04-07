import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const requestedMode = String(
  process.env.INTERNAL_PROVIDER_MODE || "auto",
).trim().toLowerCase();
const packageSpecifier = String(
  process.env.INTERNAL_PROVIDER_PACKAGE || "financial-bot-internal",
).trim();

async function importPackageProvider(specifier) {
  if (!specifier) {
    throw new Error("Missing internal package specifier.");
  }

  if (path.isAbsolute(specifier)) {
    return import(pathToFileURL(specifier).href);
  }

  if (specifier.startsWith(".")) {
    return import(pathToFileURL(path.resolve(process.cwd(), specifier)).href);
  }

  return import(specifier);
}

async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveSiblingPackageEntry() {
  const candidates = [
    path.resolve(process.cwd(), "../financial-bot-internal/src/index.js"),
    path.resolve(process.cwd(), "../financial-discord-bot-internal/src/index.js"),
    path.resolve(process.cwd(), "../financial-dicord-bot-internal/src/index.js"),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return "";
}

async function tryLoadPackageProvider() {
  const attempts = [];
  const explicitSpecifier = process.env.INTERNAL_PROVIDER_PACKAGE?.trim() || "";
  const effectiveSpecifier = explicitSpecifier || packageSpecifier;

  const siblingEntry = await resolveSiblingPackageEntry();
  const shouldPreferSibling =
    Boolean(siblingEntry) &&
    (!explicitSpecifier || explicitSpecifier === packageSpecifier);

  if (shouldPreferSibling && siblingEntry && !attempts.includes(siblingEntry)) {
    attempts.push(siblingEntry);
  }

  if (effectiveSpecifier && !attempts.includes(effectiveSpecifier)) {
    attempts.push(effectiveSpecifier);
  }

  if (!shouldPreferSibling && siblingEntry && !attempts.includes(siblingEntry)) {
    attempts.push(siblingEntry);
  }

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const module = await importPackageProvider(attempt);
      return {
        module,
        specifier: attempt,
        error: null,
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    module: null,
    specifier: attempts[0] || packageSpecifier,
    error: lastError,
  };
}

let providerModule = null;
let resolvedMode = requestedMode;
let providerLoadError = null;
let resolvedSpecifier = packageSpecifier;

if (requestedMode === "package" || requestedMode === "auto") {
  const packageResult = await tryLoadPackageProvider();
  if (packageResult.module) {
    providerModule = packageResult.module;
    resolvedSpecifier = packageResult.specifier;
    resolvedMode = "package";
  } else if (requestedMode === "package") {
    providerLoadError = packageResult.error;
    resolvedSpecifier = packageResult.specifier;
  } else {
    providerLoadError = packageResult.error;
    resolvedSpecifier = packageResult.specifier;
    resolvedMode = "disabled";
  }
} else if (requestedMode === "disabled") {
  resolvedMode = "disabled";
} else {
  throw new Error(
    `Unsupported INTERNAL_PROVIDER_MODE: ${requestedMode}. Expected auto, package, or disabled.`,
  );
}

function buildUnavailableMessage() {
  if (
    requestedMode === "package" ||
    ((requestedMode === "auto" || resolvedMode === "disabled") && providerLoadError)
  ) {
    return `내부 패키지 \`${resolvedSpecifier}\`가 없어 이 기능을 사용할 수 없다냥.`;
  }

  return "내부 기능이 비활성화되어 이 기능을 사용할 수 없다냥.";
}

function requireProviderModule() {
  if (!providerModule) {
    throw new Error(buildUnavailableMessage());
  }
  return providerModule;
}

function namespaceProxy(key) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        const namespace = requireProviderModule()[key];
        return namespace[prop];
      },
    },
  );
}

export function hasInternalProvider() {
  return Boolean(providerModule);
}

export function getInternalProviderStatus() {
  return {
    available: Boolean(providerModule),
    requestedMode,
    resolvedMode,
    packageSpecifier: resolvedSpecifier,
    error: providerLoadError
      ? providerLoadError instanceof Error
        ? providerLoadError.message
        : String(providerLoadError)
      : "",
  };
}

export function getInternalUnavailableMessage() {
  return buildUnavailableMessage();
}

export const internalResearch = namespaceProxy("internalResearch");
export const internalPrompts = namespaceProxy("internalPrompts");
export const internalBenchmarkStore = namespaceProxy("internalBenchmarkStore");
export const internalBenchmarkQueue = namespaceProxy("internalBenchmarkQueue");
export const internalChartQueue = namespaceProxy("internalChartQueue");
export const internalChartTool = namespaceProxy("internalChartTool");
export const internalCollectorRuntime = namespaceProxy("internalCollectorRuntime");
export const internalAppStorage = namespaceProxy("internalAppStorage");
export const internalMarketStorage = namespaceProxy("internalMarketStorage");
