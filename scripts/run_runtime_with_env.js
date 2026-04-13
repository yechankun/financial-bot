import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function resolveRunnerPath() {
  const explicit = String(process.env.FINANCIAL_BOT_INTERNAL_RUNNER || "").trim();
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.resolve(repoDir, explicit);
  }

  const siblingRepoRunner = path.resolve(repoDir, "..", "financial-bot-internal", "scripts", "run_runtime_with_env.js");
  if (fs.existsSync(siblingRepoRunner)) {
    return siblingRepoRunner;
  }

  try {
    const internalEntry = require.resolve("financial-bot-internal");
    const packageRoot = path.resolve(path.dirname(internalEntry), "..");
    const packageRunner = path.join(packageRoot, "scripts", "run_runtime_with_env.js");
    if (fs.existsSync(packageRunner)) {
      return packageRunner;
    }
  } catch {}

  throw new Error(
    [
      "Unable to find internal runtime launcher.",
      "Expected one of:",
      `- ${siblingRepoRunner}`,
      "- financial-bot-internal package with scripts/run_runtime_with_env.js",
      "- FINANCIAL_BOT_INTERNAL_RUNNER env override",
    ].join("\n"),
  );
}

const runnerPath = resolveRunnerPath();
const child = spawn(
  process.execPath,
  [runnerPath, "--workspace-root", repoDir, ...process.argv.slice(2)],
  {
    cwd: repoDir,
    stdio: "inherit",
    env: process.env,
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
