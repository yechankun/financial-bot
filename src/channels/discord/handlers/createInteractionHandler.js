import { handleAutocompleteInteraction } from "../autocomplete/handleAutocompleteInteraction.js";
import { createChatCommandHandler } from "./chatCommandHandler.js";

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

    if (!interaction.isChatInputCommand()) {
      return;
    }

    await handleChatInputCommand(interaction);
  };
}
