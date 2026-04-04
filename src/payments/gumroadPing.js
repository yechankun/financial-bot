import { config } from "../config.js";

function normalizeLookupText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

function tryParseJson(value) {
  if (typeof value !== "string") {
    return value;
  }
  const raw = value.trim();
  if (!raw) {
    return value;
  }
  if (!(raw.startsWith("{") || raw.startsWith("["))) {
    return value;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return value;
  }
}

function maybeNormalizeStructuredFields(payload) {
  const next = { ...payload };
  for (const key of ["custom_fields", "purchase", "sale", "payload"]) {
    if (key in next) {
      next[key] = tryParseJson(next[key]);
    }
  }
  return next;
}

function buildCustomFieldMap(customFields) {
  const result = new Map();
  const assign = (key, value) => {
    const normalizedKey = normalizeLookupText(key);
    const normalizedValue = String(value ?? "").trim();
    if (!normalizedKey || !normalizedValue) {
      return;
    }
    result.set(normalizedKey, normalizedValue);
  };

  if (Array.isArray(customFields)) {
    for (const item of customFields) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const key =
        item.name ?? item.field_name ?? item.label ?? item.key ?? item.title;
      const value =
        item.value ?? item.content ?? item.answer ?? item.text ?? item.input;
      if (key && value != null) {
        assign(key, value);
        continue;
      }
      for (const [nestedKey, nestedValue] of Object.entries(item)) {
        if (typeof nestedValue === "string" || typeof nestedValue === "number") {
          assign(nestedKey, nestedValue);
        }
      }
    }
    return result;
  }

  if (customFields && typeof customFields === "object") {
    for (const [key, value] of Object.entries(customFields)) {
      if (typeof value === "string" || typeof value === "number") {
        assign(key, value);
      }
    }
  }

  return result;
}

function extractClaimCode(payload) {
  const customFieldMap = buildCustomFieldMap(payload.custom_fields);
  const fieldNames = [
    config.gumroadClaimFieldName,
    "ClaimCode",
    "Claim Code",
    "claim_code",
  ];
  for (const key of fieldNames) {
    const value = customFieldMap.get(normalizeLookupText(key));
    if (value) {
      return value.toUpperCase();
    }
  }
  return "";
}

function inferTierKey(payload) {
  const candidates = [
    payload.variants,
    payload.variant,
    payload.product_name,
    payload.product_id,
  ]
    .map((value) => normalizeLookupText(value))
    .filter(Boolean);

  for (const candidate of candidates) {
    for (const [match, tierKey] of Object.entries(config.gumroadTierMap || {})) {
      if (candidate.includes(normalizeLookupText(match))) {
        return String(tierKey || "").trim() || "individual_basic";
      }
    }
  }

  const merged = candidates.join(" ");
  if (merged.includes("guild") || merged.includes("server")) {
    return "guild_basic";
  }
  return "individual_basic";
}

function deriveStatus(payload) {
  if (
    payload.refunded ||
    payload.disputed ||
    payload.chargebacked ||
    payload.subscription_ended_at ||
    payload.subscription_cancelled_at ||
    payload.subscription_failed_at
  ) {
    return "cancelled";
  }
  return "active";
}

function extractEventId(payload) {
  return String(
    payload.sale_id ||
      payload.id ||
      payload.subscription_id ||
      payload.order_number ||
      "",
  ).trim();
}

export function normalizeGumroadPingPayload(rawPayload) {
  const payload = maybeNormalizeStructuredFields(rawPayload || {});
  const purchase =
    payload.purchase && typeof payload.purchase === "object"
      ? { ...payload, ...payload.purchase }
      : payload.sale && typeof payload.sale === "object"
        ? { ...payload, ...payload.sale }
        : payload;

  const eventId = extractEventId(purchase);
  if (!eventId) {
    throw new Error("Gumroad payload에서 sale 식별자를 찾지 못했다냥.");
  }

  return {
    provider: "gumroad",
    eventId,
    eventType: String(purchase.event_type || "sale"),
    scopeType: "",
    scopeId: "",
    status: deriveStatus(purchase),
    tierKey: inferTierKey(purchase),
    currentPeriodEnd: String(
      purchase.subscription_ended_at ||
        purchase.subscription_cancelled_at ||
        purchase.subscription_failed_at ||
        "",
    ).trim(),
    providerCustomerId: String(
      purchase.purchaser_id || purchase.email || "",
    ).trim(),
    providerMembershipId: String(purchase.subscription_id || "").trim(),
    claimCode: extractClaimCode(purchase),
    payload: purchase,
  };
}
