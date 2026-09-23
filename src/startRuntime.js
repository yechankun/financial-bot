import { startDiscordBot } from "./discordBot.js";
import { config } from "./config.js";
import { startAutoReportScheduler } from "./usecases/autoReportScheduler.js";
import { createBenchmarkQueueConsumer, drainPendingBenchmarkQueue, ensureBenchmarkRuntime } from "./gateways/internal/benchmarkGateway.js";
import { createChartQueueConsumer, drainPendingChartQueue, ensureChartRuntime } from "./gateways/internal/chartGateway.js";
import { getCollectorStatus, runCollectorTick } from "./gateways/internal/collectorGateway.js";
import { getInternalProviderStatus, hasInternalProvider } from "./gateways/internal/provider.js";
import { getCapabilityStatus, hasCapability, shouldStartDiscordIngress } from "./runtimeCapabilities.js";
import { startPaymentWebhookServer } from "./payments/startPaymentWebhookServer.js";
import { startLocalhostRunTunnel } from "./payments/startLocalhostRunTunnel.js";
import { syncGumroadResourceSubscriptions } from "./payments/gumroadResourceSubscriptions.js";
import { createReportDeliveryConsumer, drainReportJobQueue, ensureReportJobQueueDirs } from "./reportJobQueue.js";
import { createReportJobConsumer } from "./usecases/processReportJobs.js";
import { createReportJobProgressDeliverer, createReportJobResultDeliverer } from "./usecases/reportJobNotifier.js";

export function startPollingTask(task, intervalMs, onError = console.error) {
  let current = null;
  let stopped = false;
  const tick = () => {
    if (stopped || current) return;
    current = Promise.resolve().then(task).catch(onError).finally(() => { current = null; });
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await current;
  };
}

export async function startRuntime() {
  const status = getCapabilityStatus();
  console.log(`Runtime capabilities: ${status.capabilities.join(", ") || "(none)"}`);
  const provider = getInternalProviderStatus();
  if (!provider.available && provider.requestedMode === "package") {
    throw new Error(`Internal provider failed to load: ${provider.error}`);
  }
  if (provider.missingApi.length > 0) {
    throw new Error(`Internal provider ${provider.packageSpecifier} is missing ${provider.missingApi.join(", ")}. `
      + "Update the pinned financial-bot-internal version or point INTERNAL_PROVIDER_PACKAGE at a matching checkout.");
  }
  const internalAvailable = hasInternalProvider();
  const shutdownActions = [];
  const controller = new AbortController();
  let resolveShutdown;
  const shuttingDown = new Promise((resolve) => { resolveShutdown = resolve; });
  const shutdown = () => { controller.abort(); resolveShutdown(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    const parentPid = Number(process.env.BOT_RUNTIME_PARENT_PID || 0);
    if (parentPid > 1) {
      const watchdog = setInterval(() => {
        try { process.kill(parentPid, 0); } catch { shutdown(); }
      }, 2000);
      watchdog.unref();
      shutdownActions.push(() => clearInterval(watchdog));
    }

    let paymentServer = null;
    if (hasCapability("payment-webhook") && config.gumroadPingEnabled) {
      if (!internalAvailable) throw new Error("Payment webhooks require the internal provider.");
      paymentServer = await startPaymentWebhookServer();
      shutdownActions.push(() => new Promise((resolve) => {
        paymentServer.close(resolve);
        paymentServer.closeIdleConnections();
      }));
      if (!config.gumroadPublicBaseUrl) {
        const tunnel = await startLocalhostRunTunnel();
        if (tunnel) shutdownActions.push(() => tunnel.stop());
      }
      if (config.gumroadResourceSubscriptionsEnabled) {
        await syncGumroadResourceSubscriptions();
      }
    }

    // Delivery starts only after Discord has connected. Workers never need a Discord login.
    const client = shouldStartDiscordIngress() ? await startDiscordBot() : null;
    if (client) shutdownActions.push(() => client.destroy());
    const intervalMs = Number(process.env.BACKGROUND_POLL_INTERVAL_MS || 5000);
    if (!Number.isFinite(intervalMs) || intervalMs < 100) {
      throw new Error("BACKGROUND_POLL_INTERVAL_MS must be at least 100.");
    }
    const poll = (name, task) => shutdownActions.push(startPollingTask(task, intervalMs,
      (error) => console.error(`${name} failed:`, error)));

    if (internalAvailable) {
      if (client || hasCapability("report-worker")) await ensureReportJobQueueDirs();
      if (client) {
        poll("Report delivery", createReportDeliveryConsumer({
          deliverProgress: createReportJobProgressDeliverer({ client }),
          deliverResult: createReportJobResultDeliverer({ client }),
        }));
        if (config.autoReportEnabled) shutdownActions.push(startAutoReportScheduler({ client }));
      }
      if (hasCapability("report-worker")) {
        const consume = createReportJobConsumer({ signal: controller.signal });
        poll("Report worker", () => drainReportJobQueue(consume));
        await ensureChartRuntime();
        const consumeCharts = createChartQueueConsumer();
        poll("Chart worker", () => drainPendingChartQueue(consumeCharts));
      }
      if (hasCapability("ai-trading") || hasCapability("report-worker")) {
        await ensureBenchmarkRuntime();
        const consumeBenchmark = createBenchmarkQueueConsumer(client);
        poll("Benchmark worker", () => drainPendingBenchmarkQueue(consumeBenchmark));
      }
      if (hasCapability("collector")) {
        const collector = getCollectorStatus();
        console.log(`Collector tasks: ${collector.tasks.join(", ")}`);
        let firstTick = true;
        poll("Collector", async () => {
          const force = firstTick && collector.runOnStart;
          firstTick = false;
          await runCollectorTick({ force });
        });
      }
    }
    if (client || paymentServer || (internalAvailable && status.runsBackgroundRuntime)) {
      await shuttingDown;
    }
  } finally {
    controller.abort();
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    for (const action of shutdownActions.reverse()) {
      try { await action(); } catch (error) { console.error("Shutdown cleanup failed:", error); }
    }
  }
}
