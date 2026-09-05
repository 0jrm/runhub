import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { reduceJsonl } from "../src/reduce.js";
import { extractFinalMessage, renderReport } from "../src/report.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/sample.jsonl");

test("phone report order", () => {
  const view = reduceJsonl(readFileSync(fixture, "utf8"));
  const md = renderReport(view, '{"type":"result","result":"patched the test"}\n');
  const lines = md.trimEnd().split("\n");
  assert.equal(lines[0], "pass");
  assert.match(md, /^pass\n\nfiles changed:\n/);
  assert.match(md, /tests: npm test  exit 0/);
  assert.match(md, /agent:\npatched the test/);
  assert.doesNotMatch(md, /Available models/);
});

test("extractFinalMessage reads last stream-json result", () => {
  const raw = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}',
    '{"type":"tool_call"}',
    '{"type":"result","result":"done for real"}',
  ].join("\n");
  assert.equal(extractFinalMessage(raw), "done for real");
});

test("failed tests include the tail", () => {
  const view = reduceJsonl(readFileSync(fixture, "utf8"));
  assert.ok(view.verify);
  view.verify.testExit = 1;
  view.verify.testTail = "AssertionError: boom";
  view.status = "failed";
  const md = renderReport(view, "");
  assert.match(md, /^fail\n/);
  assert.match(md, /AssertionError: boom/);
});
