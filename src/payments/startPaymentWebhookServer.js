import http from "node:http";
import fs from "node:fs/promises";

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

function hasValidSecret({ requestUrl, headers, payload }) {
  if (!config.gumroadPingSecret) {
    return true;
  }

  const querySecret = requestUrl.searchParams.get("secret") || "";
  const headerSecret = headers["x-gumroad-secret"] || headers["x-webhook-secret"] || "";
  const payloadSecret =
    (payload && typeof payload === "object" && (payload.secret || payload.token)) || "";

  return (
    String(querySecret) === config.gumroadPingSecret ||
    String(headerSecret) === config.gumroadPingSecret ||
    String(payloadSecret) === config.gumroadPingSecret
  );
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

async function appendRawPingLog({ request, requestUrl, rawBody, payload, normalized, result, error }) {
  if (!config.gumroadPingRawLogPath) {
    return;
  }

  const entry = {
    receivedAt: new Date().toISOString(),
    method: request.method || "",
    path: requestUrl.pathname,
    query: Object.fromEntries(requestUrl.searchParams.entries()),
    headers: request.headers,
    rawBody: rawBody.toString("utf8"),
    payload,
    normalized,
    result,
    error: error ? (error instanceof Error ? error.message : String(error)) : "",
  };

  await fs.appendFile(
    config.gumroadPingRawLogPath,
    `${JSON.stringify(entry, null, 2)}\n`,
    "utf8",
  );
}

export async function startPaymentWebhookServer() {
  if (!config.gumroadPingEnabled) {
    return null;
  }

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(
      request.url || "/",
      `http://${request.headers.host || "localhost"}`,
    );

    if (requestUrl.pathname !== config.gumroadPingPath) {
      writeJson(response, 404, { ok: false, error: "not_found" });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, {
        ok: true,
        provider: "gumroad",
        path: config.gumroadPingPath,
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
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      rawBody = Buffer.concat(chunks);
      payload = parseRequestBody(request.headers["content-type"], rawBody);

      if (!hasValidSecret({ requestUrl, headers: request.headers, payload })) {
        writeJson(response, 403, { ok: false, error: "invalid_secret" });
        return;
      }

      const normalized = normalizeGumroadWebhookPayload(payload, {
        resourceName: requestUrl.searchParams.get("resource_name") || "",
      });
      const result = await ingestPaymentEvent(normalized);
      await appendRawPingLog({
        request,
        requestUrl,
        rawBody,
        payload,
        normalized,
        result,
      });
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
      }).catch(() => {});
      writeJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : "gumroad_ping_failed",
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.gumroadPingPort, config.gumroadPingHost, resolve);
  });

  console.log(
    `Payment webhook server listening on http://${config.gumroadPingHost}:${config.gumroadPingPort}${config.gumroadPingPath}`,
  );

  return server;
}
