import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { toRunId } from "../src/domain.js";
import { listRuns, runDir, tallyLine } from "../src/store.js";

test("listRuns shows project basename, outcome, and stale", () => {
  const prev = process.env.XDG_DATA_HOME;
  const root = mkdtempSync(join(tmpdir(), "runhub-list-"));
  process.env.XDG_DATA_HOME = root;
  try {
    const doneId = toRunId("run-list-done01");
    mkdirSync(runDir(doneId), { recursive: true });
    writeFileSync(
      join(runDir(doneId), "events.jsonl"),
      [
        {
          kind: "run_created",
          ts: "2026-01-02T00:00:00.000Z",
          runId: doneId,
          prompt: "p",
          cwd: "/home/jrm22n/hycom",
          timeoutMs: 1000,
        },
        {
          kind: "run_finished",
          ts: "2026-01-02T00:00:01.000Z",
          runId: doneId,
          status: "failed",
          summary: "fail",
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
      "utf8",
    );

    const staleId = toRunId("run-list-stale1");
    mkdirSync(runDir(staleId), { recursive: true });
    writeFileSync(
      join(runDir(staleId), "events.jsonl"),
      JSON.stringify({
        kind: "run_created",
        ts: "2026-01-01T00:00:00.000Z",
        runId: staleId,
        prompt: "p",
        cwd: "/tmp/markitdown",
        timeoutMs: 1000,
      }) + "\n",
      "utf8",
    );

    const untestedId = toRunId("run-list-untest1");
    mkdirSync(runDir(untestedId), { recursive: true });
    writeFileSync(
      join(runDir(untestedId), "events.jsonl"),
      [
        {
          kind: "run_created",
          ts: "2026-01-03T00:00:00.000Z",
          runId: untestedId,
          prompt: "p",
          cwd: "/tmp/runhub",
          timeoutMs: 1000,
        },
        {
          kind: "verify_recorded",
          ts: "2026-01-03T00:00:01.000Z",
          runId: untestedId,
          baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          diffStat: " src/cli.ts | 2 +-",
          testTail: "no test command",
        },
        {
          kind: "run_finished",
          ts: "2026-01-03T00:00:02.000Z",
          runId: untestedId,
          status: "done",
          summary: "changed-untested",
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
      "utf8",
    );

    const listed = listRuns(Date.parse("2026-01-01T00:00:05.000Z"));
    const byId = new Map(listed.map((r) => [r.runId, r]));
    const done = byId.get(doneId);
    const stale = byId.get(staleId);
    assert.equal(done?.project, "hycom");
    assert.equal(done?.outcome, "fail");
    assert.equal(stale?.project, "markitdown");
    assert.equal(stale?.outcome, "stale");
    assert.equal(byId.get(untestedId)?.outcome, "changed-untested");
    const killedId = toRunId("run-list-killed1");
    mkdirSync(runDir(killedId), { recursive: true });
    writeFileSync(
      join(runDir(killedId), "events.jsonl"),
      [
        {
          kind: "run_created",
          ts: "2026-01-04T00:00:00.000Z",
          runId: killedId,
          prompt: "p",
          cwd: "/tmp/app",
          timeoutMs: 1000,
        },
        {
          kind: "pipeline_started",
          ts: "2026-01-04T00:00:01.000Z",
          runId: killedId,
          pid: 1,
        },
        {
          kind: "run_killed",
          ts: "2026-01-04T00:00:02.000Z",
          runId: killedId,
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
      "utf8",
    );
    const listed2 = listRuns(Date.parse("2026-01-01T00:00:05.000Z"));
    assert.equal(listed2.find((r) => r.runId === killedId)?.outcome, "killed");
    assert.equal(
      tallyLine(listed),
      "last 30: 0 pass, 1 fail, 1 changed-untested, 0 no-changes, 0 running",
    );
  } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev;
  }
});
