import { assertNever, type RunStatus, type RunView, type StepView } from "./domain.js";

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function statusLabel(status: RunStatus): string {
  switch (status.kind) {
    case "queued":
      return "queued";
    case "running":
      return `running since ${status.startedAt}`;
    case "done":
      return `done at ${status.endedAt}`;
    case "failed":
      return `failed at ${status.endedAt}: ${status.error}`;
    default:
      return assertNever(status);
  }
}

function skippedMentions(view: RunView): string[] {
  const lines: string[] = [];
  for (const err of view.errors) {
    if (/missing|not on PATH|skipped/i.test(err.message)) {
      lines.push(err.message);
    }
  }
  return lines;
}

export function renderMarkdown(view: RunView): string {
  const lines: string[] = [];
  lines.push(`# Run ${view.runId}`);
  lines.push("");
  lines.push(`Status: **${view.status}**`);
  if (view.dryRun) {
    lines.push("");
    lines.push("This was a dry run. No agent was invoked.");
  }
  lines.push("");
  lines.push("## Prompt");
  lines.push("");
  lines.push(view.prompt);
  lines.push("");
  lines.push("## Quota probes");
  lines.push("");
  lines.push("These are PATH probes at request time, not a billing API.");
  lines.push("");
  if (view.quota === undefined) {
    lines.push("No quota snapshot.");
  } else {
    lines.push("| provider | probe | detail |");
    lines.push("| --- | --- | --- |");
    for (const p of view.quota.providers) {
      const detail = p.detail.replaceAll("|", "\\|").replaceAll("\n", " ");
      lines.push(`| ${p.provider} | ${p.probe} | ${detail} |`);
    }
  }
  const skips = skippedMentions(view);
  if (skips.length > 0) {
    lines.push("");
    lines.push("## Missing binary skip");
    lines.push("");
    for (const s of skips) lines.push(`- ${s}`);
  }
  lines.push("");
  lines.push("## Step tree");
  lines.push("");
  if (view.steps.length === 0) {
    lines.push("No steps.");
  } else {
    for (const step of view.steps.filter((s) => s.parentId === null)) {
      lines.push(renderStepMd(step, view.steps, 0));
    }
  }
  const synthesis = view.steps.find((s) => s.persona === "reporter" && s.stdout.trim().length > 0);
  if (synthesis) {
    lines.push("");
    lines.push("## Synthesis");
    lines.push("");
    lines.push(synthesis.stdout.trim());
  }
  if (view.errors.length > 0) {
    lines.push("");
    lines.push("## Errors");
    lines.push("");
    for (const err of view.errors) {
      const prefix = err.stepId ? `${err.stepId}: ` : "";
      lines.push(`- ${prefix}${err.message}`);
    }
  }
  if (view.summary) {
    lines.push("");
    lines.push("## Summary");
    lines.push("");
    lines.push(view.summary);
  }
  lines.push("");
  return lines.join("\n");
}

function renderStepMd(step: StepView, all: StepView[], depth: number): string {
  const indent = "  ".repeat(depth);
  const kids = all.filter((s) => s.parentId === step.id);
  const cap = step.truncated ? " (log truncated)" : "";
  const head = `${indent}- \`${step.id}\` ${step.persona}/${step.provider} ${statusLabel(step.status)}${cap}`;
  const body: string[] = [head];
  if (step.stdout.trim().length > 0) {
    body.push(`${indent}  stdout:`);
    body.push("");
    body.push("```");
    body.push(step.stdout.trimEnd());
    body.push("```");
  }
  if (step.stderr.trim().length > 0) {
    body.push(`${indent}  stderr:`);
    body.push("");
    body.push("```");
    body.push(step.stderr.trimEnd());
    body.push("```");
  }
  for (const kid of kids) {
    body.push(renderStepMd(kid, all, depth + 1));
  }
  return body.join("\n");
}

export function renderHtml(view: RunView): string {
  const quotaRows =
    view.quota === undefined
      ? "<p>No quota snapshot.</p>"
      : `<table><thead><tr><th>provider</th><th>probe</th><th>detail</th></tr></thead><tbody>${view.quota.providers
          .map(
            (p) =>
              `<tr><td>${esc(p.provider)}</td><td>${esc(p.probe)}</td><td><pre>${esc(p.detail)}</pre></td></tr>`,
          )
          .join("")}</tbody></table>`;

  const stepItems = view.steps
    .map((s) => {
      const logs = `<pre>${esc(s.stdout)}</pre>${s.stderr ? `<pre>${esc(s.stderr)}</pre>` : ""}`;
      return `<li><code>${esc(s.id)}</code> ${esc(s.persona)}/${esc(s.provider)} ${esc(statusLabel(s.status))}${
        s.truncated ? " truncated" : ""
      }${logs}</li>`;
    })
    .join("");

  const errors =
    view.errors.length === 0
      ? "<p>None.</p>"
      : `<ul>${view.errors.map((e) => `<li>${esc(e.stepId ? `${e.stepId}: ` : "")}${esc(e.message)}</li>`).join("")}</ul>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>runhub ${esc(view.runId)}</title>
<style>
body { font-family: ui-sans-serif, system-ui, sans-serif; color: #111; background: #fff; max-width: 52rem; margin: 1.5rem auto; padding: 0 1rem; }
pre { background: #f4f4f4; padding: 0.75rem; overflow: auto; white-space: pre-wrap; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ccc; padding: 0.35rem 0.5rem; text-align: left; vertical-align: top; }
h1, h2 { font-weight: 600; }
</style>
</head>
<body>
<h1>Run ${esc(view.runId)}</h1>
<p>Status: ${esc(view.status)}${view.dryRun ? ". Dry run, no agent invoked." : ""}</p>
<h2>Prompt</h2>
<pre>${esc(view.prompt)}</pre>
<h2>Quota probes</h2>
<p>PATH probes at request time, not a billing API.</p>
${quotaRows}
<h2>Step tree</h2>
${view.steps.length === 0 ? "<p>No steps.</p>" : `<ul>${stepItems}</ul>`}
<h2>Errors</h2>
${errors}
<h2>Truncated logs</h2>
<p>Each step keeps at most the last 64KiB of captured stdout/stderr in the event log.</p>
</body>
</html>
`;
}

export function summaryJson(view: RunView): unknown {
  return {
    runId: view.runId,
    status: view.status,
    createdAt: view.createdAt,
    finishedAt: view.finishedAt,
    cwd: view.cwd,
    prompt: view.prompt,
    summary: view.summary,
    dryRun: view.dryRun,
    quota: view.quota,
    steps: view.steps.map((s) => ({
      id: s.id,
      parentId: s.parentId,
      persona: s.persona,
      provider: s.provider,
      status: s.status,
      exitCode: s.exitCode,
      truncated: s.truncated,
    })),
    errors: view.errors,
  };
}

export function inspectText(view: RunView): string {
  const lines: string[] = [];
  lines.push(`run ${view.runId} ${view.status}${view.dryRun ? " dry-run" : ""}`);
  lines.push(`cwd ${view.cwd}`);
  lines.push(`prompt ${view.prompt}`);
  if (view.quota) {
    const bits = view.quota.providers.map((p) => `${p.provider}=${p.probe}`).join(" ");
    lines.push(`quota ${bits} (probe, not billing API)`);
  }
  lines.push("steps");
  if (view.steps.length === 0) lines.push("  (none)");
  for (const s of view.steps) {
    const parent = s.parentId ? ` parent=${s.parentId}` : "";
    lines.push(`  ${s.id}${parent} ${s.persona}/${s.provider} ${statusLabel(s.status)}`);
  }
  lines.push("errors");
  if (view.errors.length === 0) lines.push("  (none)");
  for (const e of view.errors) {
    lines.push(`  ${e.stepId ? `${e.stepId} ` : ""}${e.message}`);
  }
  return `${lines.join("\n")}\n`;
}
