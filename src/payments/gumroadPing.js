import crypto from "node:crypto";

import { config } from "../config.js";

const SALE_LIKE_RESOURCES = new Set([
  "sale",
  "refund",
  "dispute",
  "dispute_won",
]);

const SUBSCRIPTION_LIKE_RESOURCES = new Set([
  "cancellation",
  "subscription_updated",
  "subscription_ended",
  "subscription_restarted",
]);

function normalizeLookupText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

function isTruthyFlag(value) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value || "").trim().toLowerCase();
  return ["true", "1", "yes", "y"].includes(normalized);
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
  for (const key of [
    "custom_fields",
    "purchase",
    "sale",
    "payload",
    "old_plan",
    "new_plan",
    "purchase_ids",
  ]) {
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

function normalizeClaimCode(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  return /^[A-F0-9]{6}$/.test(normalized) ? normalized : "";
}

function appendBracketFieldValues(result, payload, prefix) {
  for (const [key, value] of Object.entries(payload || {})) {
    const match = String(key).match(new RegExp(`^${prefix}\\[(.+)\\]$`, "i"));
    if (!match) {
      continue;
    }
    const fieldName = match[1];
    if (typeof value === "string" || typeof value === "number") {
      result.set(normalizeLookupText(fieldName), String(value).trim());
    }
  }
}

function extractClaimCode(payload) {
  const directKeys = [
    config.gumroadClaimFieldName,
    "ClaimCode",
    "Claim Code",
    "claim_code",
  ];
  for (const key of directKeys) {
    if (key in (payload || {})) {
      const normalized = normalizeClaimCode(payload[key]);
      if (normalized) {
        return normalized;
      }
    }
  }

  const customFieldMap = buildCustomFieldMap(payload.custom_fields);
  appendBracketFieldValues(customFieldMap, payload, "custom_fields");
  appendBracketFieldValues(customFieldMap, payload, "url_params");
  const fieldNames = [
    config.gumroadClaimFieldName,
    "ClaimCode",
    "Claim Code",
    "claim_code",
  ];
  for (const key of fieldNames) {
    const value = customFieldMap.get(normalizeLookupText(key));
    if (value) {
      const normalized = normalizeClaimCode(value);
      if (normalized) {
        return normalized;
      }
    }
  }
  return "";
}

function inferTierKey(payload, resourceName = "") {
  const planTierName =
    payload?.new_plan?.tier?.name ||
    payload?.old_plan?.tier?.name ||
    payload?.variants ||
    payload?.variant ||
    payload?.product_name ||
    payload?.product_id ||
    resourceName;

  const candidates = [planTierName]
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

function normalizeResourceName(value) {
  return String(value || "").trim().toLowerCase();
}

function inferStatus(resourceName, payload) {
  const normalized = normalizeResourceName(resourceName);
  if (normalized === "refund") {
    return "refunded";
  }
  if (normalized === "dispute") {
    return "disputed";
  }
  if (normalized === "dispute_won") {
    return "active";
  }
  if (normalized === "cancellation") {
    return "cancellation_pending";
  }
  if (normalized === "subscription_ended") {
    return "cancelled";
  }
  if (isTruthyFlag(payload.refunded)) {
    return "refunded";
  }
  if (isTruthyFlag(payload.disputed)) {
    return "disputed";
  }
  if (isTruthyFlag(payload.chargebacked)) {
    return "chargebacked";
  }
  if (String(payload.subscription_failed_at || "").trim()) {
    return "failed";
  }
  if (
    String(payload.subscription_ended_at || "").trim() ||
    String(payload.subscription_cancelled_at || "").trim()
  ) {
    return "cancelled";
  }
  return "active";
}

function extractPurchaseIds(value) {
  const parsed = tryParseJson(value);
  if (Array.isArray(parsed)) {
    return parsed
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildSyntheticEventId(resourceName, payload) {
  const normalized = normalizeResourceName(resourceName);
  const timeKey =
    payload.cancelled_at ||
    payload.effective_as_of ||
    payload.subscription_ended_at ||
    payload.created_at ||
    payload.sale_timestamp ||
    "";
  const raw = JSON.stringify(payload || {});
  const digest = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 12);
  return [
    normalized || "gumroad",
    String(payload.subscription_id || payload.sale_id || payload.id || ""),
    String(timeKey || ""),
    digest,
  ]
    .filter(Boolean)
    .join(":");
}

function normalizeSaleLikePayload(purchase, resourceName) {
  const eventId = String(
    purchase.sale_id ||
      purchase.id ||
      purchase.subscription_id ||
      purchase.order_number ||
      "",
  ).trim();
  if (!eventId) {
    throw new Error("Gumroad payload에서 sale 식별자를 찾지 못했다냥.");
  }

  return {
    provider: "gumroad",
    eventId,
    eventType: normalizeResourceName(resourceName) || String(purchase.event_type || "sale"),
    scopeType: "",
    scopeId: "",
    status: inferStatus(resourceName, purchase),
    tierKey: inferTierKey(purchase, resourceName),
    currentPeriodEnd: String(
      purchase.subscription_ended_at ||
        purchase.subscription_cancelled_at ||
        purchase.subscription_failed_at ||
        "",
    ).trim(),
    providerCustomerId: String(
      purchase.purchaser_id || purchase.email || "",
    ).trim(),
    customerEmail: String(purchase.email || "").trim(),
    customerName: String(
      purchase.full_name || purchase.name || purchase.fullName || "",
    ).trim(),
    providerMembershipId: String(purchase.subscription_id || "").trim(),
    providerSaleId: String(purchase.sale_id || eventId || "").trim(),
    claimCode: extractClaimCode(purchase),
    payload: purchase,
  };
}

function normalizeSubscriptionResourcePayload(payload, resourceName) {
  const purchaseIds = extractPurchaseIds(payload.purchase_ids);
  const currentPeriodEnd =
    String(
      payload.cancelled_at ||
        payload.effective_as_of ||
        payload.subscription_ended_at ||
        "",
    ).trim();
  const eventId = buildSyntheticEventId(resourceName, payload);

  return {
    provider: "gumroad",
    eventId,
    eventType: normalizeResourceName(resourceName) || "subscription_event",
    scopeType: "",
    scopeId: "",
    status: inferStatus(resourceName, payload),
    tierKey: inferTierKey(payload, resourceName),
    currentPeriodEnd,
    providerCustomerId: String(payload.user_id || payload.user_email || "").trim(),
    customerEmail: String(payload.user_email || "").trim(),
    customerName: String(
      payload.user_name || payload.full_name || payload.name || "",
    ).trim(),
    providerMembershipId: String(payload.subscription_id || "").trim(),
    providerSaleId: String(purchaseIds.at(-1) || "").trim(),
    claimCode: extractClaimCode(payload),
    payload: {
      ...payload,
      purchase_ids: purchaseIds,
    },
  };
}

export function normalizeGumroadWebhookPayload(rawPayload, { resourceName = "" } = {}) {
  const payload = maybeNormalizeStructuredFields(rawPayload || {});
  const normalizedResourceName = normalizeResourceName(
    resourceName || payload.resource_name,
  );

  const purchase =
    payload.purchase && typeof payload.purchase === "object"
      ? { ...payload, ...payload.purchase }
      : payload.sale && typeof payload.sale === "object"
        ? { ...payload, ...payload.sale }
        : payload;

  if (SUBSCRIPTION_LIKE_RESOURCES.has(normalizedResourceName)) {
    return normalizeSubscriptionResourcePayload(purchase, normalizedResourceName);
  }

  if (
    SALE_LIKE_RESOURCES.has(normalizedResourceName) ||
    purchase.sale_id ||
    purchase.order_number
  ) {
    return normalizeSaleLikePayload(purchase, normalizedResourceName || "sale");
  }

  throw new Error("지원하지 않는 Gumroad webhook payload 형식이다냥.");
}
