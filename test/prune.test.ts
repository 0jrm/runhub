import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { toRunId } from "../src/domain.js";
import { listRuns, prune, runDir } from "../src/store.js";

test("prune keeps N newest runs", () => {
  const prev = process.env.XDG_DATA_HOME;
  const root = mkdtempSync(join(tmpdir(), "runhub-prune-"));
  process.env.XDG_DATA_HOME = root;
  try {
    const stamps = [
      ["run-aaaaaa01", "2026-01-01T00:00:00.000Z"],
      ["run-aaaaaa02", "2026-01-02T00:00:00.000Z"],
      ["run-aaaaaa03", "2026-01-03T00:00:00.000Z"],
      ["run-aaaaaa04", "2026-01-04T00:00:00.000Z"],
      ["run-aaaaaa05", "2026-01-05T00:00:00.000Z"],
    ] as const;
    for (const [id, ts] of stamps) {
      const runId = toRunId(id);
      mkdirSync(runDir(runId), { recursive: true });
      const events = [
        {
          kind: "run_created",
          ts,
          runId: id,
          prompt: "p",
          cwd: "/tmp",
        },
        {
          kind: "run_finished",
          ts,
          runId: id,
          status: "done",
          summary: "ok",
        },
      ];
      writeFileSync(
        join(runDir(runId), "events.jsonl"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
        "utf8",
      );
    }
    const result = prune(2);
    assert.equal(result.kept.length, 2);
    assert.equal(result.deleted.length, 3);
    const left = listRuns().map((r) => r.runId);
    assert.deepEqual(left, ["run-aaaaaa04", "run-aaaaaa05"]);
  } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev;
  }
});
