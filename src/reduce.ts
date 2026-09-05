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
    errors: [],
  };

  for (const ev of events) {
    switch (ev.kind) {
      case "run_created":
        break;
      case "step_started":
        view.status = "running";
        if (ev.step.id === "agent") view.agentArgv = ev.step.argv;
        break;
      case "step_finished":
        if (ev.stepId === "agent") {
          view.agentExit = ev.exitCode;
          if (ev.timedOut) view.agentTimedOut = true;
        }
        break;
      case "verify_recorded":
        view.verify = {
          porcelain: ev.porcelain,
          diffStat: ev.diffStat,
          testTail: ev.testTail,
          ...(ev.testCmd === undefined ? {} : { testCmd: ev.testCmd }),
          ...(ev.testExit === undefined ? {} : { testExit: ev.testExit }),
        };
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
