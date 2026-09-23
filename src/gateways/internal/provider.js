import "dotenv/config";
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
  const explicitSpecifier = process.env.INTERNAL_PROVIDER_PACKAGE?.trim() || "";
  // An explicit provider is authoritative, including when it fails to load.
  const siblingEntry = explicitSpecifier ? "" : await resolveSiblingPackageEntry();
  const attempts = explicitSpecifier
    ? [explicitSpecifier]
    : [packageSpecifier, siblingEntry].filter(Boolean);

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
        const value = requireProviderModule()[key]?.[prop];
        if (value === undefined && typeof prop === "string") {
          throw new Error(`내부 패키지 \`${resolvedSpecifier}\`에 ${key}.${prop}가 없다냥. 공개 런타임과 버전이 맞지 않는다냥.`);
        }
        return value;
      },
    },
  );
}

// Every internal function the public runtime calls. startRuntime refuses to start with a
// provider that lacks one, instead of failing mid-report with "is not a function".
export const REQUIRED_INTERNAL_API = {
  internalResearch: ["createRunId", "runResearchJob"],
  internalPrompts: ["buildBenchmarkTradePrompt", "buildDecisionPrompt", "buildGuardPrompt", "buildPolicySearchPrompt", "buildReportPrompt", "buildResearchPrompt"],
  internalBenchmarkStore: ["applyBenchmarkTrade", "buildBenchmarkConsumerPromptContext", "buildBenchmarkDecisionFailureMessage", "buildBenchmarkDecisionMessage", "buildBenchmarkExecutionMarkdown", "buildBenchmarkHistoryMessage", "buildBenchmarkPortfolioMessage", "buildBenchmarkPromptContext", "ensureBenchmarkFiles", "loadBenchmarkSnapshot"],
  internalBenchmarkQueue: ["drainBenchmarkQueue", "enqueueBenchmarkReport", "ensureBenchmarkQueueDirs"],
  internalChartQueue: ["drainChartQueue", "enqueueChartJob", "ensureChartQueueDirs", "waitForChartJob"],
  internalChartTool: ["loadCandidateTickers", "renderCandidateCharts"],
  internalCollectorRuntime: ["getCollectorStatus", "runCollectorTick"],
  internalAppStorage: ["authorizeReportAccess", "claimIdleAutoReport", "consumeCommandRateLimit", "deleteScreenPreference", "ensureAutoReportBaseline", "getGuildSubscription", "getReportAccessStatus", "getReportCache", "getUserSubscription", "ingestPaymentEvent", "issuePlanClaimCode", "loadScreenPreference", "loadScreenPreferenceBundle", "markAutoReportPosted", "putGuildSubscription", "putReportCache", "putUserSubscription", "redeemPlanLicense", "saveScreenPreference", "saveScreenPreferenceBundle", "touchUserReportRequest"],
  internalMarketStorage: ["buildEtfLookupMessage", "buildEtfScreenMessage", "buildIndustryAutocompleteChoices", "buildStockLookupMessage", "buildStockScreenMessage", "buildSymbolAutocompleteChoices", "generateReportScreenerArtifacts", "getMarketDataCapabilities", "resolveReportQuestionScope"],
};

export const REQUIRED_MARKET_DATA_CONTRACT_VERSION = 1;

export function getMissingInternalApi(module = providerModule) {
  if (!module) return [];
  const missing = Object.entries(REQUIRED_INTERNAL_API).flatMap(([namespace, names]) =>
    names.filter((name) => typeof module[namespace]?.[name] !== "function").map((name) => `${namespace}.${name}`));
  if (typeof module.internalMarketStorage?.getMarketDataCapabilities === "function") {
    try {
      const capabilities = module.internalMarketStorage.getMarketDataCapabilities();
      if (Number(capabilities?.contractVersion || 0) < REQUIRED_MARKET_DATA_CONTRACT_VERSION) {
        missing.push(`market-data-contract-v${REQUIRED_MARKET_DATA_CONTRACT_VERSION}`);
      }
    } catch {
      missing.push(`market-data-contract-v${REQUIRED_MARKET_DATA_CONTRACT_VERSION}`);
    }
  }
  return missing;
}

export function hasInternalProvider() {
  return Boolean(providerModule);
}

export function getInternalProviderStatus() {
  let marketDataCapabilities = null;
  try {
    marketDataCapabilities = providerModule?.internalMarketStorage?.getMarketDataCapabilities?.() || null;
  } catch {}
  return {
    available: Boolean(providerModule),
    requestedMode,
    resolvedMode,
    packageSpecifier: resolvedSpecifier,
    missingApi: getMissingInternalApi(),
    marketDataCapabilities,
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
