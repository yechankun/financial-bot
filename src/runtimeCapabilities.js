const ALL_CAPABILITIES = [
  "discord-ingress",
  "payment-webhook",
  "lookup-commands",
  "report-worker",
  "collector",
  "ai-trading",
];

const ROLE_CAPABILITIES = {
  ingress: ["discord-ingress", "lookup-commands"],
  payment: ["payment-webhook"],
  worker: ["report-worker", "collector", "ai-trading"],
  collector: ["collector"],
  standalone: ALL_CAPABILITIES,
};

function normalizeList(raw) {
  return raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function resolveRuntimeCapabilities() {
  const rawCapabilities = process.env.BOT_CAPABILITIES?.trim();
  if (rawCapabilities) {
    const capabilities = normalizeList(rawCapabilities);
    const invalid = capabilities.filter(
      (capability) => !ALL_CAPABILITIES.includes(capability),
    );
    if (invalid.length > 0) {
      throw new Error(
        `Unsupported BOT_CAPABILITIES value(s): ${invalid.join(", ")}.`,
      );
    }

    return capabilities;
  }

  const runtimeRole = (process.env.BOT_RUNTIME_ROLE || "standalone")
    .trim()
    .toLowerCase();
  const fromRole = ROLE_CAPABILITIES[runtimeRole];
  if (!fromRole) {
    throw new Error(
      `Unsupported BOT_RUNTIME_ROLE: ${runtimeRole}. Expected ${Object.keys(ROLE_CAPABILITIES).join(", ")}.`,
    );
  }

  return [...fromRole];
}

const runtimeCapabilities = resolveRuntimeCapabilities();

export function getRuntimeCapabilities() {
  return [...runtimeCapabilities];
}

export function hasCapability(capability) {
  return runtimeCapabilities.includes(String(capability).trim().toLowerCase());
}

export function shouldStartDiscordIngress() {
  return hasCapability("discord-ingress");
}

export function canHandleLookupCommands() {
  return hasCapability("lookup-commands");
}

export function canHandleReportCommands() {
  return hasCapability("report-worker");
}

export function canAcceptReportCommands() {
  return hasCapability("discord-ingress") || hasCapability("report-worker");
}

export function getCapabilityStatus() {
  return {
    capabilities: getRuntimeCapabilities(),
    shouldStartDiscordIngress: shouldStartDiscordIngress(),
    handlesPaymentWebhook: hasCapability("payment-webhook"),
    canHandleLookupCommands: canHandleLookupCommands(),
    canHandleReportCommands: canHandleReportCommands(),
    canAcceptReportCommands: canAcceptReportCommands(),
    runsBackgroundRuntime:
      hasCapability("report-worker") ||
      hasCapability("collector") ||
      hasCapability("ai-trading"),
  };
}

export function getRequiredCapabilityForCommand(commandName) {
  if (commandName === "skills") {
    return "";
  }

  if (
    commandName === "etf" ||
    commandName === "stock" ||
    commandName === "etfscreen" ||
    commandName === "stockscreen" ||
    commandName === "benchmark"
  ) {
    return "lookup-commands";
  }

  if (commandName === "report") {
    return canAcceptReportCommands() ? "" : "report-worker";
  }

  return "";
}

export function buildMissingCapabilityMessage(commandName) {
  const capability = getRequiredCapabilityForCommand(commandName);
  if (!capability) {
    return "현재 이 기능을 처리할 수 없다냥.";
  }

  if (capability === "lookup-commands") {
    return `현재 이 실행 모드에서는 \`/${commandName}\` 조회 명령을 처리하지 않는다냥.`;
  }

  if (capability === "report-worker") {
    return `현재 이 실행 모드에서는 \`/${commandName}\` 리포트 명령을 처리하지 않는다냥.`;
  }

  return `현재 이 실행 모드에서는 \`/${commandName}\` 명령을 처리하지 않는다냥.`;
}
