import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  TEST_EXCERPT_LINES,
  classifyExit,
  classifyTest,
  formatUsageLine,
  lastLines,
  outcome,
  outcomeLabel,
  type RunView,
  type TestKind,
  type Verdict,
} from "./domain.js";

export function extractFinalMessage(raw: string): string {
  const slice = raw.length > 256_000 ? raw.slice(raw.length - 256_000) : raw;
  let found: string | undefined;
  for (const line of slice.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const obj: unknown = JSON.parse(t);
      if (typeof obj !== "object" || obj === null) continue;
      const rec = obj as Record<string, unknown>;
      if (rec.type !== "result") continue;
      const v = rec.result;
      if (typeof v === "string" && v.trim().length > 0) found = v;
    } catch {
      continue;
    }
  }
  if (found === undefined) return "(no final message)";
  return found.trim().replace(/\.([A-Z])/g, ".\n\n$1");
}

export function parseReview(raw: string): { verdict: Verdict; extra: string[] } {
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  let verdict: Verdict = "unparsed";
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;
    if (/\bAPPROVE\b/.test(line)) {
      verdict = "APPROVE";
      break;
    }
    if (/\bREJECT\b/.test(line)) {
      verdict = "REJECT";
      break;
    }
  }
  if (verdict === "unparsed") {
    const tail = lastLines(raw, 3);
    return { verdict, extra: tail.length === 0 ? [] : tail.split("\n") };
  }
  return { verdict, extra: lines.filter((l) => /^[-*]\s+/.test(l)).slice(0, 3) };
}

function posixQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

export function mergeCommand(cwd: string, branch: string): string {
  return `git -C ${posixQuote(cwd)} merge ${branch}`;
}

function tookLine(view: RunView): string | undefined {
  if (view.finishedAt === undefined) return undefined;
  const ms = Date.parse(view.finishedAt) - Date.parse(view.createdAt);
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const seconds = Math.round(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `took ${m}m ${String(s).padStart(2, "0")}s`;
}

function checkLine(label: string, cmd: string | undefined, exit: number | undefined): string | undefined {
  const kind = classifyExit(cmd, exit);
  switch (kind) {
    case "absent":
      return undefined;
    case "missing":
      return `${label}: ${cmd} (not found on PATH)`;
    case "passed":
    case "failed":
      return `${label}: ${cmd}  exit ${exit ?? "?"}`;
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unhandled check kind: ${String(_exhaustive)}`);
    }
  }
}

function testsBlock(view: RunView): string[] {
  const verify = view.verify;
  if (verify === undefined) return ["tests: none"];
  const lines: string[] = [];
  const kind: TestKind = classifyTest(verify);
  switch (kind) {
    case "absent":
      lines.push("tests: none");
      break;
    case "missing":
      lines.push(`tests: ${verify.testCmd} (not found on PATH)`);
      break;
    case "passed":
      lines.push(`tests: ${verify.testCmd}  exit ${verify.testExit ?? "?"}`);
      break;
    case "failed":
      lines.push(`tests: ${verify.testCmd}  exit ${verify.testExit ?? "?"}`);
      if (verify.testTail.trim().length > 0) {
        lines.push(lastLines(verify.testTail, TEST_EXCERPT_LINES));
      }
      break;
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unhandled test kind: ${String(_exhaustive)}`);
    }
  }
  if (view.retryAttempt !== undefined) {
    const after = classifyTest(verify);
    lines.push(after === "passed" ? `retry: ${view.retryAttempt}, tests then passed` : `retry: ${view.retryAttempt}, still failing`);
  }
  const typecheck = checkLine("typecheck", verify.typecheckCmd, verify.typecheckExit);
  if (typecheck !== undefined) lines.push(typecheck);
  const lint = checkLine("lint", verify.lintCmd, verify.lintExit);
  if (lint !== undefined) lines.push(lint);
  return lines;
}

export function renderReport(
  view: RunView,
  extras: { agentStdout: string; agentStderr: string },
): string {
  const head = [outcomeLabel(outcome(view)), basename(view.cwd)].filter((s) => s.length > 0);
  const took = tookLine(view);
  if (took !== undefined) head.push(took);
  const lines: string[] = [head.join("  ")];
  lines.push("");

  if (view.branch) {
    lines.push(`branch: ${view.branch}`);
    if (view.prUrl !== undefined) lines.push(`pr: ${view.prUrl}`);
    else lines.push(`merge: ${mergeCommand(view.cwd, view.branch)}`);
    lines.push("");
  }

  lines.push("files changed:");
  const stat = view.verify?.diffStat.trim() ?? "";
  if (stat.length === 0) lines.push("(none)");
  else lines.push(stat);

  lines.push("");
  lines.push(...testsBlock(view));

  lines.push("");
  lines.push("agent:");
  lines.push(extractFinalMessage(extras.agentStdout));
  if (view.agentExit !== undefined && view.agentExit !== 0 && extras.agentStderr.trim().length > 0) {
    lines.push("");
    lines.push("stderr:");
    lines.push(lastLines(extras.agentStderr, 20));
  }

  for (const u of view.usages) {
    lines.push(formatUsageLine(u.inputTokens, u.outputTokens));
  }

  if (view.reviewVerdict !== undefined) {
    lines.push("");
    lines.push(`review: ${view.reviewVerdict}`);
    for (const line of parseReview(view.reviewBody ?? "").extra) lines.push(line);
  }

  if (view.errors.length > 0) {
    lines.push("");
    lines.push("errors:");
    for (const e of view.errors) lines.push(e.message);
  }

  lines.push("");
  return lines.join("\n");
}

export function renderReportFromFiles(
  view: RunView,
  paths: { stdout: string; stderr: string },
): string {
  const agentStdout = existsSync(paths.stdout) ? readFileSync(paths.stdout, "utf8") : "";
  const agentStderr = existsSync(paths.stderr) ? readFileSync(paths.stderr, "utf8") : "";
  return renderReport(view, { agentStdout, agentStderr });
}

export function summaryJson(view: RunView): unknown {
  return {
    runId: view.runId,
    status: view.status,
    outcome: outcome(view),
    cwd: view.cwd,
    branch: view.branch,
    prompt: view.prompt,
    agentExit: view.agentExit,
    verify: view.verify,
    review: view.reviewVerdict,
    errors: view.errors,
  };
}
