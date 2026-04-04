import {
  buildPlanLicenseRedeemReplyPayload,
  buildPlanRedeemModal,
  buildPlanReplyPayload,
  PLAN_REDEEM_BUTTON_ID,
  PLAN_REDEEM_INPUT_ID,
  PLAN_REDEEM_MODAL_ID,
} from "../../../usecases/planCommands.js";

export async function handlePlanCommand(interaction) {
  const payload = await buildPlanReplyPayload({
    discordUserId: interaction.user.id,
    guildId: interaction.guildId || "",
    guildName: interaction.guild?.name || "",
  });

  await interaction.reply(payload);
}

export async function handlePlanButtonInteraction(interaction) {
  if (interaction.customId !== PLAN_REDEEM_BUTTON_ID) {
    return false;
  }

  await interaction.showModal(buildPlanRedeemModal());
  return true;
}

export async function handlePlanModalSubmit(interaction) {
  if (interaction.customId !== PLAN_REDEEM_MODAL_ID) {
    return false;
  }

  const payload = await buildPlanLicenseRedeemReplyPayload({
    discordUserId: interaction.user.id,
    guildId: interaction.guildId || "",
    guildName: interaction.guild?.name || "",
    licenseKey: interaction.fields.getTextInputValue(PLAN_REDEEM_INPUT_ID),
  });

  await interaction.reply(payload);
  return true;
}
