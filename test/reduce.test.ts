import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { reduceJsonl } from "../src/reduce.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/sample.jsonl");

test("reduce events to RunView", () => {
  const view = reduceJsonl(readFileSync(fixture, "utf8"));
  assert.equal(view.runId, "11111111-1111-1111-1111-111111111111");
  assert.equal(view.prompt, "fix the flaky test");
  assert.equal(view.status, "done");
  assert.equal(view.steps.length, 1);
  const exec = view.steps[0];
  assert.ok(exec);
  assert.equal(exec.id, "exec-1");
  assert.equal(exec.persona, "coder");
  assert.equal(exec.stdout, "patched test");
  assert.equal(exec.status.kind, "done");
  assert.equal(view.quota?.providers[1]?.probe, "missing");
  assert.equal(view.errors.length, 1);
  assert.match(view.errors[0]?.message ?? "", /missing/);
});
