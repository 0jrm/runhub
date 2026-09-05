import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runPipeline } from "../src/pipeline.js";
import { porcelainPath, prune, reportPath, reviewPath, runsRoot, worktreePath } from "../src/store.js";

function gitRepo(dir: string): void {
  spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "README"), "x\n");
  writeFileSync(join(dir, "package.json"), '{"scripts":{"test":"true"}}\n');
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
}

function withEnv(fn: () => Promise<void>): Promise<void> {
  const prevXdg = process.env.XDG_DATA_HOME;
  const prevPath = process.env.PATH;
  const xdg = mkdtempSync(join(tmpdir(), "runhub-xdg-"));
  process.env.XDG_DATA_HOME = xdg;
  return fn().finally(() => {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
  });
}

test("verify diffs against pre-agent HEAD including commits; porcelain stays on disk", async () => {
  await withEnv(async () => {
    const work = mkdtempSync(join(tmpdir(), "runhub-work-"));
    gitRepo(work);
    const base = spawnSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).stdout.trim();
    const binDir = mkdtempSync(join(tmpdir(), "runhub-bin-"));
    const argvLog = join(binDir, "argv.txt");
    writeFileSync(
      join(binDir, "cursor-agent"),
      `#!/usr/bin/env python3
import subprocess, sys
open(${JSON.stringify(argvLog)}, "w").write(" ".join(sys.argv[1:]))
open("STAMP.txt", "w").write("v03\\n")
subprocess.check_call(["git", "add", "STAMP.txt"])
subprocess.check_call(["git", "commit", "-m", "stamp"])
print('{"type":"result","result":"committed STAMP.txt"}')
`,
    );
    chmodSync(join(binDir, "cursor-agent"), 0o755);
    process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
    const result = await runPipeline({ cwd: work, prompt: "add stamp", testCmd: "true", timeoutMs: 15_000 });
    assert.match(result.markdown, /STAMP.txt/);
    assert.match(result.markdown, /files changed:/);
    assert.match(result.markdown, /branch: runhub\//);
    assert.match(result.markdown, /merge: git -C /);
    assert.doesNotMatch(result.markdown, /^[ M?]{2} /m);
    assert.equal(existsSync(porcelainPath(result.runId)), true);
    assert.ok(readFileSync(argvLog, "utf8").includes("--force"));
    const events = readFileSync(join(runsRoot(), result.runId, "events.jsonl"), "utf8");
    assert.match(events, new RegExp(base));
    const tree = worktreePath(result.runId);
    assert.equal(existsSync(join(tree, "STAMP.txt")), true);
    assert.equal(existsSync(join(work, "STAMP.txt")), false);
    prune(0);
    const branches = spawnSync("git", ["branch"], { cwd: work, encoding: "utf8" }).stdout;
    assert.doesNotMatch(branches, /runhub\//);
  });
});

test("SIGINT abort skips verify and still writes report.md once", async () => {
  await withEnv(async () => {
    const work = mkdtempSync(join(tmpdir(), "runhub-work-"));
    gitRepo(work);
    const binDir = mkdtempSync(join(tmpdir(), "runhub-bin-"));
    writeFileSync(join(binDir, "cursor-agent"), "#!/bin/sh\nexec sleep 999\n");
    chmodSync(join(binDir, "cursor-agent"), 0o755);
    process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const result = await runPipeline({
      cwd: work,
      prompt: "hang",
      timeoutMs: 30_000,
      signal: ac.signal,
    });
    assert.equal(existsSync(reportPath(result.runId)), true);
    const events = readFileSync(join(runsRoot(), result.runId, "events.jsonl"), "utf8");
    assert.match(events, /run_finished/);
    assert.doesNotMatch(events, /verify_recorded/);
    assert.equal(events.split("run_finished").length - 1, 1);
    prune(0);
  });
});

test("agent stderr last 20 lines appear on non-zero exit", async () => {
  await withEnv(async () => {
    const work = mkdtempSync(join(tmpdir(), "runhub-work-"));
    gitRepo(work);
    const binDir = mkdtempSync(join(tmpdir(), "runhub-bin-"));
    writeFileSync(
      join(binDir, "cursor-agent"),
      `#!/usr/bin/env python3
import sys
for i in range(25):
    print(f"err{i}", file=sys.stderr)
sys.exit(2)
`,
    );
    chmodSync(join(binDir, "cursor-agent"), 0o755);
    process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
    const result = await runPipeline({ cwd: work, prompt: "fail", testCmd: "true", timeoutMs: 10_000 });
    assert.match(result.markdown, /stderr:\nerr5/);
    assert.doesNotMatch(result.markdown, /err4\n/);
    prune(0);
  });
});

test("review claude writes review.md and a verdict line", async () => {
  await withEnv(async () => {
    const work = mkdtempSync(join(tmpdir(), "runhub-work-"));
    gitRepo(work);
    const binDir = mkdtempSync(join(tmpdir(), "runhub-bin-"));
    writeFileSync(
      join(binDir, "cursor-agent"),
      `#!/usr/bin/env python3
print('{"type":"result","result":"ok"}')
`,
    );
    writeFileSync(
      join(binDir, "claude"),
      `#!/usr/bin/env python3
import sys
sys.stdin.read()
print("- risk of empty diff")
print("APPROVE")
`,
    );
    chmodSync(join(binDir, "cursor-agent"), 0o755);
    chmodSync(join(binDir, "claude"), 0o755);
    process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ""}`;
    const result = await runPipeline({
      cwd: work,
      prompt: "noop",
      testCmd: "true",
      review: "claude",
      timeoutMs: 10_000,
    });
    assert.equal(existsSync(reviewPath(result.runId)), true);
    assert.match(result.markdown, /review: APPROVE/);
    prune(0);
  });
});
