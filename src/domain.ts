export type Provider = "cursor" | "claude" | "grok";
export type Persona = "orchestrator" | "coder" | "reviewer" | "verifier" | "reporter";

declare const runIdBrand: unique symbol;
export type RunId = string & { readonly [runIdBrand]: "RunId" };

export type RunStatus =
  | { kind: "queued" }
  | { kind: "running"; startedAt: string }
  | { kind: "done"; endedAt: string }
  | { kind: "failed"; endedAt: string; error: string };

export type QuotaProbe = {
  provider: Provider;
  probe: "ok" | "missing" | "error";
  detail: string;
};

export type QuotaSnapshot = { capturedAt: string; providers: QuotaProbe[] };

export type Step = {
  id: string;
  parentId: string | null;
  persona: Persona;
  provider: Provider;
  argv: string[];
  nativeSessionRef?: string;
  status: RunStatus;
};

export type Event =
  | { kind: "run_created"; ts: string; runId: string; prompt: string; cwd: string }
  | { kind: "quota_snapshot"; ts: string; runId: string; snapshot: QuotaSnapshot }
  | {
      kind: "step_started";
      ts: string;
      runId: string;
      step: Pick<Step, "id" | "parentId" | "persona" | "provider" | "argv">;
    }
  | { kind: "step_chunk"; ts: string; runId: string; stepId: string; stream: "stdout" | "stderr"; text: string }
  | { kind: "step_finished"; ts: string; runId: string; stepId: string; exitCode: number; truncated?: boolean }
  | { kind: "error"; ts: string; runId: string; stepId?: string; message: string }
  | { kind: "run_finished"; ts: string; runId: string; status: "done" | "failed"; summary: string };

export type StepView = Step & {
  stdout: string;
  stderr: string;
  exitCode?: number;
  truncated: boolean;
};

export type RunError = { ts: string; stepId?: string; message: string };

export type RunView = {
  runId: RunId;
  prompt: string;
  cwd: string;
  createdAt: string;
  finishedAt?: string;
  status: "queued" | "running" | "done" | "failed";
  summary?: string;
  quota?: QuotaSnapshot;
  steps: StepView[];
  errors: RunError[];
  dryRun: boolean;
};

export const STEP_LOG_BYTES = 64 * 1024;
export const QUOTA_DETAIL_CHARS = 1000;
export const QUOTA_TIMEOUT_MS = 8000;

export const PROVIDERS: readonly Provider[] = ["cursor", "claude", "grok"];
export const PERSONAS: readonly Persona[] = [
  "orchestrator",
  "coder",
  "reviewer",
  "verifier",
  "reporter",
];

const YOLO_FLAGS = ["--force", "--yolo", "--always-approve", "--dangerously-skip-permissions"] as const;

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

export function truncateChars(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated]`;
}

export function tailBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  const marker = "\n[truncated to last 64KiB]\n";
  const markerBuf = Buffer.from(marker, "utf8");
  const take = Math.max(0, maxBytes - markerBuf.length);
  const slice = buf.subarray(buf.length - take);
  return { text: marker + slice.toString("utf8"), truncated: true };
}

export function yoloEnabled(): boolean {
  return process.env.RUNHUB_YOLO === "1";
}

export function stripYoloFlags(argv: readonly string[]): string[] {
  if (yoloEnabled()) return [...argv];
  return argv.filter((a) => !YOLO_FLAGS.includes(a as (typeof YOLO_FLAGS)[number]));
}

export function yoloFlagsFor(provider: Provider): string[] {
  if (!yoloEnabled()) return [];
  switch (provider) {
    case "cursor":
      return ["--force"];
    case "claude":
      return ["--dangerously-skip-permissions"];
    case "grok":
      return ["--always-approve"];
    default:
      return assertNever(provider);
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function asString(x: unknown, field: string): string {
  if (typeof x !== "string" || x.length === 0) {
    throw new ParseError(`${field} must be a non-empty string`);
  }
  return x;
}

function asNumber(x: unknown, field: string): number {
  if (typeof x !== "number" || !Number.isFinite(x)) {
    throw new ParseError(`${field} must be a finite number`);
  }
  return x;
}

function asTs(x: unknown, field: string): string {
  const s = asString(x, field);
  if (Number.isNaN(Date.parse(s))) throw new ParseError(`${field} must be an ISO timestamp`);
  return s;
}

function asProvider(x: unknown): Provider {
  if (x === "cursor" || x === "claude" || x === "grok") return x;
  throw new ParseError("invalid provider");
}

function asPersona(x: unknown): Persona {
  if (
    x === "orchestrator" ||
    x === "coder" ||
    x === "reviewer" ||
    x === "verifier" ||
    x === "reporter"
  ) {
    return x;
  }
  throw new ParseError("invalid persona");
}

function asStringArray(x: unknown, field: string): string[] {
  if (!Array.isArray(x) || !x.every((i) => typeof i === "string")) {
    throw new ParseError(`${field} must be a string array`);
  }
  return x;
}

function parseQuotaProbe(x: unknown): QuotaProbe {
  if (!isRecord(x)) throw new ParseError("quota probe must be an object");
  const probe = x.probe;
  if (probe !== "ok" && probe !== "missing" && probe !== "error") {
    throw new ParseError("invalid probe status");
  }
  return {
    provider: asProvider(x.provider),
    probe,
    detail: asString(x.detail, "detail"),
  };
}

function parseQuotaSnapshot(x: unknown): QuotaSnapshot {
  if (!isRecord(x)) throw new ParseError("snapshot must be an object");
  if (!Array.isArray(x.providers)) throw new ParseError("snapshot.providers must be an array");
  return {
    capturedAt: asTs(x.capturedAt, "capturedAt"),
    providers: x.providers.map(parseQuotaProbe),
  };
}

function parseStepStart(x: unknown): Pick<Step, "id" | "parentId" | "persona" | "provider" | "argv"> {
  if (!isRecord(x)) throw new ParseError("step must be an object");
  let parentId: string | null = null;
  if (x.parentId !== null && x.parentId !== undefined) {
    parentId = asString(x.parentId, "parentId");
  }
  return {
    id: asString(x.id, "id"),
    parentId,
    persona: asPersona(x.persona),
    provider: asProvider(x.provider),
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
        runId: asString(raw.runId, "runId"),
        prompt: asString(raw.prompt, "prompt"),
        cwd: asString(raw.cwd, "cwd"),
      };
    case "quota_snapshot":
      return {
        kind,
        ts: asTs(raw.ts, "ts"),
        runId: asString(raw.runId, "runId"),
        snapshot: parseQuotaSnapshot(raw.snapshot),
      };
    case "step_started":
      return {
        kind,
        ts: asTs(raw.ts, "ts"),
        runId: asString(raw.runId, "runId"),
        step: parseStepStart(raw.step),
      };
    case "step_chunk": {
      const stream = raw.stream;
      if (stream !== "stdout" && stream !== "stderr") {
        throw new ParseError("stream must be stdout or stderr");
      }
      if (typeof raw.text !== "string") throw new ParseError("text must be a string");
      return {
        kind,
        ts: asTs(raw.ts, "ts"),
        runId: asString(raw.runId, "runId"),
        stepId: asString(raw.stepId, "stepId"),
        stream,
        text: raw.text,
      };
    }
    case "step_finished":
      return {
        kind,
        ts: asTs(raw.ts, "ts"),
        runId: asString(raw.runId, "runId"),
        stepId: asString(raw.stepId, "stepId"),
        exitCode: asNumber(raw.exitCode, "exitCode"),
        ...(raw.truncated === undefined ? {} : { truncated: raw.truncated === true }),
      };
    case "error":
      return {
        kind,
        ts: asTs(raw.ts, "ts"),
        runId: asString(raw.runId, "runId"),
        ...(raw.stepId === undefined ? {} : { stepId: asString(raw.stepId, "stepId") }),
        message: asString(raw.message, "message"),
      };
    case "run_finished": {
      const status = raw.status;
      if (status !== "done" && status !== "failed") {
        throw new ParseError("run status must be done or failed");
      }
      return {
        kind,
        ts: asTs(raw.ts, "ts"),
        runId: asString(raw.runId, "runId"),
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
