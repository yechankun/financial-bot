import { spawn } from "node:child_process";

import { config } from "../config.js";

function parseTunnelUrl(text) {
  const matches = String(text || "").match(/https:\/\/[^\s"'`<>]+/gi) || [];
  for (const raw of matches) {
    try {
      const parsed = new URL(raw);
      const host = String(parsed.hostname || "").toLowerCase();
      if (
        (host === "localhost.run" && !String(parsed.pathname || "").startsWith("/docs")) ||
        (host.endsWith(".localhost.run") && !host.startsWith("admin.")) ||
        host.endsWith(".lhr.life")
      ) {
        return `${parsed.protocol}//${parsed.host}`;
      }
    } catch {
      continue;
    }
  }
  return "";
}

async function waitForHealthyTunnel(baseUrl) {
  const deadline = Date.now() + config.gumroadTunnelStartupTimeoutMs;
  const targetUrl = `${String(baseUrl).replace(/\/+$/, "")}${config.gumroadPingPath}`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(targetUrl, { method: "GET" });
      if (response.ok) {
        return true;
      }
    } catch {
      // keep polling until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}

export async function startLocalhostRunTunnel() {
  if (!config.gumroadTunnelEnabled) {
    return null;
  }

  const remotePort = String(config.gumroadTunnelRemotePort || 80);
  const localHost = config.gumroadTunnelLocalHost || config.gumroadPingHost;
  const localPort = String(config.gumroadTunnelLocalPort || config.gumroadPingPort);
  const target = `${remotePort}:${localHost}:${localPort}`;
  const destination = config.gumroadTunnelDestination || "nokey@localhost.run";

  const child = spawn(
    "ssh",
    [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "ServerAliveInterval=30",
      "-R",
      target,
      destination,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let resolved = false;

  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (resolved) {
        return;
      }
      resolved = true;
      reject(new Error("localhost.run 터널 주소를 시간 안에 받지 못했다냥."));
    }, config.gumroadTunnelStartupTimeoutMs);

    const handleOutput = (chunk) => {
      const text = chunk.toString("utf8");
      const tunnelUrl = parseTunnelUrl(text);
      if (!tunnelUrl || resolved) {
        return;
      }
      void (async () => {
        const healthy = await waitForHealthyTunnel(tunnelUrl);
        if (!healthy || resolved) {
          return;
        }
        resolved = true;
        clearTimeout(timeout);
        resolve(tunnelUrl);
      })();
    };

    child.stdout.on("data", handleOutput);
    child.stderr.on("data", handleOutput);
    child.once("error", (error) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `localhost.run 터널이 주소를 출력하기 전에 종료됐다냥. code=${code ?? "null"} signal=${signal ?? "null"}`,
        ),
      );
    });
  });

  console.log(`Payment webhook public URL: ${url}${config.gumroadPingPath}`);

  return {
    url,
    child,
    stop() {
      if (!child.killed) {
        child.kill("SIGINT");
      }
    },
  };
}
