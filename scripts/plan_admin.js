import {
  fetchGuildSubscription,
  fetchUserSubscription,
  putGuildSubscription,
  putUserSubscription,
} from "../src/gateways/internal/appGateway.js";

function parseArgs(argv) {
  const [mode = "", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const value = rest[index + 1] && !rest[index + 1].startsWith("--")
      ? rest[++index]
      : "true";
    options[key] = value;
  }
  return { mode, options };
}

function requireOption(options, key) {
  const value = String(options[key] || "").trim();
  if (!value) {
    throw new Error(`--${key} 값이 필요하다.`);
  }
  return value;
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

async function main() {
  const { mode, options } = parseArgs(process.argv.slice(2));

  if (mode === "get-user") {
    const discordUserId = requireOption(options, "user");
    printJson({
      mode,
      subscription: await fetchUserSubscription({ discordUserId }),
    });
    return;
  }

  if (mode === "set-user") {
    const discordUserId = requireOption(options, "user");
    const provider = requireOption(options, "provider");
    const status = requireOption(options, "status");
    printJson({
      mode,
      subscription: await putUserSubscription({
        discordUserId,
        provider,
        status,
        tierKey: String(options["tier-key"] || "individual_basic"),
        currentPeriodEnd: String(options["period-end"] || ""),
        providerCustomerId: String(options["customer-id"] || ""),
        providerMembershipId: String(options["membership-id"] || ""),
      }),
    });
    return;
  }

  if (mode === "get-guild") {
    const guildId = requireOption(options, "guild");
    printJson({
      mode,
      subscription: await fetchGuildSubscription({ guildId }),
    });
    return;
  }

  if (mode === "set-guild") {
    const guildId = requireOption(options, "guild");
    const provider = requireOption(options, "provider");
    const status = requireOption(options, "status");
    printJson({
      mode,
      subscription: await putGuildSubscription({
        guildId,
        provider,
        status,
        tierKey: String(options["tier-key"] || "guild_basic"),
        currentPeriodEnd: String(options["period-end"] || ""),
        providerCustomerId: String(options["customer-id"] || ""),
        providerMembershipId: String(options["membership-id"] || ""),
      }),
    });
    return;
  }

  throw new Error(
    [
      "사용법:",
      "  node scripts/plan_admin.js get-user --user <discord_user_id>",
      "  node scripts/plan_admin.js set-user --user <discord_user_id> --provider gumroad --status active --tier-key individual_basic",
      "  node scripts/plan_admin.js get-guild --guild <discord_guild_id>",
      "  node scripts/plan_admin.js set-guild --guild <discord_guild_id> --provider gumroad --status refunded --tier-key guild_basic",
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
