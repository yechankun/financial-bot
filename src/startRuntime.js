import { startDiscordBot } from "./discordBot.js";
import { config } from "./config.js";
import {
  createBenchmarkQueueConsumer,
  drainPendingBenchmarkQueue,
  ensureBenchmarkRuntime,
} from "./gateways/internal/benchmarkGateway.js";
import {
  createChartQueueConsumer,
  drainPendingChartQueue,
  ensureChartRuntime,
} from "./gateways/internal/chartGateway.js";
import {
  getCollectorStatus,
  runCollectorTick,
} from "./gateways/internal/collectorGateway.js";
import {
  getInternalProviderStatus,
  hasInternalProvider,
} from "./gateways/internal/provider.js";
import {
  getCapabilityStatus,
  hasCapability,
  shouldStartDiscordIngress,
} from "./runtimeCapabilities.js";
import { startPaymentWebhookServer } from "./payments/startPaymentWebhookServer.js";
import { startLocalhostRunTunnel } from "./payments/startLocalhostRunTunnel.js";
import { syncGumroadResourceSubscriptions } from "./payments/gumroadResourceSubscriptions.js";
import {
  drainReportJobQueue,
  ensureReportJobQueueDirs,
} from "./reportJobQueue.js";
import { createReportJobConsumer } from "./usecases/processReportJobs.js";

function logCapabilityStatus() {
  const status = getCapabilityStatus();
  console.log(
    `Runtime capabilities: ${status.capabilities.join(", ") || "(none)"}`,
  );
}

export async function startRuntime() {
  logCapabilityStatus();

  const paymentWebhookEnabled = hasCapability("payment-webhook");
  let paymentServer = null;
  let paymentTunnel = null;
  const shutdownActions = [];
  if (paymentWebhookEnabled) {
    paymentServer = await startPaymentWebhookServer();
    shutdownActions.push(async () => {
      await new Promise((resolve) => {
        paymentServer.close(() => resolve());
      });
    });
    if (config.gumroadPublicBaseUrl) {
      console.log(
        `Payment webhook public URL: ${config.gumroadPublicBaseUrl}${config.gumroadPingPath}`,
      );
    } else {
      try {
        paymentTunnel = await startLocalhostRunTunnel();
        if (paymentTunnel) {
          shutdownActions.push(async () => {
            paymentTunnel.stop();
          });
        }
      } catch (error) {
        console.error("Payment webhook tunnel start failed:", error);
      }
    }

    if (config.gumroadResourceSubscriptionsEnabled) {
      try {
        const syncResult = await syncGumroadResourceSubscriptions();
        for (const item of syncResult.removed || []) {
          console.log(
            `Removed Gumroad resource subscription: ${item.resourceName} -> ${item.postUrl}`,
          );
        }
        for (const item of syncResult.synced || []) {
          console.log(
            `Gumroad resource subscription ${item.mode}: ${item.resourceName} -> ${item.postUrl}`,
          );
        }
      } catch (error) {
        console.error("Gumroad resource subscription sync failed:", error);
      }
    }
  }

  const runShutdownActions = async () => {
    for (const action of shutdownActions.reverse()) {
      try {
        await action();
      } catch (error) {
        console.error("Shutdown cleanup failed:", error);
      }
    }
  };

  const installSimpleShutdownHooks = () => {
    const shutdown = () => {
      void runShutdownActions().finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  };

  if (shouldStartDiscordIngress()) {
    await startDiscordBot();
  }

  const providerStatus = getInternalProviderStatus();
  if (!hasInternalProvider()) {
    if (shouldStartDiscordIngress() || paymentServer) {
      if (paymentServer && !shouldStartDiscordIngress()) {
        installSimpleShutdownHooks();
      }
      return;
    }
    console.warn(
      `Internal provider unavailable for background runtime. requested=${providerStatus.requestedMode} resolved=${providerStatus.resolvedMode} error=${providerStatus.error || "none"}`,
    );
    return;
  }

  const chartWorkerEnabled = hasCapability("report-worker");
  const reportWorkerEnabled = hasCapability("report-worker");
  const benchmarkWorkerEnabled =
    hasCapability("ai-trading") || hasCapability("report-worker");
  const collectorEnabled = hasCapability("collector");

  if (!chartWorkerEnabled && !reportWorkerEnabled && !benchmarkWorkerEnabled && !collectorEnabled) {
    if (shouldStartDiscordIngress() || paymentServer) {
      if (paymentServer && !shouldStartDiscordIngress()) {
        installSimpleShutdownHooks();
      }
      return;
    }
    console.log("No background capabilities enabled. Exiting runtime.");
    return;
  }

  if (reportWorkerEnabled) {
    await ensureReportJobQueueDirs();
  }
  if (chartWorkerEnabled) {
    await ensureChartRuntime();
  }
  if (benchmarkWorkerEnabled) {
    await ensureBenchmarkRuntime();
  }

  if (collectorEnabled) {
    const collectorStatus = getCollectorStatus();
    console.log(
      `collector capability enabled. tasks=${collectorStatus.tasks.join(", ") || "(none)"} intervalMs=${collectorStatus.intervalMs}`,
    );
  }

  const consumeChartQueueBatch = chartWorkerEnabled
    ? createChartQueueConsumer()
    : async () => {};
  const consumeBenchmarkQueueBatch = benchmarkWorkerEnabled
    ? createBenchmarkQueueConsumer()
    : async () => {};
  const consumeReportJobBatch = reportWorkerEnabled
    ? createReportJobConsumer({
        consumeChartQueueBatch,
        consumeBenchmarkQueueBatch,
      })
    : async () => {};

  const drainQueues = async () => {
    if (reportWorkerEnabled) {
      await drainReportJobQueue(consumeReportJobBatch);
    }
    if (chartWorkerEnabled) {
      await drainPendingChartQueue(consumeChartQueueBatch);
    }
    if (benchmarkWorkerEnabled) {
      await drainPendingBenchmarkQueue(consumeBenchmarkQueueBatch);
    }
    if (collectorEnabled) {
      await runCollectorTick();
    }
  };

  if (collectorEnabled && getCollectorStatus().runOnStart) {
    await runCollectorTick({ force: true });
  }
  await drainQueues();

  const pollIntervalMs = Number(process.env.BACKGROUND_POLL_INTERVAL_MS || 5000);
  const timer = setInterval(() => {
    void drainQueues().catch((error) => {
      console.error("Background runtime queue drain failed:", error);
    });
  }, pollIntervalMs);

  console.log(
    `Background runtime started with poll interval ${pollIntervalMs}ms.`,
  );

  await new Promise((resolve) => {
    const shutdown = () => {
      clearInterval(timer);
      void runShutdownActions().finally(() => resolve());
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
