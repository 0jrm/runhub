import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { outcome } from "../src/domain.js";
import { reduceJsonl } from "../src/reduce.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/sample.jsonl");

test("reduce events to RunView", () => {
  const view = reduceJsonl(readFileSync(fixture, "utf8"));
  assert.equal(view.runId, "11111111-1111-1111-1111-111111111111");
  assert.equal(view.prompt, "fix the flaky test");
  assert.equal(view.status, "done");
  assert.equal(view.agentExit, 0);
  assert.equal(view.verify?.testCmd, "npm test");
  assert.equal(view.verify?.testExit, 0);
  assert.equal(outcome(view), "pass");
});

test("outcome is fail when tests fail", () => {
  const view = reduceJsonl(readFileSync(fixture, "utf8"));
  assert.ok(view.verify);
  view.verify.testExit = 1;
  view.status = "failed";
  assert.equal(outcome(view), "fail");
});

test("outcome is no-changes when porcelain is empty and tests pass", () => {
  const view = reduceJsonl(readFileSync(fixture, "utf8"));
  assert.ok(view.verify);
  view.verify.porcelain = "";
  assert.equal(outcome(view), "no-changes");
});
