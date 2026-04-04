import { buildPlanReplyPayload, getPlanRefreshButtonId } from "../../../usecases/planCommands.js";

export async function handlePlanCommand(interaction) {
  const subcommand = interaction.options.getSubcommand(false) || "status";
  const payload = await buildPlanReplyPayload({
    discordUserId: interaction.user.id,
    guildId: interaction.guildId || "",
    view: subcommand,
  });

  await interaction.reply(payload);
}

export async function handlePlanRefreshButton(interaction) {
  if (interaction.customId !== getPlanRefreshButtonId()) {
    return false;
  }

  const payload = await buildPlanReplyPayload({
    discordUserId: interaction.user.id,
    guildId: interaction.guildId || "",
    view: "status",
  });

  await interaction.update({
    content: payload.content,
    components: payload.components,
  });
  return true;
}
