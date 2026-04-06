import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const repoDir = process.cwd();
const runtimeRootDir =
  process.env.BOT_RUNTIME_ROOT_DIR?.trim() || repoDir;
const dataDir = process.env.BOT_DATA_DIR?.trim() || path.join(runtimeRootDir, "data");
const runsDir = process.env.BOT_RUNS_DIR?.trim() || path.join(runtimeRootDir, "runs");
const benchmarkDir =
  process.env.BOT_BENCHMARK_DIR?.trim() || path.join(runtimeRootDir, "benchmark");
const chartsDir =
  process.env.BOT_CHARTS_DIR?.trim() || path.join(runtimeRootDir, "charts");
const gumroadPingRawLogPath = process.env.GUMROAD_PING_RAW_LOG_PATH?.trim() || "";

if (gumroadPingRawLogPath) {
  fs.mkdirSync(path.dirname(gumroadPingRawLogPath), { recursive: true });
}

function readRequired(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readOptionalList(name) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readOptionalJsonObject(name, fallback = {}) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
}

function readOptional(name) {
  return process.env[name]?.trim() || "";
}

export const config = {
  discordToken: readRequired("DISCORD_BOT_TOKEN"),
  applicationId: readRequired("DISCORD_APPLICATION_ID"),
  guildId: process.env.DISCORD_GUILD_ID?.trim() || "",
  benchmarkInitialCash: Number(process.env.BENCHMARK_INITIAL_CASH || 10000),
  benchmarkBuyFeeRate: Number(process.env.BENCHMARK_BUY_FEE_RATE || 0.001),
  benchmarkSellFeeRate: Number(process.env.BENCHMARK_SELL_FEE_RATE || 0.001),
  allowedDiscordUserIds: readOptionalList("ALLOWED_DISCORD_USER_IDS"),
  gumroadPersonalProductUrl:
    process.env.GUMROAD_PERSONAL_PRODUCT_URL?.trim() ||
    "https://yeongkun.gumroad.com/l/cyekst",
  gumroadGuildProductUrl:
    process.env.GUMROAD_GUILD_PRODUCT_URL?.trim() || "",
  gumroadClaimFieldName:
    process.env.GUMROAD_CLAIM_FIELD_NAME?.trim() || "ClaimCode",
  gumroadPingEnabled: process.env.GUMROAD_PING_ENABLED?.trim() === "true",
  gumroadPingHost: process.env.GUMROAD_PING_HOST?.trim() || "0.0.0.0",
  gumroadPingPort: Number(process.env.GUMROAD_PING_PORT || 8787),
  gumroadPingPath: process.env.GUMROAD_PING_PATH?.trim() || "/gumroad/ping",
  gumroadPingSecret: process.env.GUMROAD_PING_SECRET?.trim() || "",
  gumroadPublicBaseUrl:
    process.env.GUMROAD_PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") || "",
  gumroadPingRawLogPath,
  gumroadTunnelEnabled: process.env.GUMROAD_TUNNEL_ENABLED?.trim() === "true",
  gumroadTunnelDestination:
    process.env.GUMROAD_TUNNEL_DESTINATION?.trim() || "nokey@localhost.run",
  gumroadTunnelRemotePort: Number(process.env.GUMROAD_TUNNEL_REMOTE_PORT || 80),
  gumroadTunnelLocalHost:
    process.env.GUMROAD_TUNNEL_LOCAL_HOST?.trim() || "127.0.0.1",
  gumroadTunnelLocalPort: Number(
    process.env.GUMROAD_TUNNEL_LOCAL_PORT || process.env.GUMROAD_PING_PORT || 8787,
  ),
  gumroadTunnelStartupTimeoutMs: Number(
    process.env.GUMROAD_TUNNEL_STARTUP_TIMEOUT_MS || 15000,
  ),
  gumroadTierMap: readOptionalJsonObject("GUMROAD_TIER_MAP_JSON", {}),
  gumroadOAuthApplicationId: readOptional("GUMROAD_OAUTH_APPLICATION_ID"),
  gumroadOAuthAccessToken: readOptional("GUMROAD_OAUTH_ACCESS_TOKEN"),
  gumroadOAuthApplicationSecret: readOptional("GUMROAD_OAUTH_APPLICATION_SECRET"),
  gumroadResourceSubscriptionsEnabled:
    process.env.GUMROAD_RESOURCE_SUBSCRIPTIONS_ENABLED?.trim() === "true",
  gumroadResourceSubscriptionResources: readOptionalList(
    "GUMROAD_RESOURCE_SUBSCRIPTION_RESOURCES",
  ),
  repoDir,
  runtimeRootDir,
  workspaceDir: repoDir,
  dataDir,
  runsDir,
  channelLocksDir: path.join(runsDir, ".channel-locks"),
  reportJobQueueDir: path.join(runsDir, "report-jobs"),
  reportJobQueuePendingDir: path.join(runsDir, "report-jobs", "pending"),
  reportJobQueueProcessingDir: path.join(runsDir, "report-jobs", "processing"),
  reportJobQueueProcessedDir: path.join(runsDir, "report-jobs", "processed"),
  reportJobQueueLockDir: path.join(runsDir, "report-jobs", ".worker-lock"),
  benchmarkDir,
  benchmarkPortfolioPath: path.join(benchmarkDir, "portfolio.json"),
  benchmarkTradeHistoryPath: path.join(benchmarkDir, "trade-history.json"),
  benchmarkYahooQuoteCachePath: path.join(benchmarkDir, "yahoo-quote-cache.json"),
  benchmarkQueueDir: path.join(benchmarkDir, "queue"),
  benchmarkQueuePendingDir: path.join(benchmarkDir, "queue", "pending"),
  benchmarkQueueProcessingDir: path.join(benchmarkDir, "queue", "processing"),
  benchmarkQueueProcessedDir: path.join(benchmarkDir, "queue", "processed"),
  benchmarkQueueLockDir: path.join(benchmarkDir, "queue", ".worker-lock"),
  chartQueueDir: path.join(chartsDir, "queue"),
  chartQueuePendingDir: path.join(chartsDir, "queue", "pending"),
  chartQueueProcessingDir: path.join(chartsDir, "queue", "processing"),
  chartQueueProcessedDir: path.join(chartsDir, "queue", "processed"),
  chartQueueLockDir: path.join(chartsDir, "queue", ".worker-lock"),
  etfAggregateDbPath: path.join(dataDir, "etf_constituent_aggregates.sqlite3"),
  appDbPath: path.join(dataDir, "app.sqlite3"),
  guardSchemaPath: path.join(repoDir, "schemas", "question-guard.schema.json"),
  producerSchemaPath: path.join(repoDir, "schemas", "producer-output.schema.json"),
  benchmarkActionSchemaPath: path.join(repoDir, "schemas", "benchmark-actions.schema.json"),
  researchSchemaPath: path.join(repoDir, "schemas", "research-output.schema.json"),
  reportSchemaPath: path.join(repoDir, "schemas", "report-output.schema.json"),
  skillsConfigPath: path.join(repoDir, "config", "skills.json")
};
