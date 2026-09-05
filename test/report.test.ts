import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { reduceJsonl } from "../src/reduce.js";
import { renderMarkdown } from "../src/report.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/sample.jsonl");

test("report markdown contains prompt, probes, and missing-binary skip", () => {
  const md = renderMarkdown(reduceJsonl(readFileSync(fixture, "utf8")));
  assert.match(md, /fix the flaky test/);
  assert.match(md, /not a billing API/);
  assert.match(md, /cursor/);
  assert.match(md, /missing/);
  assert.match(md, /Missing binary skip/);
  assert.match(md, /skipped reviewer \(claude\): binary missing from PATH/);
});
