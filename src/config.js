import "dotenv/config";
import os from "node:os";
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

function readOptionalBoolean(name, fallback = false) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  return ["1", "true", "yes", "y", "on"].includes(raw);
}

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export const config = {
  discordToken: readOptional("DISCORD_BOT_TOKEN"),
  applicationId: readOptional("DISCORD_APPLICATION_ID"),
  guildId: process.env.DISCORD_GUILD_ID?.trim() || "",
  discordCommandCleanupGuildIds: readOptionalList("DISCORD_COMMAND_CLEANUP_GUILD_IDS"),
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
  gumroadPingMaxBodyBytes: readPositiveInteger("GUMROAD_PING_MAX_BODY_BYTES", 1024 * 1024),
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
  reportJobQueueFailedDir: path.join(runsDir, "report-jobs", "failed"),
  reportJobScratchDir: path.join(runsDir, "report-jobs", "scratch"),
  reportJobRequestsDir: path.join(runsDir, "report-jobs", "requests"),
  reportJobDeliveryDir: path.join(runsDir, "report-jobs", "delivery"),
  reportJobProgressDir: path.join(runsDir, "report-jobs", "progress"),
  reportJobQueueLockDir: path.join(runsDir, "report-jobs", ".worker-lock"),
  reportJobConcurrency: readPositiveInteger("REPORT_JOB_CONCURRENCY", 3),
  reportJobTimeoutMs: readPositiveInteger("REPORT_JOB_TIMEOUT_MS", 60 * 60 * 1000),
  reportPolicyCacheDir: path.join(dataDir, "report-policy-cache"),
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
  chartRenderScriptPath:
    process.env.CHART_RENDER_SCRIPT_PATH?.trim() ||
    path.join(repoDir, "scripts", "render_druckenmiller_stack.py"),
  chartRenderConcurrency: Number(process.env.CHART_RENDER_CONCURRENCY || 4),
  appDbPath: path.join(dataDir, "app.sqlite3"),
  guardSchemaPath: path.join(repoDir, "schemas", "question-guard.schema.json"),
  producerSchemaPath: path.join(repoDir, "schemas", "producer-output.schema.json"),
  benchmarkActionSchemaPath: path.join(repoDir, "schemas", "benchmark-actions.schema.json"),
  researchSchemaPath: path.join(repoDir, "schemas", "research-output.schema.json"),
  reportPlanSchemaPath: path.join(repoDir, "schemas", "report-plan.schema.json"),
  reportSchemaPath: path.join(repoDir, "schemas", "report-output.schema.json"),
  reportDeckTemplatePath: path.join(repoDir, "templates", "report-deck-template.html"),
  reportCaptureScriptPath: process.env.REPORT_CAPTURE_SCRIPT_PATH?.trim() || path.join(
    os.homedir(),
    ".codex",
    "skills",
    "context-report-studio",
    "scripts",
    "capture_report_pages.mjs",
  ),
  reportDisclaimerText:
    "본 자료는 정보 제공용 리서치입니다. 투자 권유 또는 투자자문이 아니며, 이용자의 개별 사정을 반영하지 않습니다. 투자 판단과 책임은 이용자 본인에게 있습니다.",
  skillsConfigPath: path.join(repoDir, "config", "skills.json"),
  autoReportEnabled:
    readOptionalBoolean("AUTO_REPORT_ENABLED", false) ||
    Boolean(readOptional("AUTO_REPORT_GUILD_ID")),
  autoReportGuildId: readOptional("AUTO_REPORT_GUILD_ID"),
  autoReportChannelId: readOptional("AUTO_REPORT_CHANNEL_ID"),
  autoReportIdleMs: Number(process.env.AUTO_REPORT_IDLE_MS || 2 * 60 * 60 * 1000),
  autoReportCheckIntervalMs: Number(process.env.AUTO_REPORT_CHECK_INTERVAL_MS || 60 * 1000),
  autoReportWaitTimeoutMs: Number(process.env.AUTO_REPORT_WAIT_TIMEOUT_MS || 30 * 60 * 1000),
  autoReportSkill:
    process.env.AUTO_REPORT_SKILL?.trim() || "druckenmiller-market-research",
  autoReportQuestion:
    process.env.AUTO_REPORT_QUESTION?.trim() ||
    "현재 글로벌 시장에서 가장 빠르게 재평가될 소지가 큰 산업/종목, 아직 과열 전인 추세 가속 후보, 그리고 너무 과열돼 숏 감시가 필요한 후보를 드러켄밀러 스타일로 정리해줘.",
};
