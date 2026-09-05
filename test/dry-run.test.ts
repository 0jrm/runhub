import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runPipeline } from "../src/pipeline.js";

test("dry-run writes a report with prompt, probes, and missing-binary skip", async () => {
  const prevXdg = process.env.XDG_DATA_HOME;
  const prevPath = process.env.PATH;
  const root = mkdtempSync(join(tmpdir(), "runhub-dry-"));
  process.env.XDG_DATA_HOME = root;
  process.env.PATH = "";
  try {
    const result = await runPipeline({
      cwd: root,
      prompt: "fix the flaky test",
      execute: "cursor",
      review: "claude",
      report: "grok",
      dryRun: true,
      cheap: false,
    });
    assert.match(result.markdown, /fix the flaky test/);
    assert.match(result.markdown, /not a billing API/);
    assert.match(result.markdown, /Missing binary skip/);
    assert.match(result.markdown, /binary missing from PATH/);
    assert.match(result.markdown, /dry run/i);
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
  }
});
