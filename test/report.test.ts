import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { reduceJsonl } from "../src/reduce.js";
import { extractFinalMessage, mergeCommand, parseReview, renderReport } from "../src/report.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/sample.jsonl");

function view() {
  return reduceJsonl(readFileSync(fixture, "utf8"));
}

test("phone report shows diff-stat, branch, merge, not porcelain", () => {
  const md = renderReport(view(), {
    agentStdout: '{"type":"result","result":"patched the test"}\n',
    agentStderr: "",
  });
  assert.match(md, /^pass\ntook 0m 7s\n\n/);
  assert.match(md, /files changed:\nsrc\/cli.ts \| 2 \+-/);
  assert.match(md, /branch: runhub\/11111111-1111-1111-1111-111111111111/);
  assert.match(md, /merge: git -C '\/tmp\/app' merge runhub\//);
  assert.doesNotMatch(md, /porcelain/);
  assert.match(md, /agent:\npatched the test/);
});

test("merge quotes the cwd so a path with spaces still runs", () => {
  assert.equal(mergeCommand("/tmp/my app", "runhub/x"), "git -C '/tmp/my app' merge runhub/x");
  assert.equal(mergeCommand("/tmp/it's", "runhub/x"), `git -C '/tmp/it'\\''s' merge runhub/x`);
});

test("report line one spells out changed-untested", () => {
  const v = view();
  assert.ok(v.verify);
  v.verify.testCmd = undefined;
  v.verify.testExit = undefined;
  const md = renderReport(v, { agentStdout: "", agentStderr: "" });
  assert.equal(md.split("\n")[0], "changed, untested");
  assert.match(md, /tests: none/);
});

test("non-zero agent exit includes last 20 stderr lines", () => {
  const v = view();
  v.agentExit = 1;
  v.status = "failed";
  const stderr = Array.from({ length: 25 }, (_, i) => `e${i}`).join("\n");
  const md = renderReport(v, { agentStdout: "", agentStderr: stderr });
  assert.match(md, /stderr:\ne5\n/);
  assert.doesNotMatch(md, /\ne4\n/);
});

test("a failing test tail is cut to 12 lines", () => {
  const v = view();
  assert.ok(v.verify);
  v.verify.testExit = 1;
  v.verify.testTail = Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join("\n");
  const md = renderReport(v, { agentStdout: "", agentStderr: "" });
  assert.match(md, /line40/);
  assert.match(md, /line29/);
  assert.doesNotMatch(md, /line28/);
});

test("review verdict and three bullets", () => {
  const v = view();
  v.reviewVerdict = "APPROVE";
  v.reviewBody = ["- missing test", "- race on write", "- docs drift", "- extra", "APPROVE"].join("\n");
  const md = renderReport(v, { agentStdout: "", agentStderr: "" });
  assert.match(md, /review: APPROVE/);
  assert.match(md, /- missing test/);
  assert.match(md, /- docs drift/);
  assert.doesNotMatch(md, /- extra/);
});

test("an unparsed review keeps its last three lines", () => {
  const v = view();
  const body = ["chatter", "line eight", "line nine", "line ten"].join("\n");
  const parsed = parseReview(body);
  assert.equal(parsed.verdict, "unparsed");
  assert.deepEqual(parsed.extra, ["line eight", "line nine", "line ten"]);
  v.reviewVerdict = parsed.verdict;
  v.reviewBody = body;
  const md = renderReport(v, { agentStdout: "", agentStderr: "" });
  assert.match(md, /review: unparsed\nline eight\nline nine\nline ten/);
});

test("parseReview reads the raw text, not just a result envelope", () => {
  const raw = ['{"type":"result","result":"ignored"}', "- bug", "REJECT"].join("\n");
  const parsed = parseReview(raw);
  assert.equal(parsed.verdict, "REJECT");
  assert.deepEqual(parsed.extra, ["- bug"]);
  assert.deepEqual(parseReview("").extra, []);
});

test("a missing final message says so instead of dumping the json tail", () => {
  assert.equal(extractFinalMessage('{"type":"result","result":"done"}\n'), "done");
  const noisy = Array.from(
    { length: 40 },
    (_, i) => `{"type":"assistant","seq":${i},"payload":"chunk-${i}-${"x".repeat(80)}"}`,
  ).join("\n");
  assert.equal(extractFinalMessage(noisy), "(no final message)");
  const md = renderReport(view(), { agentStdout: noisy, agentStderr: "" });
  assert.match(md, /agent:\n\(no final message\)/);
  assert.doesNotMatch(md, /chunk-39/);
});
