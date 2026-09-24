import "./setup.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { testRoot } from "./setup.js";
import { REQUIRED_INTERNAL_API } from "../src/gateways/internal/provider.js";

const providerUrl = new URL("../src/gateways/internal/provider.js", import.meta.url).href;
function run(code, env = {}, cwd = process.cwd()) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: 10_000,
  });
}

test("public mode imports without private engine or Discord credentials", () => {
  const child = run('await import("./src/startRuntime.js")', {
    DISCORD_BOT_TOKEN: "", DISCORD_APPLICATION_ID: "", INTERNAL_PROVIDER_MODE: "disabled",
  });
  assert.equal(child.status, 0, child.stderr);
});

test("explicit provider wins over sibling, and a broken override never falls back", async () => {
  const workspace = path.join(testRoot, "provider-workspace");
  const sibling = path.join(testRoot, "financial-bot-internal", "src");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(sibling, { recursive: true });
  await fs.writeFile(path.join(testRoot, "package.json"), '{"type":"module"}');
  await fs.writeFile(path.join(sibling, "index.js"), 'export const marker="wrong sibling";');
  const explicit = path.join(testRoot, "explicit.mjs");
  await fs.writeFile(explicit, 'export const marker="explicit";');
  const code = `const m=await import(${JSON.stringify(providerUrl)}); console.log(JSON.stringify(m.getInternalProviderStatus()));`;
  const child = run(code, { INTERNAL_PROVIDER_MODE: "package", INTERNAL_PROVIDER_PACKAGE: explicit }, workspace);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).packageSpecifier, explicit);
  const missing = run(code, { INTERNAL_PROVIDER_MODE: "package", INTERNAL_PROVIDER_PACKAGE: `${explicit}.missing` }, workspace);
  assert.equal(JSON.parse(missing.stdout).available, false);
});

test("invalid concurrency fails configuration instead of silently stopping the queue", () => {
  const child = run('await import("./src/config.js")', { REPORT_JOB_CONCURRENCY: "not-a-number" });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /positive integer/);
});

const statusCode = `const m=await import(${JSON.stringify(providerUrl)}); console.log(JSON.stringify(m.getInternalProviderStatus()));`;

test("every internal function the public runtime calls is declared in the provider API contract", async () => {
  const namespaces = Object.keys(REQUIRED_INTERNAL_API).join("|");
  const used = new Set();
  for (const file of (await fs.readdir("src", { recursive: true })).filter((name) => name.endsWith(".js"))) {
    const text = await fs.readFile(path.join("src", file), "utf8");
    for (const [, ns, fn] of text.matchAll(new RegExp(`\\b(${namespaces})\\.([A-Za-z0-9_]+)`, "g"))) used.add(`${ns}.${fn}`);
  }
  const declared = new Set(Object.entries(REQUIRED_INTERNAL_API).flatMap(([ns, fns]) => fns.map((fn) => `${ns}.${fn}`)));
  assert.ok(used.size > 40, "scan found the gateway calls");
  assert.deepEqual([...used].filter((name) => !declared.has(name)).sort(), []);
});

test("a provider older than this runtime is reported with its missing functions", async () => {
  const partial = path.join(testRoot, "partial-provider.mjs");
  await fs.writeFile(partial, "export const internalResearch = { createRunId() {} };");
  const complete = path.join(testRoot, "complete-provider.mjs");
  await fs.writeFile(complete, Object.entries(REQUIRED_INTERNAL_API)
    .map(([ns, fns]) => `export const ${ns} = { ${fns.map((fn) => fn === "getMarketDataCapabilities"
      ? `${fn}() { return { contractVersion: 1, tradingViewFallback: false }; }`
      : `${fn}() {}`).join(", ")} };`).join("\n"));
  const stale = JSON.parse(run(statusCode, { INTERNAL_PROVIDER_MODE: "package", INTERNAL_PROVIDER_PACKAGE: partial }).stdout);
  assert.equal(stale.available, true);
  assert.ok(stale.missingApi.includes("internalResearch.runResearchJob"));
  assert.ok(!stale.missingApi.includes("internalResearch.createRunId"));
  const current = JSON.parse(run(statusCode, { INTERNAL_PROVIDER_MODE: "package", INTERNAL_PROVIDER_PACKAGE: complete }).stdout);
  assert.deepEqual(current.missingApi, []);
  const incompatible = path.join(testRoot, "incompatible-provider.mjs");
  await fs.writeFile(incompatible, Object.entries(REQUIRED_INTERNAL_API)
    .map(([ns, fns]) => `export const ${ns} = { ${fns.map((fn) => fn === "getMarketDataCapabilities"
      ? `${fn}() { return { contractVersion: 0 }; }`
      : `${fn}() {}`).join(", ")} };`).join("\n"));
  const incompatibleStatus = JSON.parse(run(statusCode, {
    INTERNAL_PROVIDER_MODE: "package", INTERNAL_PROVIDER_PACKAGE: incompatible,
  }).stdout);
  assert.ok(incompatibleStatus.missingApi.includes("market-data-contract-v1"));
});

test("public provider injects its chart renderer into legacy internal screener calls", async () => {
  const legacy = path.join(testRoot, "legacy-chart-provider.mjs");
  await fs.writeFile(legacy, [
    "export const internalMarketStorage = {",
    "  async generateReportScreenerArtifacts(request) {",
    "    return { renderBatchType: typeof request.renderBatch };",
    "  },",
    "};",
  ].join("\n"));
  const code = `const m=await import(${JSON.stringify(providerUrl)}); console.log(JSON.stringify(await m.internalMarketStorage.generateReportScreenerArtifacts({})));`;
  const child = run(code, { INTERNAL_PROVIDER_MODE: "package", INTERNAL_PROVIDER_PACKAGE: legacy });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).renderBatchType, "function");
});

const siblingEntry = path.resolve("../financial-bot-internal/src/index.js");
test("the sibling internal checkout satisfies the provider API contract", { skip: !existsSync(siblingEntry) && "no sibling checkout" }, () => {
  const status = JSON.parse(run(statusCode, { INTERNAL_PROVIDER_MODE: "package", INTERNAL_PROVIDER_PACKAGE: siblingEntry }).stdout);
  assert.equal(status.available, true, status.error);
  assert.deepEqual(status.missingApi, []);
});
