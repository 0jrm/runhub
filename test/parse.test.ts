import assert from "node:assert/strict";
import { test } from "node:test";
import { ParseError, parseEvent, parseEventJson } from "../src/domain.js";

test("parseEvent rejects garbage and old kinds", () => {
  assert.throws(() => parseEvent(null), ParseError);
  assert.throws(() => parseEvent({ kind: "quota_snapshot" }), ParseError);
  assert.throws(() => parseEventJson("{"), ParseError);
});

test("parseEvent accepts run_created defaults and verify_recorded", () => {
  const ev = parseEvent({
    kind: "run_created",
    ts: "2026-09-04T12:00:00.000Z",
    runId: "11111111-1111-1111-1111-111111111111",
    prompt: "hello",
    cwd: "/tmp",
  });
  assert.equal(ev.kind, "run_created");
  if (ev.kind === "run_created") assert.equal(ev.agent, "cursor");
  const v = parseEvent({
    kind: "verify_recorded",
    ts: "2026-09-04T12:00:00.000Z",
    runId: "11111111-1111-1111-1111-111111111111",
    baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    diffStat: "",
    testTail: "no test command",
  });
  assert.equal(v.kind, "verify_recorded");
});

test("parseEvent accepts pgid_recorded, push_recorded, run_killed, and deps_warned", () => {
  const pgid = parseEvent({
    kind: "pgid_recorded",
    ts: "2026-09-04T12:00:00.000Z",
    runId: "11111111-1111-1111-1111-111111111111",
    stepId: "agent",
    pgid: 4321,
  });
  assert.equal(pgid.kind, "pgid_recorded");
  const pushed = parseEvent({
    kind: "push_recorded",
    ts: "2026-09-04T12:00:00.000Z",
    runId: "11111111-1111-1111-1111-111111111111",
    remote: "origin",
    branch: "runhub/11111111-1111-1111-1111-111111111111",
  });
  assert.equal(pushed.kind, "push_recorded");
  const killed = parseEvent({
    kind: "run_killed",
    ts: "2026-09-04T12:00:00.000Z",
    runId: "11111111-1111-1111-1111-111111111111",
  });
  assert.equal(killed.kind, "run_killed");
  const deps = parseEvent({
    kind: "deps_warned",
    ts: "2026-09-04T12:00:00.000Z",
    runId: "11111111-1111-1111-1111-111111111111",
    lines: ["deps: node_modules not group-writable, tests may fail"],
  });
  assert.equal(deps.kind, "deps_warned");
});
