import {
  fetchIndustryAutocomplete,
  fetchSymbolAutocomplete,
} from "../../../gateways/internal/marketGateway.js";
import { canHandleLookupCommands } from "../../../runtimeCapabilities.js";

const industryAutocompleteState = new Map();

function buildIndustryAutocompleteStateKey(interaction) {
  return [
    String(interaction.user?.id || ""),
    String(interaction.guildId || ""),
    String(interaction.channelId || ""),
    String(interaction.commandName || ""),
    "industries",
  ].join(":");
}

function normalizeIndustryAutocompleteQuery(interaction, focusedValue) {
  const current = String(focusedValue || "").trim();
  const explicitFullValue = String(interaction.options.getString("industries", false) || "").trim();
  const directCandidate = explicitFullValue || current;
  const key = buildIndustryAutocompleteStateKey(interaction);

  if (directCandidate.includes(",")) {
    industryAutocompleteState.set(key, directCandidate);
    return directCandidate;
  }

  const cached = String(industryAutocompleteState.get(key) || "").trim();
  if (!cached.includes(",")) {
    if (directCandidate) {
      industryAutocompleteState.set(key, directCandidate);
    }
    return directCandidate;
  }

  const prefix = cached
    .split(",")
    .slice(0, -1)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
  const merged = prefix ? `${prefix}, ${directCandidate}` : directCandidate;
  if (merged) {
    industryAutocompleteState.set(key, merged);
  }
  return merged;
}

export async function handleAutocompleteInteraction(interaction) {
  try {
    if (!canHandleLookupCommands()) {
      await interaction.respond([]);
      return;
    }

    if (interaction.commandName === "etf") {
      const focused = interaction.options.getFocused(true);
      const choices = await fetchSymbolAutocomplete({
        dataset: "etf",
        query: focused.value,
      });
      await interaction.respond(choices);
      return;
    }

    if (interaction.commandName === "stock") {
      const focused = interaction.options.getFocused(true);
      const choices = await fetchSymbolAutocomplete({
        dataset: "stock",
        query: focused.value,
      });
      await interaction.respond(choices);
      return;
    }

    if (interaction.commandName === "stockscreen") {
      const focused = interaction.options.getFocused(true);
      if (focused.name === "industries") {
        const fullQuery = normalizeIndustryAutocompleteQuery(interaction, focused.value);
        const choices = await fetchIndustryAutocomplete({
          query: fullQuery,
        });
        await interaction.respond(choices);
        return;
      }
    }

    await interaction.respond([]);
  } catch (error) {
    console.error("Failed to respond to autocomplete interaction:", error);
    await interaction.respond([]).catch(() => {});
  }
}
