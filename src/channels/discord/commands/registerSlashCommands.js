import { REST, Routes } from "discord.js";

import { config } from "../../../config.js";
import {
  canAcceptReportCommands,
  canHandleLookupCommands,
} from "../../../runtimeCapabilities.js";
import { loadActiveSkills } from "../../../skillWhitelist.js";
import { buildBenchmarkCommandJson } from "./benchmarkCommand.js";
import {
  buildEtfLookupCommandJson,
  buildEtfScreenCommandJson,
  buildStockScreenCommandJson,
  buildStockLookupCommandJson,
} from "./marketCommands.js";
import { buildPlanCommandJson } from "./planCommand.js";
import { buildReportCommandJson } from "./reportCommand.js";
import { buildSkillsCommandJson } from "./skillsCommand.js";

export function buildCommandJson(activeSkills, { internalCommandsEnabled }) {
  const commands = [buildSkillsCommandJson()];

  if (!internalCommandsEnabled) {
    return commands;
  }

  commands.push(buildPlanCommandJson());

  if (canHandleLookupCommands()) {
    commands.push(
      buildEtfScreenCommandJson(),
      buildEtfLookupCommandJson(),
      buildStockScreenCommandJson(),
      buildStockLookupCommandJson(),
      buildBenchmarkCommandJson(),
    );
  }

  if (canAcceptReportCommands()) {
    commands.push(buildReportCommandJson(activeSkills));
  }

  return commands;
}

export async function registerSlashCommands({ internalCommandsEnabled = true } = {}) {
  const activeSkills = internalCommandsEnabled ? await loadActiveSkills() : [];
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const route = config.guildId
    ? Routes.applicationGuildCommands(config.applicationId, config.guildId)
    : Routes.applicationCommands(config.applicationId);

  await rest.put(route, {
    body: buildCommandJson(activeSkills, { internalCommandsEnabled }),
  });
}
