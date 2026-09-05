#!/usr/bin/env node
import { resolve } from "node:path";
import { captureQuota } from "./quota.js";
import { htmlPath, listRuns, loadView, prune, resolveRunId } from "./store.js";
import { inspectText, renderMarkdown } from "./report.js";
import { runPipeline, type PipelineOpts } from "./pipeline.js";
import { PROVIDERS, type Provider } from "./domain.js";

const USAGE = `runhub <command>

Commands:
  run --cwd <dir> --prompt <text> [--execute cursor|claude|grok] [--review none|claude|grok] [--report grok|none] [--dry-run] [--cheap]
  status [runId]
  report [runId]
  inspect [runId]
  html [runId]
  list
  prune --keep <n>
  quota
`;

type FlagMap = Map<string, string | boolean>;

function parseFlags(args: string[]): { positional: string[]; flags: FlagMap } {
  const positional: string[] = [];
  const flags: FlagMap = new Map();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) break;
    if (a === "--dry-run" || a === "--cheap") {
      flags.set(a.slice(2), true);
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
        continue;
      }
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags.set(key, true);
      } else {
        flags.set(key, next);
        i += 1;
      }
      continue;
    }
    positional.push(a);
  }
  return { positional, flags };
}

function flagString(flags: FlagMap, name: string): string | undefined {
  const v = flags.get(name);
  if (v === undefined || typeof v === "boolean") return undefined;
  return v;
}

function asProvider(value: string, allowed: readonly string[]): Provider {
  if (allowed.includes(value) && (value === "cursor" || value === "claude" || value === "grok")) {
    return value;
  }
  throw new Error(`invalid provider ${value}`);
}

function parseRunOpts(flags: FlagMap): PipelineOpts {
  const cwdRaw = flagString(flags, "cwd");
  const prompt = flagString(flags, "prompt");
  if (cwdRaw === undefined || prompt === undefined) {
    throw new Error("run requires --cwd and --prompt");
  }
  const executeRaw = flagString(flags, "execute") ?? "cursor";
  const reviewRaw = flagString(flags, "review") ?? "claude";
  const reportRaw = flagString(flags, "report") ?? "grok";
  if (reviewRaw !== "none" && reviewRaw !== "claude" && reviewRaw !== "grok") {
    throw new Error("--review must be none, claude, or grok");
  }
  if (reportRaw !== "grok" && reportRaw !== "none") {
    throw new Error("--report must be grok or none");
  }
  return {
    cwd: resolve(cwdRaw),
    prompt,
    execute: asProvider(executeRaw, PROVIDERS),
    review: reviewRaw,
    report: reportRaw,
    dryRun: flags.get("dry-run") === true,
    cheap: flags.get("cheap") === true,
  };
}

type Command =
  | "run"
  | "status"
  | "report"
  | "inspect"
  | "html"
  | "list"
  | "prune"
  | "quota";

function parseCommand(raw: string | undefined): Command | "help" | undefined {
  switch (raw) {
    case "run":
    case "status":
    case "report":
    case "inspect":
    case "html":
    case "list":
    case "prune":
    case "quota":
    case "help":
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
  const { positional, flags } = parseFlags(rest);

  switch (command) {
    case "run": {
      const opts = parseRunOpts(flags);
      const result = await runPipeline(opts);
      process.stdout.write(result.markdown);
      if (!result.markdown.endsWith("\n")) process.stdout.write("\n");
      process.stdout.write(`runhub: ${result.runId} ${result.runPath}\n`);
      return result.failed ? 1 : 0;
    }
    case "status": {
      const id = resolveRunId(positional[0]);
      const view = loadView(id);
      process.stdout.write(`${view.runId} ${view.status}${view.summary ? ` ${view.summary}` : ""}\n`);
      return 0;
    }
    case "report": {
      const id = resolveRunId(positional[0]);
      process.stdout.write(renderMarkdown(loadView(id)));
      return 0;
    }
    case "inspect": {
      const id = resolveRunId(positional[0]);
      process.stdout.write(inspectText(loadView(id)));
      return 0;
    }
    case "html": {
      const id = resolveRunId(positional[0]);
      process.stdout.write(`${htmlPath(id)}\n`);
      return 0;
    }
    case "list": {
      const runs = listRuns();
      if (runs.length === 0) {
        process.stdout.write("(no runs)\n");
        return 0;
      }
      for (const r of runs) {
        process.stdout.write(`${r.runId} ${r.createdAt} ${r.status}\n`);
      }
      return 0;
    }
    case "prune": {
      const keepRaw = flagString(flags, "keep");
      if (keepRaw === undefined) throw new Error("prune requires --keep <n>");
      const keep = Number(keepRaw);
      if (!Number.isInteger(keep) || keep < 0) throw new Error("--keep must be a non-negative integer");
      const result = prune(keep);
      process.stderr.write(`deleted ${result.deleted.length}, kept ${result.kept.length}\n`);
      return 0;
    }
    case "quota": {
      const snap = await captureQuota();
      process.stdout.write("Quota probes (probe, not billing API)\n");
      for (const p of snap.providers) {
        process.stdout.write(`${p.provider}\t${p.probe}\t${p.detail.replaceAll("\n", " ")}\n`);
      }
      return 0;
    }
    default: {
      const _exhaustive: never = command;
      throw new Error(`unhandled command: ${String(_exhaustive)}`);
    }
  }
}

main(process.argv).then(
  (code) => {
    process.exit(code);
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  },
);
