import { SlashCommandBuilder } from "discord.js";

export function buildPlanCommandJson() {
  return new SlashCommandBuilder()
    .setName("plan")
    .setDescription("플랜, quota, 결제 링크를 확인한다냥.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("현재 개인/서버 플랜 상태와 quota를 보여준다냥."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("personal")
        .setDescription("개인 플랜 결제 링크와 안내를 보여준다냥."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("server")
        .setDescription("서버 플랜 결제 링크와 안내를 보여준다냥."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("refresh")
        .setDescription("플랜 상태를 다시 확인한다냥."),
    )
    .toJSON();
}
