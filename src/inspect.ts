import { existsSync, readFileSync, statSync } from "node:fs";
import { lastLines, listOutcome, type RunId } from "./domain.js";
import {
  emptySession,
  loadView,
  pidAlive,
  pipelineLogPath,
  readSession,
  resolveInspectRunId,
  type RunSession,
} from "./store.js";

export const DEFAULT_INSPECT_LINES = 20;
export type TailKind = "agent" | "review" | "verify" | "all";

export type InspectOpts = {
  runId?: string;
  n?: number;
  tail?: TailKind;
  linksOnly?: boolean;
  noTail?: boolean;
  json?: boolean;
  follow?: boolean;
};

export type InspectSnapshot = {
  runId: string;
  status: string;
  worktree: string;
  session: RunSession;
  links: Record<string, string>;
  tails: { agent?: string; review?: string; verify?: string };
};

const URL_RE = /https?:\/\/[^\s"'<>]+/g;

export function parseTailKind(raw: string | undefined): TailKind {
  if (raw === undefined || raw === "all") return "all";
  if (raw === "agent" || raw === "review" || raw === "verify") return raw;
  throw new Error("--tail must be agent, review, verify, or all");
}

function fileTail(path: string, n: number): string {
  if (!existsSync(path) || !statSync(path).isFile()) return "";
  return lastLines(readFileSync(path, "utf8"), n);
}

function urlsIn(path: string): string[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  return text.match(URL_RE) ?? [];
}

export function sessionFromRun(runId: RunId): RunSession {
  const stored = readSession(runId);
  const session = stored ?? emptySession(runId);
  try {
    const view = loadView(runId);
    if (view.pipelinePid !== undefined) session.pipelinePid = view.pipelinePid;
    if (view.prUrl !== undefined) session.links.pr = view.prUrl;
    if (view.branch !== undefined) session.links.branch = view.branch;
  } catch {
    // events.jsonl may be missing on a half-written dir
  }
  if (session.pipelinePid !== undefined) session.links.pipelinePid = String(session.pipelinePid);
  if (session.agentPgid !== undefined) session.links.agentPgid = String(session.agentPgid);
  if (session.reviewPgid !== undefined) session.links.reviewPgid = String(session.reviewPgid);
  let i = 0;
  for (const path of [session.logs.agentStdout, session.logs.review, session.logs.pipeline]) {
    for (const url of urlsIn(path)) {
      i += 1;
      const key = `url${i}`;
      if (session.links[key] === undefined) session.links[key] = url;
    }
  }
  return session;
}

export function snapshotInspect(opts: InspectOpts): InspectSnapshot {
  const id = resolveInspectRunId(opts.runId);
  const n = opts.n ?? DEFAULT_INSPECT_LINES;
  const tail = opts.tail ?? "all";
  const view = loadView(id);
  const session = sessionFromRun(id);
  const status = listOutcome(view, Date.now(), pidAlive(view.pipelinePid));
  const tails: InspectSnapshot["tails"] = {};
  const wantTail = opts.linksOnly !== true && opts.noTail !== true;
  if (wantTail && (tail === "all" || tail === "agent")) {
    const out = fileTail(session.logs.agentStdout, n);
    const err = fileTail(session.logs.agentStderr, n);
    tails.agent = [out, err].filter((s) => s.length > 0).join("\n");
  }
  if (wantTail && (tail === "all" || tail === "review")) {
    tails.review = fileTail(session.logs.review, n);
  }
  if (wantTail && (tail === "all" || tail === "verify")) {
    const fromView = view.verify?.testTail;
    tails.verify =
      fromView !== undefined && fromView.length > 0 ? lastLines(fromView, n) : fileTail(pipelineLogPath(id), n);
  }
  return {
    runId: id,
    status,
    worktree: session.worktree,
    session,
    links: session.links,
    tails,
  };
}

export function renderInspect(snap: InspectSnapshot, json: boolean): string {
  if (json) return `${JSON.stringify(snap, null, 2)}\n`;
  let out = `run ${snap.runId} ${snap.status}\nworktree: ${snap.worktree}\nlinks:\n`;
  const keys = Object.keys(snap.links).sort();
  for (const key of keys) {
    const value = snap.links[key];
    if (value !== undefined) out += `  ${key}: ${value}\n`;
  }
  for (const name of ["agent", "review", "verify"] as const) {
    const body = snap.tails[name];
    if (body === undefined) continue;
    out += `--- ${name} ---\n`;
    if (body.length > 0) out += `${body}\n`;
  }
  return out;
}

export function inspectText(opts: InspectOpts): string {
  return renderInspect(snapshotInspect(opts), opts.json === true);
}

function logPaths(snap: InspectSnapshot, tail: TailKind): string[] {
  const logs = snap.session.logs;
  if (tail === "agent") return [logs.agentStdout, logs.agentStderr];
  if (tail === "review") return [logs.review];
  if (tail === "verify") return [logs.pipeline];
  return [logs.agentStdout, logs.agentStderr, logs.review, logs.pipeline];
}

function readOffset(path: string): { size: number; text: string } {
  if (!existsSync(path) || !statSync(path).isFile()) return { size: 0, text: "" };
  const text = readFileSync(path, "utf8");
  return { size: text.length, text };
}

export async function followInspect(opts: InspectOpts, write: (chunk: string) => void): Promise<void> {
  const snap = snapshotInspect({ ...opts, follow: false });
  write(renderInspect(snap, opts.json === true));
  if (opts.follow !== true || opts.json === true || opts.linksOnly === true) return;
  const pid = snap.session.pipelinePid;
  if (pidAlive(pid) !== true) return;
  const tail = opts.tail ?? "all";
  const offsets = new Map<string, number>();
  for (const path of logPaths(snap, tail)) {
    offsets.set(path, readOffset(path).size);
  }
  while (pidAlive(pid) === true) {
    await new Promise((r) => setTimeout(r, 200));
    for (const path of logPaths(snap, tail)) {
      const got = readOffset(path);
      const prev = offsets.get(path) ?? 0;
      if (got.size > prev) {
        write(got.text.slice(prev));
        offsets.set(path, got.size);
      }
    }
  }
}
