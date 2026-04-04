import { handleAutocompleteInteraction } from "../autocomplete/handleAutocompleteInteraction.js";
import { createChatCommandHandler } from "./chatCommandHandler.js";
import {
  handlePlanButtonInteraction,
  handlePlanModalSubmit,
} from "./handlePlanCommand.js";

export function createInteractionHandler({
  activeChannelRuns,
  consumeChartQueueBatch,
  consumeBenchmarkQueueBatch,
}) {
  const handleChatInputCommand = createChatCommandHandler({
    activeChannelRuns,
    consumeChartQueueBatch,
    consumeBenchmarkQueueBatch,
  });

  return async function handleInteraction(interaction) {
    if (interaction.isAutocomplete()) {
      await handleAutocompleteInteraction(interaction);
      return;
    }

    if (interaction.isButton()) {
      const handled = await handlePlanButtonInteraction(interaction);
      if (handled) {
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      const handled = await handlePlanModalSubmit(interaction);
      if (handled) {
        return;
      }
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    await handleChatInputCommand(interaction);
  };
}
