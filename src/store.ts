import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
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

export function reportPath(runId: RunId): string {
  return join(runDir(runId), "report.md");
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
  const dir = runDir(runId);
  mkdirSync(dir, { recursive: true });
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
  const dir = runDir(runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "summary.json"), `${JSON.stringify(files.summary, null, 2)}\n`, "utf8");
  writeFileSync(join(dir, "report.md"), files.markdown, "utf8");
}

export type ListedRun = {
  runId: RunId;
  createdAt: string;
  project: string;
  outcome: ReturnType<typeof listOutcome>;
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
      });
    } catch {
      continue;
    }
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

export function pidAlive(pid: number | undefined): boolean | undefined {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "EPERM") return true;
    return false;
  }
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

export function resolveRunId(arg: string | undefined): RunId {
  if (arg !== undefined && arg.length > 0) return toRunId(arg);
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
