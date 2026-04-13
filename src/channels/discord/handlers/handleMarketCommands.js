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

function measureEmbedChars(embed) {
  const fields = Array.isArray(embed?.fields) ? embed.fields : [];
  return (
    String(embed?.title || "").length +
    String(embed?.description || "").length +
    String(embed?.footer?.text || "").length +
    String(embed?.author?.name || "").length +
    fields.reduce(
      (sum, field) => sum + String(field?.name || "").length + String(field?.value || "").length,
      0,
    )
  );
}

function splitPayloadIntoMessages(payload, { maxEmbedChars = 6000, maxEmbeds = 10 } = {}) {
  const normalized = normalizeReplyPayload(payload);
  const embeds = Array.isArray(normalized.embeds) ? normalized.embeds : [];
  if (!embeds.length) {
    return [normalized];
  }

  const basePayload = { ...normalized };
  delete basePayload.embeds;

  const messages = [];
  let currentEmbeds = [];
  let currentChars = 0;

  for (const embed of embeds) {
    const embedChars = measureEmbedChars(embed);
    const exceedsChars = currentEmbeds.length > 0 && currentChars + embedChars > maxEmbedChars;
    const exceedsCount = currentEmbeds.length >= maxEmbeds;
    if (exceedsChars || exceedsCount) {
      messages.push({ ...basePayload, embeds: currentEmbeds });
      currentEmbeds = [];
      currentChars = 0;
    }
    currentEmbeds.push(embed);
    currentChars += embedChars;
  }

  if (currentEmbeds.length) {
    messages.push({ ...basePayload, embeds: currentEmbeds });
  }

  return messages.length ? messages : [normalized];
}

function isSharedInteraction(interaction) {
  return interaction.options?.getBoolean("share") ?? false;
}

async function sendReplyPayload(interaction, payload) {
  const messages = splitPayloadIntoMessages(payload);
  const [first, ...rest] = messages;
  await interaction.editReply(first);
  const shared = isSharedInteraction(interaction);
  for (const message of rest) {
    await interaction.followUp(
      shared ? message : { ...message, flags: MessageFlags.Ephemeral },
    );
  }
}

async function deferVisibilityReply(interaction) {
  const share = isSharedInteraction(interaction);
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
    (category === "overview" ? 1 : 5);

  await deferVisibilityReply(interaction);
  await sendReplyPayload(
    interaction,
    await runEtfScreen({
      category,
      limit,
      criteria: "",
      discordUserId: interaction.user.id,
    }),
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
  await sendReplyPayload(interaction, await runEtfLookup({ symbol }));
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
  const isOverview = category === "overview";
  const limit = industryHighlights
    ? 5
    : interaction.options.getInteger("limit") ||
      (isOverview ? 1 : 5);
  const industries = interaction.options.getString("industries") || "";
  const usOnly = interaction.options.getBoolean("us-only");
  const perIndustryLimit = industryHighlights
    ? interaction.options.getInteger("per_industry_limit") || (isOverview ? 1 : 2)
    : 0;
  const maxIndustries = industryHighlights || industryOnly
    ? interaction.options.getInteger("max_industries") || (isOverview ? 3 : 5)
    : 5;

  await deferVisibilityReply(interaction);
  await sendReplyPayload(
    interaction,
    await runStockScreen({
      category,
      limit,
      criteria: "",
      discordUserId: interaction.user.id,
      industryHighlights,
      industryOnly,
      industries,
      usOnly: usOnly !== false,
      perIndustryLimit,
      maxIndustries,
    }),
  );
}

export async function handleStockLookupCommand(interaction) {
  const symbol = interaction.options.getString("symbol", true);
  await deferVisibilityReply(interaction);
  await sendReplyPayload(interaction, await runStockLookup({ symbol }));
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
