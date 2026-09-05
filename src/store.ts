import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseEventJson, toRunId, type Event, type RunId, type RunView } from "./domain.js";
import { reduce } from "./reduce.js";

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

export function agentStdoutPath(runId: RunId): string {
  return join(runDir(runId), "agent.stdout");
}

export function promptPath(runId: RunId): string {
  return join(runDir(runId), "prompt.txt");
}

export function reportPath(runId: RunId): string {
  return join(runDir(runId), "report.md");
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

export type ListedRun = { runId: RunId; createdAt: string; status: RunView["status"] };

export function listRuns(): ListedRun[] {
  const root = runsRoot();
  mkdirSync(root, { recursive: true });
  const out: ListedRun[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const id = toRunId(name);
      const view = loadView(id);
      out.push({ runId: id, createdAt: view.createdAt, status: view.status });
    } catch {
      continue;
    }
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
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
    rmSync(runDir(r.runId), { recursive: true, force: true });
    deleted.push(r.runId);
  }
  return { kept: listRuns().map((r) => r.runId), deleted };
}
