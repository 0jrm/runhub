import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_TIMEOUT_MS,
  branchName,
  defaultModel,
  nowIso,
  outcome,
  type AgentKind,
  type Event,
  type ReviewKind,
  type RunId,
} from "./domain.js";
import { agentArgv, resolveAgentBin, reviewArgv, runProcessGroup } from "./adapters.js";
import { diffAgainstBase, runVerify } from "./verify.js";
import { addRunWorktree, revParseHead } from "./git.js";
import {
  agentStderrPath,
  agentStdoutPath,
  appendEvent,
  loadView,
  newRunId,
  porcelainPath,
  promptPath,
  reportPath,
  reviewPath,
  runDir,
  worktreePath,
  writeArtifacts,
} from "./store.js";
import { extractFinalMessage, parseReview, renderReportFromFiles, summaryJson } from "./report.js";

export type PipelineOpts = {
  cwd: string;
  prompt: string;
  timeoutMs?: number;
  testCmd?: string;
  agent?: AgentKind;
  model?: string;
  review?: ReviewKind;
  signal?: AbortSignal;
};

export type PipelineResult = {
  runId: RunId;
  markdown: string;
  failed: boolean;
};

function emit(runId: RunId, event: Event): void {
  appendEvent(runId, event);
}

export async function runPipeline(opts: PipelineOpts): Promise<PipelineResult> {
  const runId = newRunId();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const agent = opts.agent ?? "cursor";
  const model = opts.model ?? defaultModel(agent);
  const review = opts.review ?? "none";
  const ac = new AbortController();
  const onSig = () => ac.abort();
  const ownSignals = opts.signal === undefined;
  if (opts.signal?.aborted) ac.abort();
  opts.signal?.addEventListener("abort", onSig, { once: true });
  if (ownSignals) {
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);
  }

  let finalized = false;
  const finish = (): PipelineResult => {
    if (finalized) {
      const view = loadView(runId);
      const markdown = existsSync(reportPath(runId))
        ? readFileSync(reportPath(runId), "utf8")
        : "";
      return { runId, markdown, failed: view.status === "failed" };
    }
    finalized = true;
    let view = loadView(runId);
    const result = ac.signal.aborted && view.status !== "failed" ? "fail" : outcome(view);
    const status = result === "fail" || ac.signal.aborted ? "failed" : "done";
    emit(runId, {
      kind: "run_finished",
      ts: nowIso(),
      runId,
      status,
      summary: ac.signal.aborted ? "aborted" : result,
    });
    view = loadView(runId);
    const markdown = renderReportFromFiles(view, {
      stdout: agentStdoutPath(runId),
      stderr: agentStderrPath(runId),
    });
    writeArtifacts(runId, { summary: summaryJson(view), markdown });
    return { runId, markdown, failed: status === "failed" };
  };

  emit(runId, {
    kind: "run_created",
    ts: nowIso(),
    runId,
    prompt: opts.prompt,
    cwd: opts.cwd,
    agent,
    model,
    review,
    timeoutMs,
  });

  try {
    mkdirSync(runDir(runId), { recursive: true });
    const baseSha = revParseHead(opts.cwd);
    const branch = branchName(runId);
    const tree = worktreePath(runId);
    addRunWorktree({ repo: opts.cwd, tree, branch, base: baseSha });
    emit(runId, { kind: "base_recorded", ts: nowIso(), runId, baseSha, branch });
    writeFileSync(promptPath(runId), opts.prompt, "utf8");

    if (ac.signal.aborted) return finish();

    const bin = resolveAgentBin(agent);
    const argv = bin === undefined ? [] : agentArgv({ agent, bin, cwd: tree, model });
    emit(runId, {
      kind: "step_started",
      ts: nowIso(),
      runId,
      step: { id: "agent", argv: argv.length > 0 ? argv : ["(missing-agent)"] },
    });

    let agentCode = 127;
    let timedOut = false;
    if (bin === undefined) {
      emit(runId, {
        kind: "error",
        ts: nowIso(),
        runId,
        stepId: "agent",
        message: `${agent} not on PATH`,
      });
    } else {
      const result = await runProcessGroup({
        argv,
        cwd: tree,
        stdinPath: promptPath(runId),
        stdoutPath: agentStdoutPath(runId),
        stderrPath: agentStderrPath(runId),
        timeoutMs,
        signal: ac.signal,
      });
      agentCode = result.code ?? 1;
      timedOut = result.timedOut;
      if (result.aborted) {
        emit(runId, {
          kind: "error",
          ts: nowIso(),
          runId,
          stepId: "agent",
          message: "run aborted",
        });
      } else if (timedOut) {
        emit(runId, {
          kind: "error",
          ts: nowIso(),
          runId,
          stepId: "agent",
          message: `agent timed out after ${timeoutMs}ms`,
        });
      } else if (agentCode !== 0) {
        emit(runId, {
          kind: "error",
          ts: nowIso(),
          runId,
          stepId: "agent",
          message: `agent exit ${agentCode}`,
        });
      }
    }
    emit(runId, {
      kind: "step_finished",
      ts: nowIso(),
      runId,
      stepId: "agent",
      exitCode: agentCode,
      ...(timedOut ? { timedOut: true } : {}),
    });

    if (ac.signal.aborted) return finish();

    const testArgv = opts.testCmd !== undefined ? ["sh", "-c", opts.testCmd] : ["(detect)"];
    emit(runId, {
      kind: "step_started",
      ts: nowIso(),
      runId,
      step: { id: "verify", argv: testArgv },
    });
    const verify = await runVerify({
      cwd: tree,
      baseSha,
      porcelainPath: porcelainPath(runId),
      testOutPath: join(runDir(runId), "verify.out"),
      testCmdOverride: opts.testCmd,
      signal: ac.signal,
    });
    emit(runId, {
      kind: "verify_recorded",
      ts: nowIso(),
      runId,
      baseSha: verify.baseSha,
      diffStat: verify.diffStat,
      testTail: verify.testTail,
      ...(verify.testCmd === undefined ? {} : { testCmd: verify.testCmd }),
      ...(verify.testExit === undefined ? {} : { testExit: verify.testExit }),
    });
    emit(runId, {
      kind: "step_finished",
      ts: nowIso(),
      runId,
      stepId: "verify",
      exitCode: verify.testExit ?? 0,
    });

    if (ac.signal.aborted) return finish();

    if (review === "claude") {
      const claudeBin = resolveAgentBin("claude");
      const rargv = claudeBin === undefined ? ["(missing-claude)"] : reviewArgv(claudeBin, defaultModel("claude"));
      emit(runId, {
        kind: "step_started",
        ts: nowIso(),
        runId,
        step: { id: "review", argv: rargv },
      });
      if (claudeBin === undefined) {
        emit(runId, {
          kind: "error",
          ts: nowIso(),
          runId,
          stepId: "review",
          message: "claude not on PATH",
        });
        emit(runId, { kind: "step_finished", ts: nowIso(), runId, stepId: "review", exitCode: 127 });
      } else {
        const reviewPrompt = join(runDir(runId), "review-prompt.txt");
        const diff = diffAgainstBase(tree, baseSha);
        writeFileSync(
          reviewPrompt,
          [
            "list bugs and risks, then one line: APPROVE or REJECT",
            "",
            "Tests:",
            verify.testTail,
            "",
            "Diff:",
            diff,
            "",
          ].join("\n"),
          "utf8",
        );
        const r = await runProcessGroup({
          argv: rargv,
          cwd: tree,
          stdinPath: reviewPrompt,
          stdoutPath: reviewPath(runId),
          stderrPath: join(runDir(runId), "review.stderr"),
          timeoutMs,
          signal: ac.signal,
        });
        const raw = existsSync(reviewPath(runId)) ? readFileSync(reviewPath(runId), "utf8") : "";
        const parsed = parseReview(raw);
        emit(runId, {
          kind: "review_recorded",
          ts: nowIso(),
          runId,
          verdict: parsed.verdict,
          body: extractFinalMessage(raw),
        });
        emit(runId, {
          kind: "step_finished",
          ts: nowIso(),
          runId,
          stepId: "review",
          exitCode: r.code ?? 1,
        });
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    emit(runId, { kind: "error", ts: nowIso(), runId, message });
  } finally {
    if (ownSignals) {
      process.removeListener("SIGINT", onSig);
      process.removeListener("SIGTERM", onSig);
    }
    opts.signal?.removeEventListener("abort", onSig);
  }

  return finish();
}

export { runDir, reportPath };
