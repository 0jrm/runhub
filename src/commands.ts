import { closeSync, existsSync, openSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WAIT_MS,
  nowIso,
  outcome,
  toRunId,
  type AgentKind,
  type ReviewKind,
} from "./domain.js";
import { resolveAgentModel } from "./model.js";
import { loadProjects, resolveRunCwd } from "./projects.js";
import {
  appendEvent,
  listRuns,
  loadView,
  persistSession,
  prune,
  reportPath,
  resolveRunId,
  runDir,
  tallyLine,
} from "./store.js";
import { executePipeline, prepareRun } from "./pipeline.js";
import { followInspect, inspectText, type InspectOpts } from "./inspect.js";

export type CmdResult = { code: number; stdout: string; stderr: string };

export function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const m = raw.match(/^(\d+)(ms|s|m|h)?$/);
  if (!m?.[1]) throw new Error("invalid --timeout (use 30m, 90s, 1h, or seconds)");
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === "ms") return n;
  if (unit === "m") return n * 60 * 1000;
  if (unit === "h") return n * 60 * 60 * 1000;
  return n * 1000;
}

export function parseAgent(raw: string | undefined): AgentKind {
  if (raw === undefined || raw === "cursor") return "cursor";
  if (raw === "claude") return "claude";
  throw new Error("--agent must be cursor or claude");
}

export function parseReview(raw: string | undefined): ReviewKind {
  if (raw === undefined || raw === "none") return "none";
  if (raw === "claude") return "claude";
  throw new Error("--review must be claude or none");
}

function assertGitCwd(cwd: string): void {
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`--cwd is not a directory: ${cwd}`);
  }
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0 || r.stdout.trim() !== "true") {
    throw new Error(`--cwd is not a git repo: ${cwd}`);
  }
}

export function cliJsPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "cli.js");
}

export type RunArgs = {
  cwd: string;
  prompt: string;
  timeout?: string;
  testCmd?: string;
  agent?: string;
  model?: string;
  review?: string;
  noPreamble?: boolean;
  detach?: boolean;
};

export function launchRun(args: RunArgs): CmdResult {
  const agent = parseAgent(args.agent);
  const review = parseReview(args.review);
  const timeoutMs = parseTimeout(args.timeout);
  const model = resolveAgentModel(agent, args.model);
  const resolved = resolveRunCwd(args.cwd, loadProjects());
  assertGitCwd(resolved.cwd);
  const runId = prepareRun({
    cwd: resolved.cwd,
    prompt: args.prompt,
    timeoutMs,
    testCmd: args.testCmd ?? resolved.test,
    typecheckCmd: resolved.typecheck,
    lintCmd: resolved.lint,
    remote: resolved.remote,
    preambleFile: resolved.preamble,
    noPreamble: args.noPreamble === true,
    agent,
    model,
    review,
  });
  const logFd = openSync(join(runDir(runId), "pipeline.log"), "a");
  const child = spawn(process.execPath, [cliJsPath(), "__exec", runId], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  closeSync(logFd);
  const pid = child.pid;
  if (pid === undefined) throw new Error("failed to spawn pipeline");
  appendEvent(runId, { kind: "pipeline_started", ts: nowIso(), runId, pid });
  persistSession(runId, { pipelinePid: pid, links: { pipelinePid: String(pid) } });
  return { code: 0, stdout: `runhub: ${runId}\n`, stderr: "" };
}

export async function startRun(args: RunArgs): Promise<CmdResult> {
  const started = launchRun(args);
  if (args.detach === true) return started;
  const id = started.stdout.trim().slice("runhub: ".length);
  const timeoutMs = parseTimeout(args.timeout);
  const waitMs = Math.max(DEFAULT_WAIT_MS, timeoutMs + 60_000);
  const waited = await waitRun(id, `${waitMs}ms`);
  return {
    code: waited.code,
    stdout: `${started.stdout}${waited.stdout}`,
    stderr: waited.stderr,
  };
}

export async function execRun(id: string): Promise<CmdResult> {
  const result = await executePipeline(toRunId(id));
  return { code: result.failed ? 1 : 0, stdout: "", stderr: "" };
}

export async function waitRun(runId: string | undefined, timeoutRaw?: string): Promise<CmdResult> {
  const id = resolveRunId(runId);
  const timeoutMs = timeoutRaw !== undefined ? parseTimeout(timeoutRaw) : DEFAULT_WAIT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const view = loadView(id);
      if (view.status === "done" || view.status === "failed") {
        const stdout = existsSync(reportPath(id)) ? readFileSync(reportPath(id), "utf8") : "";
        return { code: outcome(view) === "fail" ? 1 : 0, stdout, stderr: "" };
      }
    } catch {
      // events.jsonl may still be mid-write
    }
    if (Date.now() >= deadline) {
      return { code: 3, stdout: `still running: ${id}\n`, stderr: "" };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

export function mergeRun(runId: string | undefined): CmdResult {
  const id = resolveRunId(runId);
  const view = loadView(id);
  if (view.prUrl !== undefined) {
    const r = spawnSync("gh", ["pr", "merge", view.prUrl, "--squash", "--delete-branch"], {
      encoding: "utf8",
      cwd: view.cwd,
    });
    return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  }
  if (view.branch === undefined) throw new Error("run has no branch to merge");
  const r = spawnSync("git", ["-C", view.cwd, "merge", view.branch], { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

export function statusRun(runId: string | undefined): CmdResult {
  const view = loadView(resolveRunId(runId));
  return {
    code: 0,
    stdout: `${view.runId} ${view.status}${view.summary ? ` ${view.summary}` : ""}\n`,
    stderr: "",
  };
}

export function reportRun(runId: string | undefined): CmdResult {
  return { code: 0, stdout: readFileSync(reportPath(resolveRunId(runId)), "utf8"), stderr: "" };
}

export function listRun(): CmdResult {
  const runs = listRuns();
  if (runs.length === 0) return { code: 0, stdout: "(no runs)\n", stderr: "" };
  let stdout = "";
  for (const r of runs) {
    stdout += `${r.runId} ${r.project} ${r.outcome} ${r.blocked ? "blocked" : "-"} ${r.createdAt}\n`;
  }
  stdout += `${tallyLine(runs)}\n`;
  return { code: 0, stdout, stderr: "" };
}

export function pruneRuns(keepRaw: string): CmdResult {
  const keep = Number(keepRaw);
  if (!Number.isInteger(keep) || keep < 0) throw new Error("--keep must be a non-negative integer");
  const result = prune(keep);
  return { code: 0, stdout: "", stderr: `deleted ${result.deleted.length}, kept ${result.kept.length}\n` };
}

export function inspectRun(opts: InspectOpts): CmdResult {
  return { code: 0, stdout: inspectText(opts), stderr: "" };
}

export async function inspectRunMaybeFollow(
  opts: InspectOpts,
  write: (chunk: string) => void,
): Promise<CmdResult> {
  if (opts.follow === true) {
    await followInspect(opts, write);
    return { code: 0, stdout: "", stderr: "" };
  }
  return inspectRun(opts);
}
