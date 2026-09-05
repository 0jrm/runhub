import { existsSync, readFileSync } from "node:fs";
import { lastLines, outcome, type RunView, type Verdict } from "./domain.js";

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
      for (const key of ["result", "message", "text", "content"] as const) {
        const v = rec[key];
        if (typeof v === "string" && v.trim().length > 0) found = v;
      }
    } catch {
      continue;
    }
  }
  if (found !== undefined) return found.trim();
  const tail = raw.slice(-2048).trim();
  return tail.length > 0 ? tail : "(no agent message)";
}

export function parseReview(raw: string): { verdict: Verdict; bullets: string[] } {
  const text = extractFinalMessage(raw);
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let verdict: Verdict = "unknown";
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
  const bullets = lines.filter((l) => /^[-*]\s+/.test(l)).slice(0, 3);
  return { verdict, bullets };
}

export function mergeCommand(cwd: string, branch: string): string {
  return `git -C ${cwd} merge ${branch}`;
}

export function renderReport(
  view: RunView,
  extras: { agentStdout: string; agentStderr: string },
): string {
  const result = outcome(view);
  const lines: string[] = [result, ""];

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
      lines.push(view.verify.testTail.trimEnd());
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
    const parsed = parseReview(view.reviewBody ?? "");
    for (const b of parsed.bullets) lines.push(b);
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
