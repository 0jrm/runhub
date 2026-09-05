#!/usr/bin/env node
import { closeSync, existsSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WAIT_MS,
  defaultModel,
  nowIso,
  outcome,
  toRunId,
  type AgentKind,
  type PromptSource,
  type ReviewKind,
} from "./domain.js";
import { loadProjects, NotInProjectsError, resolveRunCwd } from "./projects.js";
import { appendEvent, listRuns, loadView, prune, reportPath, resolveRunId, runDir, tallyLine } from "./store.js";
import { executePipeline, prepareRun } from "./pipeline.js";

const USAGE = `runhub <command>

Commands:
  run --cwd <dir|name> (--prompt <text> | --prompt - | --prompt-file <path>) [--agent cursor|claude] [--model <id>] [--review claude|none] [--timeout <duration>] [--test-cmd <cmd>]
  wait <runId> [--timeout <duration>]
  merge <runId>
  status [runId]
  report [runId]
  list
  prune --keep <n>

--prompt - reads the prompt from stdin. --prompt-file reads it from a file.
`;

const RUN_FLAGS = new Set([
  "cwd",
  "prompt",
  "prompt-file",
  "timeout",
  "test-cmd",
  "agent",
  "model",
  "review",
]);
const WAIT_FLAGS = new Set(["timeout"]);
const PRUNE_FLAGS = new Set(["keep"]);

type FlagMap = Map<string, string>;

function parseFlags(args: string[], allowed: Set<string>): { positional: string[]; flags: FlagMap } {
  const positional: string[] = [];
  const flags: FlagMap = new Map();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) break;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      let key: string;
      let value: string | undefined;
      if (eq !== -1) {
        key = a.slice(2, eq);
        value = a.slice(eq + 1);
      } else {
        key = a.slice(2);
        if (!allowed.has(key)) throw new Error(`unknown flag --${key}`);
        const next = args[i + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new Error(`flag --${key} requires a value`);
        }
        value = next;
        i += 1;
      }
      if (!allowed.has(key)) throw new Error(`unknown flag --${key}`);
      flags.set(key, value);
      continue;
    }
    positional.push(a);
  }
  return { positional, flags };
}

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

function parseAgent(raw: string | undefined): AgentKind {
  if (raw === undefined || raw === "cursor") return "cursor";
  if (raw === "claude") return "claude";
  throw new Error("--agent must be cursor or claude");
}

function parseReview(raw: string | undefined): ReviewKind {
  if (raw === undefined || raw === "none") return "none";
  if (raw === "claude") return "claude";
  throw new Error("--review must be claude or none");
}

function promptSource(flags: FlagMap): PromptSource {
  const inline = flags.get("prompt");
  const path = flags.get("prompt-file");
  if (inline !== undefined && path !== undefined) {
    throw new Error("pass either --prompt or --prompt-file, not both");
  }
  if (path !== undefined) return { kind: "file", path };
  if (inline === undefined) throw new Error("run requires --prompt or --prompt-file");
  return inline === "-" ? { kind: "stdin" } : { kind: "inline", text: inline };
}

function readPrompt(source: PromptSource): string {
  switch (source.kind) {
    case "inline":
      return source.text;
    case "file":
      return readFileSync(source.path, "utf8");
    case "stdin":
      return readFileSync(0, "utf8");
    default: {
      const _exhaustive: never = source;
      throw new Error(`unhandled prompt source: ${String(_exhaustive)}`);
    }
  }
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

type Command = "run" | "wait" | "merge" | "status" | "report" | "list" | "prune" | "help" | "__exec";

function parseCommand(raw: string | undefined): Command | undefined {
  switch (raw) {
    case "run":
    case "wait":
    case "merge":
    case "status":
    case "report":
    case "list":
    case "prune":
    case "help":
    case "__exec":
      return raw;
    default:
      return undefined;
  }
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  const command = parseCommand(args[0]);
  if (command === undefined) {
    process.stderr.write(`unknown command: ${args[0] ?? ""}\n${USAGE}`);
    return 2;
  }
  if (command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  const rest = args.slice(1);

  switch (command) {
    case "run": {
      const { flags } = parseFlags(rest, RUN_FLAGS);
      const cwdRaw = flags.get("cwd");
      if (cwdRaw === undefined) throw new Error("run requires --cwd");
      const prompt = readPrompt(promptSource(flags));
      const agent = parseAgent(flags.get("agent"));
      const review = parseReview(flags.get("review"));
      const timeoutMs = parseTimeout(flags.get("timeout"));
      const resolved = resolveRunCwd(cwdRaw, loadProjects());
      assertGitCwd(resolved.cwd);
      const runId = prepareRun({
        cwd: resolved.cwd,
        prompt,
        timeoutMs,
        testCmd: flags.get("test-cmd") ?? resolved.test,
        typecheckCmd: resolved.typecheck,
        lintCmd: resolved.lint,
        remote: resolved.remote,
        agent,
        model: flags.get("model") ?? defaultModel(agent),
        review,
      });
      const logFd = openSync(join(runDir(runId), "pipeline.log"), "a");
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "__exec", runId], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: process.env,
      });
      child.unref();
      closeSync(logFd);
      const pid = child.pid;
      if (pid === undefined) throw new Error("failed to spawn pipeline");
      appendEvent(runId, { kind: "pipeline_started", ts: nowIso(), runId, pid });
      process.stdout.write(`runhub: ${runId}\n`);
      return 0;
    }
    case "__exec": {
      const { positional } = parseFlags(rest, new Set());
      const id = positional[0];
      if (id === undefined) throw new Error("__exec requires a run id");
      const result = await executePipeline(toRunId(id));
      return result.failed ? 1 : 0;
    }
    case "wait": {
      const { positional, flags } = parseFlags(rest, WAIT_FLAGS);
      const id = resolveRunId(positional[0]);
      const timeoutMs = flags.has("timeout") ? parseTimeout(flags.get("timeout")) : DEFAULT_WAIT_MS;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          const view = loadView(id);
          if (view.status === "done" || view.status === "failed") {
            if (existsSync(reportPath(id))) process.stdout.write(readFileSync(reportPath(id), "utf8"));
            return outcome(view) === "fail" ? 1 : 0;
          }
        } catch {
          // events.jsonl may still be mid-write
        }
        if (Date.now() >= deadline) {
          process.stdout.write(`still running: ${id}\n`);
          return 3;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    case "merge": {
      const { positional } = parseFlags(rest, new Set());
      const id = resolveRunId(positional[0]);
      const view = loadView(id);
      if (view.prUrl !== undefined) {
        const r = spawnSync("gh", ["pr", "merge", view.prUrl, "--squash", "--delete-branch"], {
          encoding: "utf8",
          cwd: view.cwd,
        });
        process.stdout.write(r.stdout);
        process.stderr.write(r.stderr);
        return r.status ?? 1;
      }
      if (view.branch === undefined) throw new Error("run has no branch to merge");
      const r = spawnSync("git", ["-C", view.cwd, "merge", view.branch], { encoding: "utf8" });
      process.stdout.write(r.stdout);
      process.stderr.write(r.stderr);
      return r.status ?? 1;
    }
    case "status": {
      const { positional } = parseFlags(rest, new Set());
      const id = resolveRunId(positional[0]);
      const view = loadView(id);
      process.stdout.write(`${view.runId} ${view.status}${view.summary ? ` ${view.summary}` : ""}\n`);
      return 0;
    }
    case "report": {
      const { positional } = parseFlags(rest, new Set());
      const id = resolveRunId(positional[0]);
      process.stdout.write(readFileSync(reportPath(id), "utf8"));
      return 0;
    }
    case "list": {
      parseFlags(rest, new Set());
      const runs = listRuns();
      if (runs.length === 0) {
        process.stdout.write("(no runs)\n");
        return 0;
      }
      for (const r of runs) {
        process.stdout.write(`${r.runId} ${r.project} ${r.outcome} ${r.createdAt}\n`);
      }
      process.stdout.write(`${tallyLine(runs)}\n`);
      return 0;
    }
    case "prune": {
      const { flags } = parseFlags(rest, PRUNE_FLAGS);
      const keepRaw = flags.get("keep");
      if (keepRaw === undefined) throw new Error("prune requires --keep <n>");
      const keep = Number(keepRaw);
      if (!Number.isInteger(keep) || keep < 0) throw new Error("--keep must be a non-negative integer");
      const result = prune(keep);
      process.stderr.write(`deleted ${result.deleted.length}, kept ${result.kept.length}\n`);
      return 0;
    }
    default: {
      const _exhaustive: never = command;
      throw new Error(`unhandled command: ${String(_exhaustive)}`);
    }
  }
}

const entry = process.argv[1];
if (entry !== undefined) {
  let self = false;
  try {
    self = realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    self = fileURLToPath(import.meta.url) === resolve(entry);
  }
  if (self) {
    main(process.argv).then(
      (code) => {
        process.exit(code);
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${message}\n`);
        process.exit(err instanceof NotInProjectsError ? 2 : 1);
      },
    );
  }
}
