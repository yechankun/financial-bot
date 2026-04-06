import { config } from "../config.js";

const SUPPORTED_RESOURCE_NAMES = new Set([
  "sale",
  "refund",
  "dispute",
  "dispute_won",
  "cancellation",
  "subscription_updated",
  "subscription_ended",
  "subscription_restarted",
]);

function normalizeResourceName(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return SUPPORTED_RESOURCE_NAMES.has(normalized) ? normalized : "";
}

function buildCallbackUrl(resourceName) {
  const baseUrl = String(config.gumroadPublicBaseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    return "";
  }
  const url = new URL(`${baseUrl}${config.gumroadPingPath}`);
  url.searchParams.set("resource_name", resourceName);
  if (config.gumroadPingSecret) {
    url.searchParams.set("secret", config.gumroadPingSecret);
  }
  return url.toString();
}

async function gumroadApiRequest(pathname, { method = "GET", form = null } = {}) {
  const accessToken = String(config.gumroadOAuthAccessToken || "").trim();
  if (!accessToken) {
    throw new Error("Gumroad OAuth access token이 설정되지 않았다냥.");
  }

  const body = new URLSearchParams();
  body.set("access_token", accessToken);
  for (const [key, value] of Object.entries(form || {})) {
    if (value == null || value === "") {
      continue;
    }
    body.set(key, String(value));
  }

  if (method === "GET") {
    const query = new URLSearchParams(body);
    const getResponse = await fetch(
      `https://api.gumroad.com/v2${pathname}?${query.toString()}`,
      {
        method: "GET",
      },
    );
    let getPayload = null;
    try {
      getPayload = await getResponse.json();
    } catch {
      getPayload = null;
    }
    if (!getResponse.ok || getPayload?.success === false) {
      const message =
        getPayload?.message ||
        getPayload?.error ||
        `Gumroad API GET failed: ${getResponse.status}`;
      throw new Error(String(message));
    }
    return getPayload;
  }

  const response = await fetch(`https://api.gumroad.com/v2${pathname}`, {
    method,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || payload?.success === false) {
    const message =
      payload?.message ||
      payload?.error ||
      `Gumroad API ${method} failed: ${response.status}`;
    throw new Error(String(message));
  }

  return payload;
}

export async function listGumroadResourceSubscriptions(resourceName) {
  const normalized = normalizeResourceName(resourceName);
  if (!normalized) {
    throw new Error("지원하지 않는 Gumroad resource name이다냥.");
  }
  const payload = await gumroadApiRequest("/resource_subscriptions", {
    method: "GET",
    form: {
      resource_name: normalized,
    },
  });
  return Array.isArray(payload?.resource_subscriptions)
    ? payload.resource_subscriptions
    : [];
}

export async function putGumroadResourceSubscription(resourceName) {
  const normalized = normalizeResourceName(resourceName);
  if (!normalized) {
    throw new Error("지원하지 않는 Gumroad resource name이다냥.");
  }
  const postUrl = buildCallbackUrl(normalized);
  if (!postUrl) {
    throw new Error("고정 public webhook URL이 필요하다냥.");
  }
  const payload = await gumroadApiRequest("/resource_subscriptions", {
    method: "PUT",
    form: {
      resource_name: normalized,
      post_url: postUrl,
    },
  });
  return payload?.resource_subscription || null;
}

export async function deleteGumroadResourceSubscription(subscriptionId) {
  const normalized = String(subscriptionId || "").trim();
  if (!normalized) {
    throw new Error("삭제할 Gumroad resource subscription id가 비어 있다냥.");
  }
  return gumroadApiRequest(`/resource_subscriptions/${encodeURIComponent(normalized)}`, {
    method: "DELETE",
  });
}

export async function syncGumroadResourceSubscriptions() {
  if (!config.gumroadResourceSubscriptionsEnabled) {
    return { enabled: false, synced: [], removed: [] };
  }

  const resources =
    config.gumroadResourceSubscriptionResources
      .map(normalizeResourceName)
      .filter(Boolean);

  if (resources.length === 0) {
    return { enabled: true, synced: [], removed: [] };
  }

  const synced = [];
  const removed = [];

  for (const resourceName of resources) {
    const targetPostUrl = buildCallbackUrl(resourceName);
    const existing = await listGumroadResourceSubscriptions(resourceName);
    const matching = existing.find(
      (item) => String(item?.post_url || "").trim() === targetPostUrl,
    );

    for (const item of existing) {
      const id = String(item?.id || "").trim();
      const postUrl = String(item?.post_url || "").trim();
      if (id && postUrl && postUrl !== targetPostUrl) {
        await deleteGumroadResourceSubscription(id);
        removed.push({
          resourceName,
          id,
          postUrl,
        });
      }
    }

    if (matching) {
      synced.push({
        resourceName,
        id: String(matching.id || ""),
        postUrl: String(matching.post_url || ""),
        mode: "existing",
      });
      continue;
    }

    const created = await putGumroadResourceSubscription(resourceName);
    synced.push({
      resourceName,
      id: String(created?.id || ""),
      postUrl: String(created?.post_url || ""),
      mode: "created",
    });
  }

  return {
    enabled: true,
    synced,
    removed,
  };
}
