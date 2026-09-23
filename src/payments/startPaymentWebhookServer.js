import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";

import { config } from "../config.js";
import { ingestPaymentEvent } from "../gateways/internal/appGateway.js";
import { normalizeGumroadWebhookPayload } from "./gumroadPing.js";

function parseRequestBody(contentType, rawBody) {
  const bodyText = rawBody.toString("utf8");
  if (!bodyText.trim()) {
    return {};
  }

  if (String(contentType || "").includes("application/json")) {
    return JSON.parse(bodyText);
  }

  if (
    String(contentType || "").includes("application/x-www-form-urlencoded")
  ) {
    const params = new URLSearchParams(bodyText);
    const result = {};
    for (const [key, value] of params.entries()) {
      result[key] = value;
    }
    return result;
  }

  return { raw: bodyText };
}

function hasValidSecret({ requestUrl, headers, payload, settings }) {
  if (!settings.gumroadPingSecret) return false;

  const querySecret = requestUrl.searchParams.get("secret") || "";
  const headerSecret = headers["x-gumroad-secret"] || headers["x-webhook-secret"] || "";
  const payloadSecret =
    (payload && typeof payload === "object" && (payload.secret || payload.token)) || "";

  const expected = Buffer.from(settings.gumroadPingSecret);
  return [querySecret, headerSecret, payloadSecret].some((value) => {
    const supplied = Buffer.from(String(value));
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

async function appendRawPingLog({ request, requestUrl, payload, normalized, result, error, settings }) {
  if (!settings.gumroadPingRawLogPath) {
    return;
  }

  const entry = {
    receivedAt: new Date().toISOString(),
    method: request.method || "",
    path: requestUrl.pathname,
    query: { resource_name: requestUrl.searchParams.get("resource_name") || "" },
    headers: { "content-type": request.headers["content-type"] },
    payload,
    normalized,
    result,
    error: error ? (error instanceof Error ? error.message : String(error)) : "",
  };

  const serialized = JSON.stringify(entry, (key, value) => {
    if (/secret|token|authorization|license.?key/i.test(key)) return "[redacted]";
    return typeof value === "string" && settings.gumroadPingSecret
      ? value.replaceAll(settings.gumroadPingSecret, "[redacted]") : value;
  });
  await fs.mkdir(path.dirname(settings.gumroadPingRawLogPath), { recursive: true });
  await fs.appendFile(
    settings.gumroadPingRawLogPath,
    `${serialized}\n`,
    "utf8",
  );
}

export function createPaymentWebhookHandler({ settings = config, ingest = ingestPaymentEvent } = {}) {
  return async (request, response) => {
    let requestUrl;
    try { requestUrl = new URL(request.url || "/", "http://localhost"); }
    catch { writeJson(response, 400, { ok: false, error: "invalid_url" }); return; }

    if (requestUrl.pathname !== settings.gumroadPingPath) {
      writeJson(response, 404, { ok: false, error: "not_found" });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, {
        ok: true,
        provider: "gumroad",
        path: settings.gumroadPingPath,
      });
      return;
    }

    if (request.method !== "POST") {
      writeJson(response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }

    let rawBody = Buffer.alloc(0);
    let payload = {};

    try {
      const chunks = [];
      let byteLength = 0;
      for await (const chunk of request) {
        byteLength += Buffer.byteLength(chunk);
        if (byteLength > settings.gumroadPingMaxBodyBytes) {
          writeJson(response, 413, { ok: false, error: "payload_too_large" });
          return;
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      rawBody = Buffer.concat(chunks);
      try { payload = parseRequestBody(request.headers["content-type"], rawBody); }
      catch { writeJson(response, 400, { ok: false, error: "invalid_body" }); return; }

      if (!hasValidSecret({ requestUrl, headers: request.headers, payload, settings })) {
        writeJson(response, 403, { ok: false, error: "invalid_secret" });
        return;
      }

      const normalized = normalizeGumroadWebhookPayload(payload, {
        resourceName: requestUrl.searchParams.get("resource_name") || "",
      });
      const result = await ingest(normalized);
      await appendRawPingLog({
        request,
        requestUrl,
        rawBody,
        payload,
        normalized,
        result,
        settings,
      }).catch((error) => console.error("Payment event log failed:", error));
      writeJson(response, 200, {
        ok: true,
        paymentEvent: result.payment_event,
      });
    } catch (error) {
      await appendRawPingLog({
        request,
        requestUrl,
        rawBody,
        payload,
        normalized: null,
        result: null,
        error,
        settings,
      }).catch(() => {});
      writeJson(response, 500, {
        ok: false,
        error: "gumroad_ping_failed",
      });
    }
  };
}

export async function startPaymentWebhookServer() {
  if (!config.gumroadPingEnabled) return null;
  if (!config.gumroadPingSecret) {
    throw new Error("GUMROAD_PING_SECRET is required when the payment webhook is enabled.");
  }
  const server = http.createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, createPaymentWebhookHandler());

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.gumroadPingPort, config.gumroadPingHost, resolve);
  });

  console.log(
    `Payment webhook server listening on http://${config.gumroadPingHost}:${config.gumroadPingPort}${config.gumroadPingPath}`,
  );

  return server;
}
