import { buildPlanReplyPayload } from "../../../usecases/planCommands.js";

export async function handlePlanCommand(interaction) {
  const payload = await buildPlanReplyPayload({
    discordUserId: interaction.user.id,
    guildId: interaction.guildId || "",
    guildName: interaction.guild?.name || "",
  });

  await interaction.reply(payload);
}
