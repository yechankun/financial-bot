import fs from "node:fs/promises";
import path from "node:path";

const RUNS_DIR = path.resolve("runs");
const STAGE_ORDER = ["guard", "policy-search", "research", "decision", "reporting", "benchmarking"];

function parseRunStartMs(runName) {
  const match = String(runName || "").match(
    /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z/,
  );
  if (!match) {
    return null;
  }

  return Date.parse(`${match[1]}:${match[2]}:${match[3]}.${match[4]}Z`);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function statMs(targetPath) {
  try {
    return (await fs.stat(targetPath)).mtimeMs;
  } catch {
    return null;
  }
}

function formatSeconds(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.round(value * 10) / 10;
}

function formatIso(ms) {
  if (!Number.isFinite(ms)) {
    return "";
  }
  return new Date(ms).toISOString();
}

async function readJson(targetPath) {
  return JSON.parse(await fs.readFile(targetPath, "utf8"));
}

async function readStageUsage(stageDir) {
  const eventsPath = path.join(stageDir, "events.jsonl");
  if (!(await pathExists(eventsPath))) {
    return null;
  }

  const raw = await fs.readFile(eventsPath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]);
      if (event.type === "turn.completed" && event.usage) {
        return {
          input_tokens: Number(event.usage.input_tokens || 0),
          cached_input_tokens: Number(event.usage.cached_input_tokens || 0),
          output_tokens: Number(event.usage.output_tokens || 0),
        };
      }
    } catch {}
  }

  return null;
}

async function readStageTiming(stageDir) {
  const timingPath = path.join(stageDir, "timing.json");
  if (!(await pathExists(timingPath))) {
    return null;
  }
  return readJson(timingPath);
}

async function resolveTargetRunName(inputArg) {
  if (inputArg) {
    return path.basename(inputArg);
  }

  const entries = await fs.readdir(RUNS_DIR, { withFileTypes: true });
  const latest = entries
    .filter((entry) => entry.isDirectory() && entry.name.includes("druckenmiller-market-research"))
    .map((entry) => entry.name)
    .sort()
    .at(-1);

  if (!latest) {
    throw new Error("No report runs found under runs/.");
  }

  return latest;
}

async function summarizeRun(runName) {
  const runDir = path.join(RUNS_DIR, runName);
  const runStartMs = parseRunStartMs(runName);
  if (!runStartMs) {
    throw new Error(`Unable to parse run start time from run name: ${runName}`);
  }

  const stages = {};
  for (const stage of STAGE_ORDER) {
    const stageDir = path.join(runDir, stage);
    const eventsPath = path.join(stageDir, "events.jsonl");
    if (!(await pathExists(eventsPath))) {
      continue;
    }
    const endedAtMs = await statMs(eventsPath);
    const timing = await readStageTiming(stageDir);
    stages[stage] = {
      stage,
      stage_dir: stageDir,
      events_path: eventsPath,
      ended_at: timing?.finished_at || formatIso(endedAtMs),
      duration_from_run_start_s: timing?.finished_at
        ? formatSeconds((Date.parse(timing.finished_at) - runStartMs) / 1000)
        : formatSeconds((endedAtMs - runStartMs) / 1000),
      duration_s: timing?.duration_ms != null ? formatSeconds(timing.duration_ms / 1000) : null,
      usage: timing?.usage || (await readStageUsage(stageDir)),
      timing_path: timing ? path.join(stageDir, "timing.json") : "",
    };
  }

  const screenerManifestPath = path.join(
    runDir,
    "research-assets",
    "producers",
    "market",
    "market_screener_manifest.json",
  );
  const screenerEndedAtMs = await statMs(screenerManifestPath);
  const reportHtmlPath = path.join(runDir, "report", "report.html");
  const reportHtmlMs = await statMs(reportHtmlPath);
  const reportDir = path.join(runDir, "report");
  const reportEntries = (await fs.readdir(reportDir).catch(() => []))
    .filter((name) => /^page-\d+\.png$/.test(name))
    .sort();
  const reportPngTimes = await Promise.all(
    reportEntries.map(async (name) => ({
      name,
      mtimeMs: await statMs(path.join(reportDir, name)),
    })),
  );
  const lastPngMs = reportPngTimes.length > 0 ? Math.max(...reportPngTimes.map((item) => item.mtimeMs || 0)) : null;

  const guardEndMs = stages.guard ? Date.parse(stages.guard.ended_at) : null;
  const policyEndMs = stages["policy-search"] ? Date.parse(stages["policy-search"].ended_at) : null;
  const researchEndMs = stages.research ? Date.parse(stages.research.ended_at) : null;
  const decisionEndMs = stages.decision ? Date.parse(stages.decision.ended_at) : null;
  const reportingEndMs = stages.reporting ? Date.parse(stages.reporting.ended_at) : null;
  const producerEndMs = Math.max(policyEndMs || 0, screenerEndedAtMs || 0) || null;
  const reportStageAnchorMs = decisionEndMs || researchEndMs;

  const derived = {
    guard_s: guardEndMs ? formatSeconds((guardEndMs - runStartMs) / 1000) : null,
    producer_parallel_wall_s:
      guardEndMs && producerEndMs ? formatSeconds((producerEndMs - guardEndMs) / 1000) : null,
    policy_search_s:
      guardEndMs && policyEndMs ? formatSeconds((policyEndMs - guardEndMs) / 1000) : null,
    market_screener_s:
      guardEndMs && screenerEndedAtMs ? formatSeconds((screenerEndedAtMs - guardEndMs) / 1000) : null,
    research_s:
      producerEndMs && researchEndMs ? formatSeconds((researchEndMs - producerEndMs) / 1000) : null,
    decision_s:
      researchEndMs && decisionEndMs ? formatSeconds((decisionEndMs - researchEndMs) / 1000) : null,
    reporting_s:
      reportStageAnchorMs && reportingEndMs ? formatSeconds((reportingEndMs - reportStageAnchorMs) / 1000) : null,
    reporting_html_build_s:
      reportStageAnchorMs && reportHtmlMs ? formatSeconds((reportHtmlMs - reportStageAnchorMs) / 1000) : null,
    reporting_png_export_s:
      reportHtmlMs && lastPngMs ? formatSeconds((lastPngMs - reportHtmlMs) / 1000) : null,
    reporting_finalize_s:
      lastPngMs && reportingEndMs ? formatSeconds((reportingEndMs - lastPngMs) / 1000) : null,
    total_s:
      reportingEndMs ? formatSeconds((reportingEndMs - runStartMs) / 1000) : null,
  };

  const screenerManifest = (await pathExists(screenerManifestPath))
    ? await readJson(screenerManifestPath)
    : null;

  return {
    run_name: runName,
    run_dir: runDir,
    run_started_at: formatIso(runStartMs),
    screener_manifest_path: (await pathExists(screenerManifestPath)) ? screenerManifestPath : "",
    screener_summary: screenerManifest
      ? {
          stock_candidate_count: screenerManifest.stock_candidate_count,
          etf_candidate_count: screenerManifest.etf_candidate_count,
          candidate_ticker_count: screenerManifest.candidate_ticker_count,
          chart_filter: screenerManifest.chart_filter || null,
          timing: screenerManifest.timing || null,
        }
      : null,
    stages,
    derived,
    report_outputs: {
      html_path: (await pathExists(reportHtmlPath)) ? reportHtmlPath : "",
      png_count: reportEntries.length,
      png_files: reportPngTimes.map((item) => ({
        name: item.name,
        ended_at: formatIso(item.mtimeMs),
      })),
    },
  };
}

async function main() {
  const runName = await resolveTargetRunName(process.argv[2] || "");
  const summary = await summarizeRun(runName);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
