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

test("listOutcome marks unfinished runs past timeout as stale", () => {
  const view = reduceJsonl(readFileSync(fixture, "utf8"));
  view.status = "running";
  view.finishedAt = undefined;
  view.timeoutMs = 1000;
  view.createdAt = "2020-01-01T00:00:00.000Z";
  assert.equal(listOutcome(view, Date.parse("2020-01-01T00:00:05.000Z")), "stale");
});
