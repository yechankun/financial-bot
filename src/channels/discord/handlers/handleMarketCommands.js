import { AttachmentBuilder, MessageFlags } from "discord.js";

import {
  loadEtfScreenPreferenceBundleUsecase,
  loadEtfScreenPreferenceUsecase,
  loadStockScreenPreferenceBundleUsecase,
  loadStockScreenPreferenceUsecase,
  runEtfLookup,
  runEtfScreen,
  runStockScreen,
  runStockLookup,
  saveEtfScreenPreferenceBundleUsecase,
  saveEtfScreenPreferenceUsecase,
  saveStockScreenPreferenceBundleUsecase,
  saveStockScreenPreferenceUsecase,
} from "../../../usecases/marketCommands.js";

function normalizeReplyPayload(payload) {
  return typeof payload === "string" ? { content: payload } : { ...(payload || {}) };
}

async function deferVisibilityReply(interaction) {
  const share = interaction.options?.getBoolean("share") ?? false;
  if (share) {
    await interaction.deferReply();
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
}

function normalizeCriteriaJson(raw, fallback) {
  const text = String(raw || "").trim();
  if (!text) {
    return fallback;
  }

  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function buildCriteriaReply({ title, updatedAt, criteriaJson, fallbackFileName }) {
  const prettyJson = normalizeCriteriaJson(criteriaJson, "{\n  \"categories\": {}\n}");
  const header = [title, `업데이트 시각: ${updatedAt || "n/a"}`].join("\n");
  const inline = `${header}\n\`\`\`json\n${prettyJson}\n\`\`\``;
  if (inline.length <= 1900) {
    return {
      content: inline,
      flags: 64,
    };
  }

  return {
    content: `${header}\nJSON이 길어서 파일로 첨부했다냥.`,
    flags: 64,
    files: [
      new AttachmentBuilder(Buffer.from(`${prettyJson}\n`, "utf8"), {
        name: fallbackFileName,
      }),
    ],
  };
}

export async function handleEtfScreenCommand(interaction) {
  const subcommand = interaction.options.getSubcommand(true);
  if (subcommand === "criteria") {
    await handleEtfScreenCriteriaCommand(interaction);
    return;
  }

  const category = interaction.options.getString("category", true);
  const limit =
    interaction.options.getInteger("limit") ||
    (category === "overview" ? 2 : 5);

  await deferVisibilityReply(interaction);
  await interaction.editReply(
    normalizeReplyPayload(
      await runEtfScreen({
        category,
        limit,
        criteria: "",
        discordUserId: interaction.user.id,
      }),
    ),
  );
}

export async function handleEtfScreenCriteriaCommand(interaction) {
  const category = interaction.options.getString("category");
  const save = interaction.options.getBoolean("save") || false;
  const criteria = interaction.options.getString("criteria")?.trim() || "";

  if (!save) {
    if (category) {
      const pref = await loadEtfScreenPreferenceUsecase({
        discordUserId: interaction.user.id,
        category,
      });
      await interaction.reply(
        buildCriteriaReply({
          title: `ETF criteria: ${category}`,
          updatedAt: pref?.updated_at,
          criteriaJson: pref?.criteria_json || "{}",
          fallbackFileName: `etfscreen-criteria-${category}.json`,
        }),
      );
      return;
    }

    const pref = await loadEtfScreenPreferenceBundleUsecase({
      discordUserId: interaction.user.id,
    });
    await interaction.reply(
      buildCriteriaReply({
        title: "저장된 ETF criteria 전체",
        updatedAt: pref?.updated_at,
        criteriaJson: pref?.criteria_json || "{\"categories\":{}}",
        fallbackFileName: "etfscreen-criteria.json",
      }),
    );
    return;
  }

  if (!criteria) {
    await interaction.reply({
      content: "`save=true`로 저장하려면 `criteria` JSON도 같이 넣어달라냥.",
      flags: 64,
    });
    return;
  }

  if (category) {
    const pref = await saveEtfScreenPreferenceUsecase({
      discordUserId: interaction.user.id,
      category,
      criteria,
    });
    await interaction.reply(
      buildCriteriaReply({
        title: `ETF criteria 저장 완료: ${category}`,
        updatedAt: pref?.updated_at,
        criteriaJson: pref?.criteria_json || criteria,
        fallbackFileName: `etfscreen-criteria-${category}.json`,
      }),
    );
    return;
  }

  const pref = await saveEtfScreenPreferenceBundleUsecase({
    discordUserId: interaction.user.id,
    criteria,
  });
  await interaction.reply(
    buildCriteriaReply({
      title: "ETF criteria 전체 저장 완료",
      updatedAt: pref?.updated_at,
      criteriaJson: pref?.criteria_json || criteria,
      fallbackFileName: "etfscreen-criteria.json",
    }),
  );
}

export async function handleEtfLookupCommand(interaction) {
  const symbol = interaction.options.getString("symbol", true);
  await deferVisibilityReply(interaction);
  await interaction.editReply(normalizeReplyPayload(await runEtfLookup({ symbol })));
}

export async function handleStockScreenCommand(interaction) {
  const subcommand = interaction.options.getSubcommand(true);
  if (subcommand === "criteria") {
    await handleStockScreenCriteriaCommand(interaction);
    return;
  }
  const category = interaction.options.getString("category", true);
  const industryHighlights = subcommand === "industry";
  const industryOnly = subcommand === "industry-only";
  const limit = industryHighlights
    ? 5
    : interaction.options.getInteger("limit") || 5;
  const industries = industryHighlights || industryOnly
    ? interaction.options.getString("industries") || ""
    : "";
  const usOnly = interaction.options.getBoolean("us-only") || false;
  const perIndustryLimit = industryHighlights
    ? interaction.options.getInteger("per_industry_limit") || 2
    : 0;
  const maxIndustries = industryHighlights || industryOnly
    ? interaction.options.getInteger("max_industries") || 5
    : 5;

  await deferVisibilityReply(interaction);
  await interaction.editReply(
    normalizeReplyPayload(
      await runStockScreen({
        category,
        limit,
        criteria: "",
        discordUserId: interaction.user.id,
        industryHighlights,
        industryOnly,
        industries,
        usOnly,
        perIndustryLimit,
        maxIndustries,
      }),
    ),
  );
}

export async function handleStockLookupCommand(interaction) {
  const symbol = interaction.options.getString("symbol", true);
  await deferVisibilityReply(interaction);
  await interaction.editReply(normalizeReplyPayload(await runStockLookup({ symbol })));
}

export async function handleStockScreenCriteriaCommand(interaction) {
  const category = interaction.options.getString("category");
  const save = interaction.options.getBoolean("save") || false;
  const criteria = interaction.options.getString("criteria")?.trim() || "";

  if (!save) {
    if (category) {
      const pref = await loadStockScreenPreferenceUsecase({
        discordUserId: interaction.user.id,
        category,
      });
      await interaction.reply(
        buildCriteriaReply({
          title: `주식 criteria: ${category}`,
          updatedAt: pref?.updated_at,
          criteriaJson: pref?.criteria_json || "{}",
          fallbackFileName: `stockscreen-criteria-${category}.json`,
        }),
      );
      return;
    }

    const pref = await loadStockScreenPreferenceBundleUsecase({
      discordUserId: interaction.user.id,
    });
    await interaction.reply(
      buildCriteriaReply({
        title: "저장된 주식 criteria 전체",
        updatedAt: pref?.updated_at,
        criteriaJson: pref?.criteria_json || "{\"categories\":{}}",
        fallbackFileName: "stockscreen-criteria.json",
      }),
    );
    return;
  }

  if (!criteria) {
    await interaction.reply({
      content: "`save=true`로 저장하려면 `criteria` JSON도 같이 넣어달라냥.",
      flags: 64,
    });
    return;
  }

  if (category) {
    const pref = await saveStockScreenPreferenceUsecase({
      discordUserId: interaction.user.id,
      category,
      criteria,
    });
    await interaction.reply(
      buildCriteriaReply({
        title: `주식 criteria 저장 완료: ${category}`,
        updatedAt: pref?.updated_at,
        criteriaJson: pref?.criteria_json || criteria,
        fallbackFileName: `stockscreen-criteria-${category}.json`,
      }),
    );
    return;
  }

  const pref = await saveStockScreenPreferenceBundleUsecase({
    discordUserId: interaction.user.id,
    criteria,
  });
  await interaction.reply(
    buildCriteriaReply({
      title: "주식 criteria 전체 저장 완료",
      updatedAt: pref?.updated_at,
      criteriaJson: pref?.criteria_json || criteria,
      fallbackFileName: "stockscreen-criteria.json",
    }),
  );
}
