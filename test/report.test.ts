import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { reduceJsonl } from "../src/reduce.js";
import { extractFinalMessage, parseReview, renderReport } from "../src/report.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/sample.jsonl");

test("phone report shows diff-stat, branch, merge, not porcelain", () => {
  const view = reduceJsonl(readFileSync(fixture, "utf8"));
  const md = renderReport(view, { agentStdout: '{"type":"result","result":"patched the test"}\n', agentStderr: "" });
  assert.match(md, /^pass\n/);
  assert.match(md, /files changed:\nsrc\/cli.ts \| 2 \+-/);
  assert.match(md, /branch: runhub\/11111111-1111-1111-1111-111111111111/);
  assert.match(md, /merge: git -C \/tmp\/app merge runhub\//);
  assert.doesNotMatch(md, /porcelain/);
  assert.match(md, /agent:\npatched the test/);
});

test("non-zero agent exit includes last 20 stderr lines", () => {
  const view = reduceJsonl(readFileSync(fixture, "utf8"));
  view.agentExit = 1;
  view.status = "failed";
  const stderr = Array.from({ length: 25 }, (_, i) => `e${i}`).join("\n");
  const md = renderReport(view, { agentStdout: "", agentStderr: stderr });
  assert.match(md, /stderr:\ne5\n/);
  assert.doesNotMatch(md, /\ne4\n/);
});

test("review verdict and three bullets", () => {
  const view = reduceJsonl(readFileSync(fixture, "utf8"));
  const raw = [
    "- missing test",
    "- race on write",
    "- docs drift",
    "- extra",
    "APPROVE",
  ].join("\n");
  view.reviewVerdict = "APPROVE";
  view.reviewBody = raw;
  const md = renderReport(view, { agentStdout: "", agentStderr: "" });
  assert.match(md, /review: APPROVE/);
  assert.match(md, /- missing test/);
  assert.match(md, /- docs drift/);
  assert.doesNotMatch(md, /- extra/);
});

test("extractFinalMessage and parseReview", () => {
  assert.equal(extractFinalMessage('{"type":"result","result":"done"}\n'), "done");
  const parsed = parseReview("- bug\nREJECT\n");
  assert.equal(parsed.verdict, "REJECT");
  assert.deepEqual(parsed.bullets, ["- bug"]);
});
