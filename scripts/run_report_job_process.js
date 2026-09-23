import fs from "node:fs/promises";

import { executeReportJobItem } from "../src/usecases/processReportJobs.js";
import { writeJsonAtomic } from "../src/shared/atomicJson.js";

// A killed worker must not leave an orphan continuing the same job after recovery.
const parentPid = Number(process.env.BOT_REPORT_PARENT_PID || 0);
const watchdog = setInterval(() => {
  if (!parentPid) return;
  try { process.kill(parentPid, 0); }
  catch {
    if (process.env.BOT_REPORT_PROCESS_GROUP === "true") {
      try { process.kill(-process.pid, "SIGTERM"); } catch {}
    }
    process.exit(1);
  }
}, 1000);
watchdog.unref();

async function main() {
  const inputPath = process.argv[2] || "";
  const outputPath = process.argv[3] || "";

  if (!inputPath || !outputPath) {
    throw new Error("usage: node scripts/run_report_job_process.js <input> <output>");
  }

  const item = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const result = await executeReportJobItem(item, async (progress) => {
    process.stdout.write(`${JSON.stringify({ type: "progress", progress })}\n`);
  });
  await writeJsonAtomic(outputPath, result);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
