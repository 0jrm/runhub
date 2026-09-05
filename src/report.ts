import { existsSync, readFileSync } from "node:fs";
import {
  TEST_EXCERPT_LINES,
  lastLines,
  outcome,
  outcomeLabel,
  type RunView,
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
  return `took ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function renderReport(
  view: RunView,
  extras: { agentStdout: string; agentStderr: string },
): string {
  const lines: string[] = [outcomeLabel(outcome(view))];
  const took = tookLine(view);
  if (took !== undefined) lines.push(took);
  lines.push("");

  if (view.branch) {
    lines.push(`branch: ${view.branch}`);
    lines.push(`merge: ${mergeCommand(view.cwd, view.branch)}`);
    lines.push("");
  }

  lines.push("files changed:");
  const stat = view.verify?.diffStat.trim() ?? "";
  if (stat.length === 0) lines.push("(none)");
  else lines.push(stat);

  lines.push("");
  if (view.verify?.testCmd !== undefined) {
    lines.push(`tests: ${view.verify.testCmd}  exit ${view.verify.testExit ?? "?"}`);
    if (view.verify.testExit !== 0 && view.verify.testTail.trim().length > 0) {
      lines.push(lastLines(view.verify.testTail, TEST_EXCERPT_LINES));
    }
  } else {
    lines.push("tests: none");
  }

  lines.push("");
  lines.push("agent:");
  lines.push(extractFinalMessage(extras.agentStdout));
  if (view.agentExit !== undefined && view.agentExit !== 0 && extras.agentStderr.trim().length > 0) {
    lines.push("");
    lines.push("stderr:");
    lines.push(lastLines(extras.agentStderr, 20));
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
