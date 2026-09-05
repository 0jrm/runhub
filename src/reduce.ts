import {
  assertNever,
  parseEventJson,
  toRunId,
  type Event,
  type RunView,
  type StepView,
} from "./domain.js";

function emptyStep(ev: Extract<Event, { kind: "step_started" }>): StepView {
  return {
    id: ev.step.id,
    parentId: ev.step.parentId,
    persona: ev.step.persona,
    provider: ev.step.provider,
    argv: ev.step.argv,
    status: { kind: "running", startedAt: ev.ts },
    stdout: "",
    stderr: "",
    truncated: false,
  };
}

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
    steps: [],
    errors: [],
    dryRun: false,
  };

  const steps = new Map<string, StepView>();

  for (const ev of events) {
    switch (ev.kind) {
      case "run_created":
        break;
      case "quota_snapshot":
        view.quota = ev.snapshot;
        break;
      case "step_started": {
        const step = emptyStep(ev);
        steps.set(step.id, step);
        view.status = "running";
        break;
      }
      case "step_chunk": {
        const step = steps.get(ev.stepId);
        if (!step) break;
        if (ev.stream === "stdout") step.stdout += ev.text;
        else step.stderr += ev.text;
        break;
      }
      case "step_finished": {
        const step = steps.get(ev.stepId);
        if (!step) break;
        step.exitCode = ev.exitCode;
        if (ev.truncated) step.truncated = true;
        if (ev.exitCode === 0) {
          step.status = { kind: "done", endedAt: ev.ts };
        } else {
          step.status = {
            kind: "failed",
            endedAt: ev.ts,
            error: `exit ${ev.exitCode}`,
          };
        }
        break;
      }
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

  view.steps = [...steps.values()];
  view.dryRun = view.steps.length === 0 && view.quota !== undefined;
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
