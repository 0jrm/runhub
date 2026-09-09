import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { listOutcome, parseEventJson, toRunId, type Event, type RunId, type RunView } from "./domain.js";
import { reduce } from "./reduce.js";
import { removeRunWorktree } from "./git.js";

export function dataRoot(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.length > 0) return join(xdg, "runhub");
  return join(homedir(), ".local", "share", "runhub");
}

export function runsRoot(): string {
  return join(dataRoot(), "runs");
}

export function runDir(runId: RunId): string {
  return join(runsRoot(), runId);
}

export function ensureRunDir(runId: RunId): string {
  const dir = runDir(runId);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  return dir;
}

export function worktreePath(runId: RunId): string {
  return join(runDir(runId), "tree");
}

export function agentStdoutPath(runId: RunId): string {
  return join(runDir(runId), "agent.stdout");
}

export function agentStderrPath(runId: RunId): string {
  return join(runDir(runId), "agent.stderr");
}

export function promptPath(runId: RunId): string {
  return join(runDir(runId), "prompt.txt");
}

export function specPath(runId: RunId): string {
  return join(runDir(runId), "spec.txt");
}

export function preamblePath(runId: RunId): string {
  return join(runDir(runId), "preamble.txt");
}

export function reportPath(runId: RunId): string {
  return join(runDir(runId), "report.md");
}

export function pipelineLogPath(runId: RunId): string {
  return join(runDir(runId), "pipeline.log");
}

export function sessionPath(runId: RunId): string {
  return join(runDir(runId), "session.json");
}

export type RunSession = {
  runId: string;
  worktree: string;
  runDir: string;
  pipelinePid?: number;
  agentPgid?: number;
  reviewPgid?: number;
  logs: {
    pipeline: string;
    agentStdout: string;
    agentStderr: string;
    review: string;
    report: string;
  };
  links: Record<string, string>;
};

export function emptySession(runId: RunId): RunSession {
  const dir = runDir(runId);
  const tree = worktreePath(runId);
  const logs = {
    pipeline: pipelineLogPath(runId),
    agentStdout: agentStdoutPath(runId),
    agentStderr: agentStderrPath(runId),
    review: reviewPath(runId),
    report: reportPath(runId),
  };
  return {
    runId,
    worktree: tree,
    runDir: dir,
    logs,
    links: {
      runDir: dir,
      worktree: tree,
      pipeline: logs.pipeline,
      agentStdout: logs.agentStdout,
      agentStderr: logs.agentStderr,
      review: logs.review,
      report: logs.report,
    },
  };
}

export function readSession(runId: RunId): RunSession | undefined {
  const path = sessionPath(runId);
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const rec = parsed as Record<string, unknown>;
    const base = emptySession(runId);
    if (typeof rec.worktree === "string") base.worktree = rec.worktree;
    if (typeof rec.runDir === "string") base.runDir = rec.runDir;
    if (typeof rec.pipelinePid === "number") base.pipelinePid = rec.pipelinePid;
    if (typeof rec.agentPgid === "number") base.agentPgid = rec.agentPgid;
    if (typeof rec.reviewPgid === "number") base.reviewPgid = rec.reviewPgid;
    if (typeof rec.logs === "object" && rec.logs !== null && !Array.isArray(rec.logs)) {
      const logs = rec.logs as Record<string, unknown>;
      for (const key of ["pipeline", "agentStdout", "agentStderr", "review", "report"] as const) {
        if (typeof logs[key] === "string") base.logs[key] = logs[key];
      }
    }
    if (typeof rec.links === "object" && rec.links !== null && !Array.isArray(rec.links)) {
      const links = rec.links as Record<string, unknown>;
      for (const [k, v] of Object.entries(links)) {
        if (typeof v === "string" && v.length > 0) base.links[k] = v;
      }
    }
    return base;
  } catch {
    return undefined;
  }
}

export function persistSession(runId: RunId, patch: Partial<RunSession> & { links?: Record<string, string> }): RunSession {
  const current = readSession(runId) ?? emptySession(runId);
  const next: RunSession = {
    ...current,
    ...patch,
    logs: { ...current.logs, ...(patch.logs ?? {}) },
    links: { ...current.links, ...(patch.links ?? {}) },
  };
  if (patch.pipelinePid === undefined && current.pipelinePid !== undefined) next.pipelinePid = current.pipelinePid;
  writeFileSync(sessionPath(runId), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export function reviewPath(runId: RunId): string {
  return join(runDir(runId), "review.md");
}

export function porcelainPath(runId: RunId): string {
  return join(runDir(runId), "porcelain.txt");
}

export function newRunId(): RunId {
  return toRunId(randomUUID());
}

export function appendEvent(runId: RunId, event: Event): void {
  const dir = ensureRunDir(runId);
  appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

export function readEvents(runId: RunId): Event[] {
  const path = join(runDir(runId), "events.jsonl");
  const text = readFileSync(path, "utf8");
  const events: Event[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    events.push(parseEventJson(trimmed));
  }
  return events;
}

export function loadView(runId: RunId): RunView {
  return reduce(readEvents(runId));
}

export function writeArtifacts(runId: RunId, files: { summary: unknown; markdown: string }): void {
  const dir = ensureRunDir(runId);
  writeFileSync(join(dir, "summary.json"), `${JSON.stringify(files.summary, null, 2)}\n`, "utf8");
  writeFileSync(join(dir, "report.md"), files.markdown, "utf8");
}

export type ListedRun = {
  runId: RunId;
  createdAt: string;
  project: string;
  outcome: ReturnType<typeof listOutcome>;
  blocked: boolean;
};

export function listRuns(now = Date.now()): ListedRun[] {
  const root = runsRoot();
  mkdirSync(root, { recursive: true });
  const out: ListedRun[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const id = toRunId(name);
      const view = loadView(id);
      out.push({
        runId: id,
        createdAt: view.createdAt,
        project: basename(view.cwd),
        outcome: listOutcome(view, now, pidAlive(view.pipelinePid)),
        blocked: view.blockedLine !== undefined,
      });
    } catch {
      continue;
    }
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

function procState(pid: number): string | undefined {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = text.lastIndexOf(")");
    if (close < 0) return undefined;
    const rest = text.slice(close + 2);
    return rest[0];
  } catch {
    return undefined;
  }
}

export function pidAlive(pid: number | undefined): boolean | undefined {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "EPERM") return true;
    return false;
  }
  if (procState(pid) === "Z") return false;
  return true;
}

export function tallyLine(runs: readonly ListedRun[], n = 30): string {
  const slice = runs.slice(-n);
  const counts: Record<"pass" | "fail" | "changed-untested" | "no-changes" | "running", number> = {
    pass: 0,
    fail: 0,
    "changed-untested": 0,
    "no-changes": 0,
    running: 0,
  };
  for (const r of slice) {
    const o = r.outcome;
    if (o === "pass" || o === "fail" || o === "changed-untested" || o === "no-changes" || o === "running") {
      counts[o] += 1;
    }
  }
  return `last 30: ${counts.pass} pass, ${counts.fail} fail, ${counts["changed-untested"]} changed-untested, ${counts["no-changes"]} no-changes, ${counts.running} running`;
}

export function latestRunId(): RunId | undefined {
  const runs = listRuns();
  const last = runs[runs.length - 1];
  return last?.runId;
}

export function latestRunningRunId(now = Date.now()): RunId | undefined {
  const root = runsRoot();
  mkdirSync(root, { recursive: true });
  const running: { runId: RunId; createdAt: string }[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const id = toRunId(name);
      const view = loadView(id);
      if (pidAlive(view.pipelinePid) !== true) continue;
      running.push({ runId: id, createdAt: view.createdAt });
    } catch {
      continue;
    }
  }
  running.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return running[running.length - 1]?.runId;
}

export function resolveRunId(arg: string | undefined): RunId {
  if (arg !== undefined && arg.length > 0) return toRunId(arg);
  const latest = latestRunId();
  if (!latest) throw new Error("no runs stored");
  return latest;
}

/** Default inspect target: newest running run, else most recent run. */
export function resolveInspectRunId(arg: string | undefined, now = Date.now()): RunId {
  if (arg !== undefined && arg.length > 0) return toRunId(arg);
  const running = latestRunningRunId(now);
  if (running !== undefined) return running;
  const latest = latestRunId();
  if (!latest) throw new Error("no runs stored");
  return latest;
}

function cleanupRun(runId: RunId): void {
  try {
    const view = loadView(runId);
    if (view.branch && existsSync(view.cwd)) {
      removeRunWorktree({ repo: view.cwd, tree: worktreePath(runId), branch: view.branch });
    }
  } catch {
    return;
  } finally {
    rmSync(runDir(runId), { recursive: true, force: true });
  }
}

export function prune(keep: number): { kept: RunId[]; deleted: RunId[] } {
  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error("--keep must be a non-negative integer");
  }
  const runs = listRuns();
  const deleted: RunId[] = [];
  const excess = runs.length - keep;
  if (excess <= 0) return { kept: runs.map((r) => r.runId), deleted };
  const toDelete = runs.slice(0, excess);
  for (const r of toDelete) {
    cleanupRun(r.runId);
    deleted.push(r.runId);
  }
  return { kept: listRuns().map((r) => r.runId), deleted };
}
