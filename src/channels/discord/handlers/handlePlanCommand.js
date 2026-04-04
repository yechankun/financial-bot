import { buildPlanReplyPayload } from "../../../usecases/planCommands.js";

export async function handlePlanCommand(interaction) {
  const subcommand = interaction.options.getSubcommand(false) || "status";
  const payload = await buildPlanReplyPayload({
    discordUserId: interaction.user.id,
    guildId: interaction.guildId || "",
    view: subcommand,
  });

  await interaction.reply(payload);
}
