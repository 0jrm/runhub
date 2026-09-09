#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NotInProjectsError } from "./projects.js";
import {
  execRun,
  inspectRunMaybeFollow,
  listRun,
  mergeRun,
  parseTimeout,
  pruneRuns,
  reportRun,
  startRun,
  statusRun,
  waitRun,
  type CmdResult,
} from "./commands.js";
import { parseTailKind } from "./inspect.js";

export { parseTimeout };

const USAGE = `runhub <command>

Commands:
  run --cwd <dir|name> (--prompt <text> | --prompt - | --prompt-file <path>) [--agent cursor|claude] [--model <id>] [--review claude|none] [--timeout <duration>] [--test-cmd <cmd>] [--no-preamble]
  wait <runId> [--timeout <duration>]
  merge <runId>
  status [runId]
  report [runId]
  list
  inspect [runId] [-f|--follow] [-n <lines>] [--tail agent|review|verify|all] [--links-only] [--no-tail] [--json]
  prune --keep <n>

--prompt - reads the prompt from stdin. --prompt-file reads it from a file.
inspect with no run id uses the latest running run, or the most recent run if none are running.
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
  "no-preamble",
]);
const RUN_SWITCHES = new Set(["no-preamble"]);
const WAIT_FLAGS = new Set(["timeout"]);
const PRUNE_FLAGS = new Set(["keep"]);
const INSPECT_FLAGS = new Set(["follow", "n", "tail", "links-only", "no-tail", "json"]);
const INSPECT_SWITCHES = new Set(["follow", "links-only", "no-tail", "json"]);
const INSPECT_SHORTS: Record<string, string> = { f: "follow", n: "n" };

type FlagMap = Map<string, string>;

function parseFlags(
  args: string[],
  allowed: Set<string>,
  switches: Set<string> = new Set(),
  shorts: Record<string, string> = {},
): { positional: string[]; flags: FlagMap } {
  const positional: string[] = [];
  const flags: FlagMap = new Map();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) break;
    if (a === "--" || a === "-") {
      positional.push(a);
      continue;
    }
    let long: string | undefined;
    let inline: string | undefined;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        long = a.slice(2, eq);
        inline = a.slice(eq + 1);
      } else {
        long = a.slice(2);
      }
    } else if (a.startsWith("-") && a.length >= 2) {
      const letter = a.slice(1, 2);
      long = shorts[letter];
      if (long === undefined) throw new Error(`unknown flag ${a}`);
      if (a.length > 2) inline = a.slice(2);
    }
    if (long !== undefined) {
      if (inline !== undefined) {
        if (switches.has(long)) throw new Error(`flag --${long} takes no value`);
        if (!allowed.has(long)) throw new Error(`unknown flag --${long}`);
        flags.set(long, inline);
        continue;
      }
      if (!allowed.has(long)) throw new Error(`unknown flag --${long}`);
      if (switches.has(long)) {
        flags.set(long, "");
        continue;
      }
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`flag --${long} requires a value`);
      }
      flags.set(long, next);
      i += 1;
      continue;
    }
    positional.push(a);
  }
  return { positional, flags };
}

function promptText(flags: FlagMap): string {
  const inline = flags.get("prompt");
  const path = flags.get("prompt-file");
  if (inline !== undefined && path !== undefined) {
    throw new Error("pass either --prompt or --prompt-file, not both");
  }
  if (path !== undefined) return readFileSync(path, "utf8");
  if (inline === undefined) throw new Error("run requires --prompt or --prompt-file");
  return inline === "-" ? readFileSync(0, "utf8") : inline;
}

function writeResult(result: CmdResult): number {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.code;
}

type Command = "run" | "wait" | "merge" | "status" | "report" | "list" | "inspect" | "prune" | "help" | "__exec";

function parseCommand(raw: string | undefined): Command | undefined {
  switch (raw) {
    case "run":
    case "wait":
    case "merge":
    case "status":
    case "report":
    case "list":
    case "inspect":
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
      const { flags } = parseFlags(rest, RUN_FLAGS, RUN_SWITCHES);
      const cwdRaw = flags.get("cwd");
      if (cwdRaw === undefined) throw new Error("run requires --cwd");
      return writeResult(
        startRun({
          cwd: cwdRaw,
          prompt: promptText(flags),
          timeout: flags.get("timeout"),
          testCmd: flags.get("test-cmd"),
          agent: flags.get("agent"),
          model: flags.get("model"),
          review: flags.get("review"),
          noPreamble: flags.has("no-preamble"),
        }),
      );
    }
    case "__exec": {
      const { positional } = parseFlags(rest, new Set());
      const id = positional[0];
      if (id === undefined) throw new Error("__exec requires a run id");
      return writeResult(await execRun(id));
    }
    case "wait": {
      const { positional, flags } = parseFlags(rest, WAIT_FLAGS);
      return writeResult(await waitRun(positional[0], flags.get("timeout")));
    }
    case "merge": {
      const { positional } = parseFlags(rest, new Set());
      return writeResult(mergeRun(positional[0]));
    }
    case "status": {
      const { positional } = parseFlags(rest, new Set());
      return writeResult(statusRun(positional[0]));
    }
    case "report": {
      const { positional } = parseFlags(rest, new Set());
      return writeResult(reportRun(positional[0]));
    }
    case "list": {
      parseFlags(rest, new Set());
      return writeResult(listRun());
    }
    case "inspect": {
      const { positional, flags } = parseFlags(rest, INSPECT_FLAGS, INSPECT_SWITCHES, INSPECT_SHORTS);
      const nRaw = flags.get("n");
      let n: number | undefined;
      if (nRaw !== undefined) {
        n = Number(nRaw);
        if (!Number.isInteger(n) || n < 0) throw new Error("-n must be a non-negative integer");
      }
      return writeResult(
        await inspectRunMaybeFollow(
          {
            runId: positional[0],
            ...(n === undefined ? {} : { n }),
            tail: parseTailKind(flags.get("tail")),
            linksOnly: flags.has("links-only"),
            noTail: flags.has("no-tail"),
            json: flags.has("json"),
            follow: flags.has("follow"),
          },
          (chunk) => {
            process.stdout.write(chunk);
          },
        ),
      );
    }
    case "prune": {
      const { flags } = parseFlags(rest, PRUNE_FLAGS);
      const keepRaw = flags.get("keep");
      if (keepRaw === undefined) throw new Error("prune requires --keep <n>");
      return writeResult(pruneRuns(keepRaw));
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
