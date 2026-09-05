import {
  STEP_LOG_BYTES,
  nowIso,
  tailBytes,
  type Event,
  type Persona,
  type Provider,
  type RunId,
} from "./domain.js";
import {
  agentArgv,
  grokStdoutToText,
  grokTextFallbackArgv,
  resolveBin,
  runCaptured,
} from "./adapters.js";
import { captureQuota } from "./quota.js";
import { appendEvent, loadView, newRunId, runDir, writeArtifacts } from "./store.js";
import { inspectText, renderHtml, renderMarkdown, summaryJson } from "./report.js";

export type PipelineOpts = {
  cwd: string;
  prompt: string;
  execute: Provider;
  review: "none" | "claude" | "grok";
  report: "grok" | "none";
  dryRun: boolean;
  cheap: boolean;
};

export type PipelineResult = {
  runId: RunId;
  markdown: string;
  runPath: string;
  failed: boolean;
};

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function emit(runId: RunId, event: Event): void {
  appendEvent(runId, event);
}

async function runAgentStep(opts: {
  runId: RunId;
  stepId: string;
  parentId: string | null;
  persona: Persona;
  provider: Provider;
  prompt: string;
  cwd: string;
  cheap: boolean;
}): Promise<{ stdout: string; skipped: boolean }> {
  const bin = resolveBin(opts.provider);
  if (bin === undefined) {
    const message = `skipped ${opts.persona} (${opts.provider}): binary missing from PATH`;
    log(message);
    emit(opts.runId, {
      kind: "error",
      ts: nowIso(),
      runId: opts.runId,
      stepId: opts.stepId,
      message,
    });
    return { stdout: "", skipped: true };
  }

  let invoke = agentArgv({
    provider: opts.provider,
    bin,
    prompt: opts.prompt,
    cwd: opts.cwd,
    cheap: opts.cheap,
  });
  emit(opts.runId, {
    kind: "step_started",
    ts: nowIso(),
    runId: opts.runId,
    step: {
      id: opts.stepId,
      parentId: opts.parentId,
      persona: opts.persona,
      provider: opts.provider,
      argv: invoke.argv,
    },
  });
  log(`step ${opts.stepId} ${opts.persona}/${opts.provider} start`);

  let result = await runCaptured({ argv: invoke.argv, cwd: opts.cwd });
  let stdout = result.stdout;
  if (opts.provider === "grok") {
    if (looksLikeJsonFail(result.stdout)) {
      result = await runCaptured({
        argv: grokTextFallbackArgv({ bin, prompt: opts.prompt, cwd: opts.cwd }),
        cwd: opts.cwd,
      });
      stdout = result.stdout;
    } else {
      stdout = grokStdoutToText(result.stdout);
    }
  }

  const outCap = tailBytes(stdout, STEP_LOG_BYTES);
  const errCap = tailBytes(result.stderr, STEP_LOG_BYTES);
  if (outCap.text.length > 0) {
    emit(opts.runId, {
      kind: "step_chunk",
      ts: nowIso(),
      runId: opts.runId,
      stepId: opts.stepId,
      stream: "stdout",
      text: outCap.text,
    });
  }
  if (errCap.text.length > 0) {
    emit(opts.runId, {
      kind: "step_chunk",
      ts: nowIso(),
      runId: opts.runId,
      stepId: opts.stepId,
      stream: "stderr",
      text: errCap.text,
    });
  }
  const truncated = outCap.truncated || errCap.truncated;
  emit(opts.runId, {
    kind: "step_finished",
    ts: nowIso(),
    runId: opts.runId,
    stepId: opts.stepId,
    exitCode: result.code ?? 1,
    ...(truncated ? { truncated: true } : {}),
  });
  if (result.code !== 0) {
    emit(opts.runId, {
      kind: "error",
      ts: nowIso(),
      runId: opts.runId,
      stepId: opts.stepId,
      message: `${opts.provider} exit ${result.code ?? "null"}`,
    });
  }
  log(`step ${opts.stepId} exit ${result.code ?? "null"}`);
  return { stdout, skipped: false };
}

function looksLikeJsonFail(stdout: string): boolean {
  const t = stdout.trim();
  if (t.length === 0) return true;
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      JSON.parse(t);
      return false;
    } catch {
      return true;
    }
  }
  return false;
}

function localSynthesis(opts: { prompt: string; executeText: string; reviewText: string }): string {
  const parts = [
    `Task: ${opts.prompt}`,
    "",
    "Execute output:",
    opts.executeText.trim().length > 0 ? opts.executeText.trim() : "(none)",
    "",
    "Review output:",
    opts.reviewText.trim().length > 0 ? opts.reviewText.trim() : "(none)",
  ];
  return parts.join("\n");
}

export async function runPipeline(opts: PipelineOpts): Promise<PipelineResult> {
  const runId = newRunId();
  emit(runId, {
    kind: "run_created",
    ts: nowIso(),
    runId,
    prompt: opts.prompt,
    cwd: opts.cwd,
  });
  log(`run ${runId} created`);

  const snapshot = await captureQuota();
  emit(runId, { kind: "quota_snapshot", ts: nowIso(), runId, snapshot });
  for (const p of snapshot.providers) {
    log(`quota ${p.provider}=${p.probe}`);
    if (p.probe === "missing") {
      emit(runId, {
        kind: "error",
        ts: nowIso(),
        runId,
        message: `skipped ${p.provider}: binary missing from PATH`,
      });
    }
  }

  let executeText = "";
  let reviewText = "";
  let parentId: string | null = null;

  if (!opts.dryRun) {
    const exec = await runAgentStep({
      runId,
      stepId: "exec-1",
      parentId: null,
      persona: "coder",
      provider: opts.execute,
      prompt: opts.prompt,
      cwd: opts.cwd,
      cheap: opts.cheap,
    });
    executeText = exec.stdout;
    if (!exec.skipped) parentId = "exec-1";

    if (opts.review !== "none") {
      const reviewPrompt = [
        "Review the following task and execute output. Report bugs, risks, and what to verify.",
        "",
        `Task:\n${opts.prompt}`,
        "",
        `Execute output:\n${executeText.length > 0 ? executeText : "(no execute output)"}`,
      ].join("\n");
      const rev = await runAgentStep({
        runId,
        stepId: "review-1",
        parentId,
        persona: "reviewer",
        provider: opts.review,
        prompt: reviewPrompt,
        cwd: opts.cwd,
        cheap: opts.cheap,
      });
      reviewText = rev.stdout;
      if (!rev.skipped) parentId = "review-1";
    }

    if (opts.report === "grok") {
      const grokBin = resolveBin("grok");
      const synthPrompt = [
        "Write a concise markdown report for the user. Include what was attempted, what happened, and what to do next.",
        "",
        `Task:\n${opts.prompt}`,
        "",
        `Execute:\n${executeText.length > 0 ? executeText : "(none)"}`,
        "",
        `Review:\n${reviewText.length > 0 ? reviewText : "(none)"}`,
      ].join("\n");
      if (grokBin === undefined) {
        const message = "skipped reporter (grok): binary missing from PATH; synthesizing locally";
        log(message);
        emit(runId, { kind: "error", ts: nowIso(), runId, message });
        emit(runId, {
          kind: "step_started",
          ts: nowIso(),
          runId,
          step: {
            id: "report-1",
            parentId,
            persona: "reporter",
            provider: "grok",
            argv: ["(local-synthesis)"],
          },
        });
        const text = localSynthesis({ prompt: opts.prompt, executeText, reviewText });
        emit(runId, {
          kind: "step_chunk",
          ts: nowIso(),
          runId,
          stepId: "report-1",
          stream: "stdout",
          text: tailBytes(text, STEP_LOG_BYTES).text,
        });
        emit(runId, {
          kind: "step_finished",
          ts: nowIso(),
          runId,
          stepId: "report-1",
          exitCode: 0,
        });
      } else {
        await runAgentStep({
          runId,
          stepId: "report-1",
          parentId,
          persona: "reporter",
          provider: "grok",
          prompt: synthPrompt,
          cwd: opts.cwd,
          cheap: opts.cheap,
        });
      }
    }
  }

  let view = loadView(runId);
  const failed =
    !opts.dryRun &&
    (view.steps.some((s) => s.status.kind === "failed") || !view.steps.some((s) => s.id === "exec-1"));
  const status = failed && !opts.dryRun ? "failed" : "done";
  const summary = opts.dryRun
    ? "dry-run: quota probed, no agent invoked"
    : failed
      ? "run finished with errors or failed steps"
      : "run finished";
  emit(runId, {
    kind: "run_finished",
    ts: nowIso(),
    runId,
    status,
    summary,
  });

  view = loadView(runId);
  const markdown = renderMarkdown(view);
  const html = renderHtml(view);
  writeArtifacts(runId, { summary: summaryJson(view), markdown, html });
  log(inspectText(view).trimEnd());

  return { runId, markdown, runPath: runDir(runId), failed: status === "failed" };
}
