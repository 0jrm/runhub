import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { listOutcome, outcome } from "../src/domain.js";
import { reduceJsonl } from "../src/reduce.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/sample.jsonl");

test("reduce events to RunView", () => {
  const view = reduceJsonl(readFileSync(fixture, "utf8"));
  assert.equal(view.runId, "11111111-1111-1111-1111-111111111111");
  assert.equal(view.agentExit, 0);
  assert.equal(view.verify?.testExit, 0);
  assert.equal(view.branch, "runhub/11111111-1111-1111-1111-111111111111");
  assert.equal(outcome(view), "pass");
});

test("outcome is fail when tests fail", () => {
  const view = reduceJsonl(readFileSync(fixture, "utf8"));
  assert.ok(view.verify);
  view.verify.testExit = 1;
  view.status = "failed";
  assert.equal(outcome(view), "fail");
});

test("outcome is no-changes when diff-stat is empty and tests pass", () => {
  const view = reduceJsonl(readFileSync(fixture, "utf8"));
  assert.ok(view.verify);
  view.verify.diffStat = "";
  assert.equal(outcome(view), "no-changes");
});

test("the outcome table covers every diff and test pairing", () => {
  const view = reduceJsonl(readFileSync(fixture, "utf8"));
  assert.ok(view.verify);
  assert.equal(outcome(view), "pass");

  view.verify.testCmd = undefined;
  view.verify.testExit = undefined;
  assert.equal(outcome(view), "changed-untested");

  view.verify.diffStat = "";
  assert.equal(outcome(view), "no-changes");

  view.verify.testCmd = "npm test";
  view.verify.testExit = 3;
  assert.equal(outcome(view), "fail");

  view.verify.testExit = 127;
  assert.equal(outcome(view), "no-changes");

  view.verify.diffStat = " src/cli.ts | 2 +-";
  view.verify.testCmd = "pytest";
  view.verify.testExit = 127;
  assert.equal(outcome(view), "changed-untested");
});

test("exit 126 or 127 is missing, not fail", () => {
  const view = reduceJsonl(readFileSync(fixture, "utf8"));
  assert.ok(view.verify);
  view.verify.testCmd = "pytest";
  view.verify.testExit = 127;
  assert.equal(outcome(view), "changed-untested");
  view.verify.testExit = 126;
  assert.equal(outcome(view), "changed-untested");
  view.verify.testExit = 1;
  assert.equal(outcome(view), "fail");
});

test("a reduced work_committed sha lands on the view", () => {
  const text = readFileSync(fixture, "utf8").replace(
    /^(.*base_recorded.*)$/m,
    (line) =>
      `${line}\n${JSON.stringify({
        kind: "work_committed",
        ts: "2026-09-04T12:00:03.000Z",
        runId: "11111111-1111-1111-1111-111111111111",
        sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      })}`,
  );
  const view = reduceJsonl(text);
  assert.equal(view.commitSha, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
});

test("REJECT review does not change a passing outcome", () => {
  const view = reduceJsonl(readFileSync(fixture, "utf8"));
  view.reviewVerdict = "REJECT";
  assert.equal(outcome(view), "pass");
});

test("listOutcome marks a killed run as killed", () => {
  const view = reduceJsonl(readFileSync(fixture, "utf8"));
  view.killed = true;
  view.status = "running";
  assert.equal(listOutcome(view), "killed");
});

test("listOutcome marks unfinished runs past timeout as stale", () => {
  const view = reduceJsonl(readFileSync(fixture, "utf8"));
  view.status = "running";
  view.finishedAt = undefined;
  view.timeoutMs = 1000;
  view.createdAt = "2020-01-01T00:00:00.000Z";
  assert.equal(listOutcome(view, Date.parse("2020-01-01T00:00:05.000Z")), "stale");
});

test("tests that already fail on base are not fail", () => {
  const view = reduceJsonl(readFileSync(fixture, "utf8"));
  assert.ok(view.verify);
  view.verify.testExit = 1;
  view.verify.alsoFailingOnBase = true;
  assert.equal(outcome(view), "changed-untested");
  view.verify.diffStat = "";
  assert.equal(outcome(view), "no-changes");
});
