import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { toRunId } from "../src/domain.js";
import { inspectText, snapshotInspect } from "../src/inspect.js";
import { persistSession, resolveInspectRunId, runDir, sessionPath } from "../src/store.js";
import { prepareRun } from "../src/pipeline.js";
import { gitRepo, prependPath, tempDir, writeFakeAgent, writeProjectsToml } from "./helpers.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "../../dist/cli.js");

function writeEvents(id: string, events: unknown[]): void {
  mkdirSync(runDir(toRunId(id)), { recursive: true });
  writeFileSync(join(runDir(toRunId(id)), "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

test("inspect snapshot prints links and tails from the run dir", () => {
  const prev = process.env.XDG_DATA_HOME;
  const xdg = mkdtempSync(join(tmpdir(), "runhub-inspect-snap-"));
  process.env.XDG_DATA_HOME = xdg;
  try {
    const id = "run-inspect-snap01";
    writeEvents(id, [
      {
        kind: "run_created",
        ts: "2026-01-01T00:00:00.000Z",
        runId: id,
        prompt: "p",
        cwd: "/tmp/app",
        timeoutMs: 1000,
      },
      {
        kind: "pipeline_started",
        ts: "2026-01-01T00:00:01.000Z",
        runId: id,
        pid: process.pid,
      },
      {
        kind: "base_recorded",
        ts: "2026-01-01T00:00:02.000Z",
        runId: id,
        baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        branch: "runhub/run-inspect-snap01",
      },
      {
        kind: "verify_recorded",
        ts: "2026-01-01T00:00:03.000Z",
        runId: id,
        baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        diffStat: " README | 1 +",
        testTail: "tests: true  exit 0\nok\n",
        testCmd: "true",
        testExit: 0,
      },
      {
        kind: "run_finished",
        ts: "2026-01-01T00:00:04.000Z",
        runId: id,
        status: "done",
        summary: "pass",
      },
    ]);
    writeFileSync(join(runDir(toRunId(id)), "agent.stdout"), "hello agent\ncursor.com done\n");
    writeFileSync(join(runDir(toRunId(id)), "review.md"), "APPROVE\n");
    persistSession(toRunId(id), {
      pipelinePid: process.pid,
      agentPgid: 4242,
      links: { cursorTranscript: "/tmp/fake-cursor-session.jsonl" },
    });

    const text = inspectText({ runId: id, n: 10 });
    assert.match(text, new RegExp(`run ${id} pass`));
    assert.match(text, /links:/);
    assert.match(text, /cursorTranscript: \/tmp\/fake-cursor-session.jsonl/);
    assert.match(text, /agentPgid: 4242/);
    assert.match(text, /--- agent ---/);
    assert.match(text, /hello agent/);
    assert.match(text, /--- review ---/);
    assert.match(text, /APPROVE/);
    assert.match(text, /--- verify ---/);
    assert.match(text, /tests: true/);

    const linksOnly = inspectText({ runId: id, linksOnly: true });
    assert.match(linksOnly, /links:/);
    assert.doesNotMatch(linksOnly, /--- agent ---/);

    const json = JSON.parse(inspectText({ runId: id, json: true, noTail: true })) as {
      runId: string;
      links: Record<string, string>;
    };
    assert.equal(json.runId, id);
    assert.equal(json.links.cursorTranscript, "/tmp/fake-cursor-session.jsonl");

    writeFileSync(join(runDir(toRunId(id)), "verify.out"), "ok from verify.out\n");
    const verifyOnly = inspectText({ runId: id, tail: "verify", n: 10 });
    assert.match(verifyOnly, /--- verify ---/);
    assert.match(verifyOnly, /ok from verify\.out/);
    assert.doesNotMatch(verifyOnly, /--- agent ---/);
  } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev;
  }
});

test("inspect without runId prefers the latest running run, else the most recent", () => {
  const prev = process.env.XDG_DATA_HOME;
  const xdg = mkdtempSync(join(tmpdir(), "runhub-inspect-def-"));
  process.env.XDG_DATA_HOME = xdg;
  try {
    writeEvents("run-inspect-olddone", [
      {
        kind: "run_created",
        ts: "2026-01-01T00:00:00.000Z",
        runId: "run-inspect-olddone",
        prompt: "p",
        cwd: "/tmp/a",
        timeoutMs: 1000,
      },
      {
        kind: "run_finished",
        ts: "2026-01-01T00:00:01.000Z",
        runId: "run-inspect-olddone",
        status: "done",
        summary: "pass",
      },
    ]);
    writeEvents("run-inspect-running", [
      {
        kind: "run_created",
        ts: "2026-01-02T00:00:00.000Z",
        runId: "run-inspect-running",
        prompt: "p",
        cwd: "/tmp/b",
        timeoutMs: 60_000,
      },
      {
        kind: "pipeline_started",
        ts: "2026-01-02T00:00:01.000Z",
        runId: "run-inspect-running",
        pid: process.pid,
      },
    ]);
    writeEvents("run-inspect-newer", [
      {
        kind: "run_created",
        ts: "2026-01-03T00:00:00.000Z",
        runId: "run-inspect-newer",
        prompt: "p",
        cwd: "/tmp/c",
        timeoutMs: 1000,
      },
      {
        kind: "run_finished",
        ts: "2026-01-03T00:00:01.000Z",
        runId: "run-inspect-newer",
        status: "done",
        summary: "fail",
      },
    ]);

    assert.equal(resolveInspectRunId(undefined), "run-inspect-running");
    const snap = snapshotInspect({});
    assert.equal(snap.runId, "run-inspect-running");

    writeEvents("run-inspect-running", [
      {
        kind: "run_created",
        ts: "2026-01-02T00:00:00.000Z",
        runId: "run-inspect-running",
        prompt: "p",
        cwd: "/tmp/b",
        timeoutMs: 1000,
      },
      {
        kind: "run_finished",
        ts: "2026-01-02T00:00:02.000Z",
        runId: "run-inspect-running",
        status: "done",
        summary: "pass",
      },
    ]);
    assert.equal(resolveInspectRunId(undefined), "run-inspect-newer");
  } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev;
  }
});

test("prepareRun writes session.json and CLI inspect reads it", () => {
  const prevXdg = process.env.XDG_DATA_HOME;
  const prevCfg = process.env.XDG_CONFIG_HOME;
  const xdg = tempDir("inspect-cli-xdg");
  const work = tempDir("inspect-cli-work");
  const binDir = tempDir("inspect-cli-bin");
  gitRepo(work);
  writeFakeAgent(binDir);
  writeProjectsToml(xdg, "work", work);
  process.env.XDG_DATA_HOME = xdg;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const prepared = prepareRun({ cwd: work, prompt: "inspect me" });
    assert.equal(readFileSync(sessionPath(prepared), "utf8").includes(prepared), true);

    const env = {
      ...process.env,
      XDG_DATA_HOME: xdg,
      XDG_CONFIG_HOME: xdg,
      PATH: prependPath(binDir),
    };
    const r = spawnSync(
      process.execPath,
      [cli, "run", "--cwd", work, "--prompt", "x", "--timeout", "20s", "--test-cmd", "true"],
      { encoding: "utf8", env },
    );
    assert.equal(r.status, 0, r.stderr);
    const id = r.stdout.trim().slice("runhub: ".length);
    const waited = spawnSync(process.execPath, [cli, "wait", id, "--timeout", "30s"], { encoding: "utf8", env });
    assert.equal(waited.status, 0, waited.stderr);
    const inspected = spawnSync(process.execPath, [cli, "inspect", id, "--links-only"], { encoding: "utf8", env });
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.match(inspected.stdout, /links:/);
    assert.match(inspected.stdout, /worktree:/);
    const missing = spawnSync(process.execPath, [cli, "inspect", "--links-only"], { encoding: "utf8", env });
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stdout, new RegExp(`run ${id} `));
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    if (prevCfg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevCfg;
  }
});
