import { SlashCommandBuilder } from "discord.js";

export function buildPlanCommandJson() {
  return new SlashCommandBuilder()
    .setName("plan")
    .setDescription("현재 플랜 상태와 결제 링크를 보여준다냥.")
    .toJSON();
}
