export type AgentKind = "cursor" | "claude";
export type ReviewKind = "claude" | "none";
export type StepId = "agent" | "verify" | "review";
export type Verdict = "APPROVE" | "REJECT" | "unknown";

declare const runIdBrand: unique symbol;
export type RunId = string & { readonly [runIdBrand]: "RunId" };

export type Event =
  | {
      kind: "run_created";
      ts: string;
      runId: string;
      prompt: string;
      cwd: string;
      agent: AgentKind;
      model: string;
      review: ReviewKind;
      timeoutMs: number;
    }
  | { kind: "base_recorded"; ts: string; runId: string; baseSha: string; branch: string }
  | { kind: "step_started"; ts: string; runId: string; step: { id: StepId; argv: string[] } }
  | { kind: "step_finished"; ts: string; runId: string; stepId: StepId; exitCode: number; timedOut?: boolean }
  | {
      kind: "verify_recorded";
      ts: string;
      runId: string;
      baseSha: string;
      diffStat: string;
      testCmd?: string;
      testExit?: number;
      testTail: string;
    }
  | { kind: "review_recorded"; ts: string; runId: string; verdict: Verdict; body: string }
  | { kind: "error"; ts: string; runId: string; stepId?: StepId; message: string }
  | { kind: "run_finished"; ts: string; runId: string; status: "done" | "failed"; summary: string };

export type VerifyResult = {
  baseSha: string;
  diffStat: string;
  testCmd?: string;
  testExit?: number;
  testTail: string;
};

export type RunError = { ts: string; stepId?: StepId; message: string };

export type RunView = {
  runId: RunId;
  prompt: string;
  cwd: string;
  createdAt: string;
  finishedAt?: string;
  status: "queued" | "running" | "done" | "failed";
  summary?: string;
  agent: AgentKind;
  model: string;
  review: ReviewKind;
  timeoutMs: number;
  baseSha?: string;
  branch?: string;
  agentArgv?: string[];
  agentExit?: number;
  agentTimedOut?: boolean;
  verify?: VerifyResult;
  reviewVerdict?: Verdict;
  reviewBody?: string;
  errors: RunError[];
};

export type Outcome = "pass" | "fail" | "no-changes";

export const TEST_TAIL_BYTES = 4096;
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const TEST_TIMEOUT_MS = 10 * 60 * 1000;
export const SPAWN_MAX_BUFFER = 64 * 1024 * 1024;
export const CURSOR_MODEL = "cursor-grok-4.6-medium";
export const CLAUDE_MODEL = "sonnet";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

export function assertNever(x: never): never {
  throw new Error(`unhandled variant: ${String(x)}`);
}

export function nowIso(date = new Date()): string {
  return date.toISOString();
}

export function toRunId(value: string): RunId {
  if (value.length < 8 || /[/\s]/.test(value) || value.includes("..")) {
    throw new ParseError("invalid run id");
  }
  return value as RunId;
}

export function defaultModel(agent: AgentKind): string {
  switch (agent) {
    case "cursor":
      return CURSOR_MODEL;
    case "claude":
      return CLAUDE_MODEL;
    default:
      return assertNever(agent);
  }
}

export function branchName(runId: RunId): string {
  return `runhub/${runId}`;
}

export function tailBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  const marker = "\n[truncated]\n";
  const markerBuf = Buffer.from(marker, "utf8");
  const take = Math.max(0, maxBytes - markerBuf.length);
  const slice = buf.subarray(buf.length - take);
  return { text: marker + slice.toString("utf8"), truncated: true };
}

export function lastLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}

export function outcome(view: RunView): Outcome {
  if (view.status === "failed" || view.agentTimedOut) return "fail";
  if (view.agentExit !== undefined && view.agentExit !== 0) return "fail";
  if (view.verify === undefined) return "fail";
  if (view.verify.testCmd !== undefined && view.verify.testExit !== 0) return "fail";
  if (view.reviewVerdict === "REJECT") return "fail";
  if (view.verify.diffStat.trim() === "") return "no-changes";
  return "pass";
}

export function listOutcome(view: RunView, now = Date.now()): Outcome | "running" | "stale" {
  if (view.status === "done" || view.status === "failed") return outcome(view);
  const deadline = Date.parse(view.createdAt) + view.timeoutMs;
  if (Number.isFinite(deadline) && now > deadline) return "stale";
  return "running";
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function asString(x: unknown, field: string): string {
  if (typeof x !== "string") {
    throw new ParseError(`${field} must be a string`);
  }
  return x;
}

function asNonEmpty(x: unknown, field: string): string {
  const s = asString(x, field);
  if (s.length === 0) throw new ParseError(`${field} must be a non-empty string`);
  return s;
}

function asNumber(x: unknown, field: string): number {
  if (typeof x !== "number" || !Number.isFinite(x)) {
    throw new ParseError(`${field} must be a finite number`);
  }
  return x;
}

function asTs(x: unknown, field: string): string {
  const s = asNonEmpty(x, field);
  if (Number.isNaN(Date.parse(s))) throw new ParseError(`${field} must be an ISO timestamp`);
  return s;
}

function asAgent(x: unknown): AgentKind {
  if (x === "cursor" || x === "claude") return x;
  throw new ParseError("invalid agent");
}

function asReview(x: unknown): ReviewKind {
  if (x === "claude" || x === "none") return x;
  throw new ParseError("invalid review");
}

function asStepId(x: unknown): StepId {
  if (x === "agent" || x === "verify" || x === "review") return x;
  throw new ParseError("invalid step id");
}

function asVerdict(x: unknown): Verdict {
  if (x === "APPROVE" || x === "REJECT" || x === "unknown") return x;
  throw new ParseError("invalid verdict");
}

function asStringArray(x: unknown, field: string): string[] {
  if (!Array.isArray(x) || !x.every((i) => typeof i === "string")) {
    throw new ParseError(`${field} must be a string array`);
  }
  return x;
}

function parseStepStart(x: unknown): { id: StepId; argv: string[] } {
  if (!isRecord(x)) throw new ParseError("step must be an object");
  return {
    id: asStepId(x.id),
    argv: asStringArray(x.argv, "argv"),
  };
}

export function parseEvent(raw: unknown): Event {
  if (!isRecord(raw)) throw new ParseError("event must be an object");
  const kind = raw.kind;
  switch (kind) {
    case "run_created":
      return {
        kind,
        ts: asTs(raw.ts, "ts"),
        runId: asNonEmpty(raw.runId, "runId"),
        prompt: asString(raw.prompt, "prompt"),
        cwd: asNonEmpty(raw.cwd, "cwd"),
        agent: raw.agent === undefined ? "cursor" : asAgent(raw.agent),
        model: typeof raw.model === "string" && raw.model.length > 0 ? raw.model : CURSOR_MODEL,
        review: raw.review === undefined ? "none" : asReview(raw.review),
        timeoutMs:
          typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)
            ? raw.timeoutMs
            : DEFAULT_TIMEOUT_MS,
      };
    case "base_recorded":
      return {
        kind,
        ts: asTs(raw.ts, "ts"),
        runId: asNonEmpty(raw.runId, "runId"),
        baseSha: asNonEmpty(raw.baseSha, "baseSha"),
        branch: asNonEmpty(raw.branch, "branch"),
      };
    case "step_started":
      return {
        kind,
        ts: asTs(raw.ts, "ts"),
        runId: asNonEmpty(raw.runId, "runId"),
        step: parseStepStart(raw.step),
      };
    case "step_finished":
      return {
        kind,
        ts: asTs(raw.ts, "ts"),
        runId: asNonEmpty(raw.runId, "runId"),
        stepId: asStepId(raw.stepId),
        exitCode: asNumber(raw.exitCode, "exitCode"),
        ...(raw.timedOut === true ? { timedOut: true } : {}),
      };
    case "verify_recorded":
      return {
        kind,
        ts: asTs(raw.ts, "ts"),
        runId: asNonEmpty(raw.runId, "runId"),
        baseSha: asNonEmpty(raw.baseSha, "baseSha"),
        diffStat: asString(raw.diffStat, "diffStat"),
        testTail: asString(raw.testTail, "testTail"),
        ...(typeof raw.testCmd === "string" && raw.testCmd.length > 0 ? { testCmd: raw.testCmd } : {}),
        ...(typeof raw.testExit === "number" && Number.isFinite(raw.testExit) ? { testExit: raw.testExit } : {}),
      };
    case "review_recorded":
      return {
        kind,
        ts: asTs(raw.ts, "ts"),
        runId: asNonEmpty(raw.runId, "runId"),
        verdict: asVerdict(raw.verdict),
        body: asString(raw.body, "body"),
      };
    case "error":
      return {
        kind,
        ts: asTs(raw.ts, "ts"),
        runId: asNonEmpty(raw.runId, "runId"),
        ...(raw.stepId === undefined ? {} : { stepId: asStepId(raw.stepId) }),
        message: asNonEmpty(raw.message, "message"),
      };
    case "run_finished": {
      const status = raw.status;
      if (status !== "done" && status !== "failed") {
        throw new ParseError("run status must be done or failed");
      }
      return {
        kind,
        ts: asTs(raw.ts, "ts"),
        runId: asNonEmpty(raw.runId, "runId"),
        status,
        summary: asString(raw.summary, "summary"),
      };
    }
    default:
      throw new ParseError(`unknown event kind: ${String(kind)}`);
  }
}

export function parseEventJson(line: string): Event {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    throw new ParseError("event is not JSON");
  }
  return parseEvent(raw);
}
