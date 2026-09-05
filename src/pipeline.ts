import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  AUTO_PRUNE_KEEP,
  DEFAULT_TIMEOUT_MS,
  RETRY_TEST_LINES,
  branchName,
  classifyTest,
  defaultModel,
  extractUsages,
  lastLines,
  nowIso,
  outcome,
  type AgentKind,
  type Event,
  type ReviewKind,
  type RunId,
  type VerifyResult,
} from "./domain.js";
import { agentArgv, findOnPath, resolveAgentBin, reviewArgv, runProcessGroup } from "./adapters.js";
import { runVerify, annotateBaseline } from "./verify.js";
import { commitMessage, createRunWorktree, diffText, landDirtyWork, pushBranch, remoteUrl, type RunWorktree } from "./git.js";
import {
  agentStderrPath,
  agentStdoutPath,
  appendEvent,
  loadView,
  newRunId,
  porcelainPath,
  promptPath,
  prune,
  reportPath,
  reviewPath,
  runDir,
  ensureRunDir,
  worktreePath,
  writeArtifacts,
} from "./store.js";
import { parseReview, renderReportFromFiles, summaryJson, verifyHeadlineLines } from "./report.js";

export type PipelineOpts = {
  cwd: string;
  prompt: string;
  timeoutMs?: number;
  testCmd?: string;
  typecheckCmd?: string;
  lintCmd?: string;
  remote?: string;
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

function emitVerify(runId: RunId, verify: VerifyResult): void {
  emit(runId, {
    kind: "verify_recorded",
    ts: nowIso(),
    runId,
    baseSha: verify.baseSha,
    diffStat: verify.diffStat,
    testTail: verify.testTail,
    ...(verify.testCmd === undefined ? {} : { testCmd: verify.testCmd }),
    ...(verify.testExit === undefined ? {} : { testExit: verify.testExit }),
    ...(verify.typecheckCmd === undefined ? {} : { typecheckCmd: verify.typecheckCmd }),
    ...(verify.typecheckExit === undefined ? {} : { typecheckExit: verify.typecheckExit }),
    ...(verify.lintCmd === undefined ? {} : { lintCmd: verify.lintCmd }),
    ...(verify.lintExit === undefined ? {} : { lintExit: verify.lintExit }),
    ...(verify.alsoFailingOnBase === true ? { alsoFailingOnBase: true } : {}),
  });
}

function emitUsages(runId: RunId, stepId: "agent" | "review", stdoutPath: string, seen: number): number {
  const raw = existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : "";
  const all = extractUsages(raw);
  for (const u of all.slice(seen)) {
    emit(runId, {
      kind: "usage_recorded",
      ts: nowIso(),
      runId,
      stepId,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
    });
  }
  return all.length;
}

export function prepareRun(opts: PipelineOpts): RunId {
  const runId = newRunId();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const agent = opts.agent ?? "cursor";
  const model = opts.model ?? defaultModel(agent);
  const review = opts.review ?? "none";
  ensureRunDir(runId);
  writeFileSync(promptPath(runId), opts.prompt, "utf8");
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
    ...(opts.testCmd === undefined ? {} : { testCmd: opts.testCmd }),
    ...(opts.typecheckCmd === undefined ? {} : { typecheckCmd: opts.typecheckCmd }),
    ...(opts.lintCmd === undefined ? {} : { lintCmd: opts.lintCmd }),
    ...(opts.remote === undefined ? {} : { remote: opts.remote }),
  });
  return runId;
}

function gh(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: 120_000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function maybeOpenPr(runId: RunId, cwd: string, branch: string, prompt: string, remote: string | undefined): void {
  if (remote === undefined || remote.length === 0) return;
  if (remoteUrl(cwd, remote) === undefined) {
    emit(runId, {
      kind: "error",
      ts: nowIso(),
      runId,
      message: `git remote ${remote} is not configured`,
    });
    return;
  }
  const pushed = pushBranch(worktreePath(runId), remote, branch);
  if (pushed.status !== 0) {
    emit(runId, {
      kind: "error",
      ts: nowIso(),
      runId,
      message: `git push failed: ${pushed.text || pushed.status}`,
    });
    return;
  }
  emit(runId, { kind: "push_recorded", ts: nowIso(), runId, remote, branch });
  if (findOnPath(["gh"]) === undefined) return;
  const auth = gh(["auth", "status"], cwd);
  if (auth.status !== 0) return;
  const title = commitMessage(prompt).slice("runhub: ".length) || prompt.slice(0, 60);
  const created = gh(
    ["pr", "create", "--head", branch, "--title", title, "--body-file", reportPath(runId)],
    cwd,
  );
  if (created.status !== 0) {
    emit(runId, {
      kind: "error",
      ts: nowIso(),
      runId,
      message: `gh pr create failed: ${created.stderr.trim() || created.stdout.trim() || created.status}`,
    });
    return;
  }
  const url = created.stdout.trim().split(/\s+/).find((t) => /^https?:\/\//.test(t));
  if (url === undefined) {
    emit(runId, { kind: "error", ts: nowIso(), runId, message: "gh pr create printed no URL" });
    return;
  }
  emit(runId, { kind: "pr_opened", ts: nowIso(), runId, url });
}

export async function executePipeline(runId: RunId, signal?: AbortSignal): Promise<PipelineResult> {
  const created = loadView(runId);
  const timeoutMs = created.timeoutMs;
  const agent = created.agent;
  const model = created.model;
  const review = created.review;
  const ac = new AbortController();
  const onSig = () => ac.abort();
  const ownSignals = signal === undefined;
  if (signal?.aborted) ac.abort();
  signal?.addEventListener("abort", onSig, { once: true });
  if (ownSignals) {
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);
  }

  let finalized = false;
  const finish = (): PipelineResult => {
    if (finalized) {
      const view = loadView(runId);
      const markdown = existsSync(reportPath(runId)) ? readFileSync(reportPath(runId), "utf8") : "";
      return { runId, markdown, failed: view.status === "failed" };
    }
    finalized = true;
    let view = loadView(runId);
    writeArtifacts(runId, {
      summary: summaryJson(view),
      markdown: renderReportFromFiles(view, {
        stdout: agentStdoutPath(runId),
        stderr: agentStderrPath(runId),
      }),
    });
    if (view.branch !== undefined) maybeOpenPr(runId, view.cwd, view.branch, view.prompt, view.remote);
    view = loadView(runId);
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
    writeArtifacts(runId, {
      summary: summaryJson(view),
      markdown: renderReportFromFiles(view, {
        stdout: agentStdoutPath(runId),
        stderr: agentStderrPath(runId),
      }),
    });
    try {
      prune(AUTO_PRUNE_KEEP);
    } catch {
      return {
        runId,
        markdown: existsSync(reportPath(runId)) ? readFileSync(reportPath(runId), "utf8") : "",
        failed: status === "failed",
      };
    }
    const markdown = existsSync(reportPath(runId)) ? readFileSync(reportPath(runId), "utf8") : "";
    return { runId, markdown, failed: status === "failed" };
  };

  try {
    const tree = worktreePath(runId);
    const branch = branchName(runId);
    const wt: RunWorktree = createRunWorktree({ repo: created.cwd, tree, branch });
    emit(runId, { kind: "base_recorded", ts: nowIso(), runId, baseSha: wt.base, branch });

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
    let usageSeen = 0;
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
        onStart: (pgid) => {
          emit(runId, { kind: "pgid_recorded", ts: nowIso(), runId, stepId: "agent", pgid });
        },
      });
      agentCode = result.code ?? 1;
      timedOut = result.timedOut;
      usageSeen = emitUsages(runId, "agent", agentStdoutPath(runId), usageSeen);
      if (result.aborted) {
        emit(runId, { kind: "error", ts: nowIso(), runId, stepId: "agent", message: "run aborted" });
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

    const land = (prompt: string): ReturnType<typeof landDirtyWork> => {
      const result = landDirtyWork(wt, prompt);
      writeFileSync(
        porcelainPath(runId),
        result.porcelain.endsWith("\n") ? result.porcelain : `${result.porcelain}\n`,
        "utf8",
      );
      if (result.didCommit) {
        emit(runId, { kind: "work_committed", ts: nowIso(), runId, sha: result.sha });
      }
      return result;
    };

    let landed = land(created.prompt);
    let range = { from: wt.base, to: landed.sha };

    const runChecks = async (): Promise<VerifyResult> => {
      const testArgv = created.testCmd !== undefined ? ["sh", "-c", created.testCmd] : ["(detect)"];
      emit(runId, { kind: "step_started", ts: nowIso(), runId, step: { id: "verify", argv: testArgv } });
      let verify = await runVerify({
        cwd: tree,
        range,
        testOutPath: join(runDir(runId), "verify.out"),
        testCmdOverride: created.testCmd,
        typecheckOverride: created.typecheckCmd,
        lintOverride: created.lintCmd,
        signal: ac.signal,
      });
      verify = await annotateBaseline({
        repo: created.cwd,
        verify,
        testCmdOverride: created.testCmd,
        typecheckOverride: created.typecheckCmd,
        lintOverride: created.lintCmd,
        signal: ac.signal,
      });
      emitVerify(runId, verify);
      emit(runId, {
        kind: "step_finished",
        ts: nowIso(),
        runId,
        stepId: "verify",
        exitCode: verify.testExit ?? 0,
      });
      return verify;
    };

    let verify = await runChecks();
    if (ac.signal.aborted) return finish();

    if (
      agentCode === 0 &&
      !timedOut &&
      classifyTest(verify) === "failed" &&
      verify.diffStat.trim() !== "" &&
      verify.alsoFailingOnBase !== true &&
      bin !== undefined
    ) {
      emit(runId, { kind: "retry_started", ts: nowIso(), runId, attempt: 1 });
      const retryPrompt = join(runDir(runId), "retry-prompt.txt");
      writeFileSync(
        retryPrompt,
        [
          "Tests failed. Fix them. Do not change test expectations unless the test itself is wrong.",
          "",
          lastLines(verify.testTail, RETRY_TEST_LINES),
          "",
        ].join("\n"),
        "utf8",
      );
      emit(runId, { kind: "step_started", ts: nowIso(), runId, step: { id: "agent", argv } });
      const retry = await runProcessGroup({
        argv,
        cwd: tree,
        stdinPath: retryPrompt,
        stdoutPath: agentStdoutPath(runId),
        stderrPath: agentStderrPath(runId),
        timeoutMs,
        signal: ac.signal,
        appendStdout: true,
        onStart: (pgid) => {
          emit(runId, { kind: "pgid_recorded", ts: nowIso(), runId, stepId: "agent", pgid });
        },
      });
      agentCode = retry.code ?? 1;
      timedOut = retry.timedOut;
      usageSeen = emitUsages(runId, "agent", agentStdoutPath(runId), usageSeen);
      emit(runId, {
        kind: "step_finished",
        ts: nowIso(),
        runId,
        stepId: "agent",
        exitCode: agentCode,
        ...(timedOut ? { timedOut: true } : {}),
      });
      if (!ac.signal.aborted) {
        landed = land(created.prompt);
        range = { from: wt.base, to: landed.sha };
        verify = await runChecks();
      }
    }

    if (ac.signal.aborted) return finish();

    if (review === "claude") {
      const claudeBin = resolveAgentBin("claude");
      const rargv = claudeBin === undefined ? ["(missing-claude)"] : reviewArgv(claudeBin, defaultModel("claude"));
      emit(runId, { kind: "step_started", ts: nowIso(), runId, step: { id: "review", argv: rargv } });
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
        const diff = diffText(tree, range);
        writeFileSync(
          reviewPrompt,
          [
            "list bugs and risks, then one line: APPROVE or REJECT",
            "",
            ...verifyHeadlineLines(verify),
            "",
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
        emitUsages(runId, "review", reviewPath(runId), 0);
        const raw = existsSync(reviewPath(runId)) ? readFileSync(reviewPath(runId), "utf8") : "";
        const parsed = parseReview(raw);
        emit(runId, {
          kind: "review_recorded",
          ts: nowIso(),
          runId,
          verdict: parsed.verdict,
          body: raw,
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
    signal?.removeEventListener("abort", onSig);
  }

  return finish();
}

export async function runPipeline(opts: PipelineOpts): Promise<PipelineResult> {
  return executePipeline(prepareRun(opts), opts.signal);
}

export { runDir, reportPath };
