import { writeFileSync } from "node:fs";
import {
  DEFAULT_TIMEOUT_MS,
  nowIso,
  outcome,
  type Event,
  type RunId,
} from "./domain.js";
import { agentArgv, resolveAgentBin, runProcessGroup } from "./adapters.js";
import { runVerify } from "./verify.js";
import {
  agentStdoutPath,
  appendEvent,
  loadView,
  newRunId,
  promptPath,
  reportPath,
  runDir,
  writeArtifacts,
} from "./store.js";
import { renderReportFromFiles, summaryJson } from "./report.js";

export type PipelineOpts = {
  cwd: string;
  prompt: string;
  timeoutMs?: number;
  testCmd?: string;
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
  emit(runId, {
    kind: "run_created",
    ts: nowIso(),
    runId,
    prompt: opts.prompt,
    cwd: opts.cwd,
  });

  try {
    writeFileSync(promptPath(runId), opts.prompt, "utf8");
    const bin = resolveAgentBin();
    const argv = bin === undefined ? [] : agentArgv(bin, opts.cwd);
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
        message: "cursor-agent not on PATH",
      });
    } else {
      const result = await runProcessGroup({
        argv,
        cwd: opts.cwd,
        stdinPath: promptPath(runId),
        stdoutPath: agentStdoutPath(runId),
        timeoutMs,
      });
      agentCode = result.code ?? 1;
      timedOut = result.timedOut;
      if (timedOut) {
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

    const testArgv = opts.testCmd !== undefined ? ["sh", "-c", opts.testCmd] : ["(detect)"];
    emit(runId, {
      kind: "step_started",
      ts: nowIso(),
      runId,
      step: { id: "verify", argv: testArgv },
    });
    const verify = runVerify(opts.cwd, opts.testCmd);
    emit(runId, {
      kind: "verify_recorded",
      ts: nowIso(),
      runId,
      porcelain: verify.porcelain,
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    emit(runId, { kind: "error", ts: nowIso(), runId, message });
  }

  let view = loadView(runId);
  const result = outcome(view);
  const status = result === "fail" ? "failed" : "done";
  emit(runId, {
    kind: "run_finished",
    ts: nowIso(),
    runId,
    status,
    summary: result,
  });
  view = loadView(runId);
  const markdown = renderReportFromFiles(view, agentStdoutPath(runId));
  writeArtifacts(runId, { summary: summaryJson(view), markdown });
  return { runId, markdown, failed: status === "failed" };
}

export function lastReportPath(runId: RunId): string {
  return reportPath(runId);
}

export { runDir };
