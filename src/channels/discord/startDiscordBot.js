import fs from "node:fs/promises";

import { Client, GatewayIntentBits } from "discord.js";

import { config } from "../../config.js";
import {
  createBenchmarkQueueConsumer,
  drainPendingBenchmarkQueue,
  ensureBenchmarkRuntime,
} from "../../gateways/internal/benchmarkGateway.js";
import {
  createChartQueueConsumer,
  drainPendingChartQueue,
  ensureChartRuntime,
} from "../../gateways/internal/chartGateway.js";
import {
  getInternalProviderStatus,
  hasInternalProvider,
} from "../../gateways/internal/provider.js";
import {
  hasCapability,
  shouldStartDiscordIngress,
} from "../../runtimeCapabilities.js";
import { registerSlashCommands } from "./commands/registerSlashCommands.js";
import { createInteractionHandler } from "./handlers/createInteractionHandler.js";

let activeDiscordClient = null;

export function getDiscordClient() {
  return activeDiscordClient;
}

export async function startDiscordBot() {
  if (!shouldStartDiscordIngress()) {
    console.log(
      "discord-ingress capability is disabled. Skipping Discord login for this process.",
    );
    return;
  }

  if (!config.discordToken || !config.applicationId) {
    throw new Error("Discord ingress requires DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID.");
  }

  const internalAvailable = hasInternalProvider();
  const providerStatus = getInternalProviderStatus();
  const benchmarkRuntimeEnabled =
    internalAvailable &&
    (hasCapability("lookup-commands") || hasCapability("ai-trading"));
  const chartRuntimeEnabled =
    internalAvailable && hasCapability("report-worker");

  await fs.mkdir(config.runsDir, { recursive: true });
  await fs.mkdir(config.channelLocksDir, { recursive: true });
  if (benchmarkRuntimeEnabled) {
    await ensureBenchmarkRuntime();
  }
  if (chartRuntimeEnabled) {
    await ensureChartRuntime();
  }
  await registerSlashCommands({ internalCommandsEnabled: internalAvailable });

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });
  activeDiscordClient = client;

  const activeChannelRuns = new Map();
  const consumeBenchmarkQueueBatch = benchmarkRuntimeEnabled
    ? createBenchmarkQueueConsumer(client)
    : async () => {};
  const consumeChartQueueBatch = chartRuntimeEnabled
    ? createChartQueueConsumer()
    : async () => {};
  const handleInteraction = createInteractionHandler({
    activeChannelRuns,
    consumeChartQueueBatch,
    consumeBenchmarkQueueBatch,
  });

  client.once("clientReady", (readyClient) => {
    console.log(`Discord bot logged in as ${readyClient.user.tag}`);
    if (!internalAvailable) {
      console.warn(
        `Internal provider unavailable. requested=${providerStatus.requestedMode} resolved=${providerStatus.resolvedMode} error=${providerStatus.error || "none"}`,
      );
      return;
    }

    if (chartRuntimeEnabled) {
      void drainPendingChartQueue(consumeChartQueueBatch).catch((error) => {
        console.error("Failed to drain chart queue on startup:", error);
      });
    }
    if (benchmarkRuntimeEnabled) {
      void drainPendingBenchmarkQueue(consumeBenchmarkQueueBatch).catch((error) => {
        console.error("Failed to drain benchmark queue on startup:", error);
      });
    }
  });

  client.on("interactionCreate", handleInteraction);
  await client.login(config.discordToken);
  return client;
}
