import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

export const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "financial-bot-test-"));
process.env.DOTENV_CONFIG_PATH = "/dev/null";
process.env.INTERNAL_PROVIDER_MODE = "disabled";
process.env.BOT_RUNTIME_ROOT_DIR = testRoot;
process.env.INTERNAL_RUNTIME_ROOT_DIR = testRoot;
process.env.GUMROAD_PING_RAW_LOG_PATH = "";
process.env.GUMROAD_PING_ENABLED = "false";
process.env.AUTO_REPORT_ENABLED = "false";
process.env.AUTO_REPORT_GUILD_ID = "";
process.env.BOT_RUNTIME_ROLE = "standalone";
delete process.env.BOT_CAPABILITIES;
for (const prefix of ["BOT", "INTERNAL"]) {
  for (const part of ["DATA", "RUNS", "BENCHMARK", "CHARTS"]) delete process.env[`${prefix}_${part}_DIR`];
}
after(() => fs.rmSync(testRoot, { recursive: true, force: true }));
