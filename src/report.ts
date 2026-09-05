import { existsSync, readFileSync } from "node:fs";
import { outcome, type RunView } from "./domain.js";

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

export function renderReport(view: RunView, agentStdout: string): string {
  const result = outcome(view);
  const lines: string[] = [result, "", "files changed:"];
  const porcelain = view.verify?.porcelain.trim() ?? "";
  if (porcelain.length === 0) lines.push("(none)");
  else lines.push(porcelain);

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
  lines.push(extractFinalMessage(agentStdout));

  if (view.errors.length > 0) {
    lines.push("");
    lines.push("errors:");
    for (const e of view.errors) lines.push(e.message);
  }

  lines.push("");
  return lines.join("\n");
}

export function renderReportFromFiles(view: RunView, agentStdoutFile: string): string {
  const raw = existsSync(agentStdoutFile) ? readFileSync(agentStdoutFile, "utf8") : "";
  return renderReport(view, raw);
}

export function summaryJson(view: RunView): unknown {
  return {
    runId: view.runId,
    status: view.status,
    outcome: outcome(view),
    cwd: view.cwd,
    prompt: view.prompt,
    agentExit: view.agentExit,
    verify: view.verify,
    errors: view.errors,
  };
}
