import { assertNever, parseEventJson, toRunId, type Event, type RunView } from "./domain.js";

export function reduce(events: readonly Event[]): RunView {
  if (events.length === 0) {
    throw new Error("no events");
  }
  const first = events[0];
  if (first === undefined || first.kind !== "run_created") {
    throw new Error("first event must be run_created");
  }

  const view: RunView = {
    runId: toRunId(first.runId),
    prompt: first.prompt,
    cwd: first.cwd,
    createdAt: first.ts,
    status: "queued",
    agent: first.agent,
    model: first.model,
    review: first.review,
    timeoutMs: first.timeoutMs,
    errors: [],
    usages: [],
    ...(first.testCmd === undefined ? {} : { testCmd: first.testCmd }),
    ...(first.typecheckCmd === undefined ? {} : { typecheckCmd: first.typecheckCmd }),
    ...(first.lintCmd === undefined ? {} : { lintCmd: first.lintCmd }),
    ...(first.remote === undefined ? {} : { remote: first.remote }),
  };

  for (const ev of events) {
    switch (ev.kind) {
      case "run_created":
        break;
      case "pipeline_started":
        view.pipelinePid = ev.pid;
        view.status = "running";
        break;
      case "base_recorded":
        view.baseSha = ev.baseSha;
        view.branch = ev.branch;
        view.status = "running";
        break;
      case "work_committed":
        view.commitSha = ev.sha;
        break;
      case "step_started":
        view.status = "running";
        if (ev.step.id === "agent") view.agentArgv = ev.step.argv;
        if (ev.step.id === "review") view.reviewArgv = ev.step.argv;
        break;
      case "step_finished":
        if (ev.stepId === "agent") {
          view.agentExit = ev.exitCode;
          if (ev.timedOut) view.agentTimedOut = true;
        }
        break;
      case "verify_recorded":
        view.verify = {
          baseSha: ev.baseSha,
          diffStat: ev.diffStat,
          testTail: ev.testTail,
          ...(ev.testCmd === undefined ? {} : { testCmd: ev.testCmd }),
          ...(ev.testExit === undefined ? {} : { testExit: ev.testExit }),
          ...(ev.typecheckCmd === undefined ? {} : { typecheckCmd: ev.typecheckCmd }),
          ...(ev.typecheckExit === undefined ? {} : { typecheckExit: ev.typecheckExit }),
          ...(ev.lintCmd === undefined ? {} : { lintCmd: ev.lintCmd }),
          ...(ev.lintExit === undefined ? {} : { lintExit: ev.lintExit }),
        };
        break;
      case "retry_started":
        view.retryAttempt = ev.attempt;
        break;
      case "usage_recorded":
        view.usages.push({
          stepId: ev.stepId,
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
        });
        break;
      case "review_recorded":
        view.reviewVerdict = ev.verdict;
        view.reviewBody = ev.body;
        break;
      case "pr_opened":
        view.prUrl = ev.url;
        break;
      case "error":
        view.errors.push(
          ev.stepId === undefined
            ? { ts: ev.ts, message: ev.message }
            : { ts: ev.ts, stepId: ev.stepId, message: ev.message },
        );
        break;
      case "run_finished":
        view.status = ev.status;
        view.summary = ev.summary;
        view.finishedAt = ev.ts;
        break;
      default:
        assertNever(ev);
    }
  }

  return view;
}

export function reduceJsonl(text: string): RunView {
  const events: Event[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    events.push(parseEventJson(trimmed));
  }
  return reduce(events);
}
