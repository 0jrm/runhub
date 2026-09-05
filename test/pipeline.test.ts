import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runPipeline } from "../src/pipeline.js";
import { reportPath, runsRoot } from "../src/store.js";

function gitRepo(dir: string): void {
  spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "README"), "x\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
}

test("pipeline writes report.md, keeps prompt off argv, and holds 200KB agent stdout", async () => {
  const prevXdg = process.env.XDG_DATA_HOME;
  const prevPath = process.env.PATH;
  const xdg = mkdtempSync(join(tmpdir(), "runhub-xdg-"));
  process.env.XDG_DATA_HOME = xdg;
  try {
    const work = mkdtempSync(join(tmpdir(), "runhub-work-"));
    gitRepo(work);
    const binDir = mkdtempSync(join(tmpdir(), "runhub-bin-"));
    const argvLog = join(binDir, "argv.txt");
    const stdinLog = join(binDir, "stdin.txt");
    const bin = join(binDir, "cursor-agent");
    writeFileSync(
      bin,
      `#!/usr/bin/env python3
import sys
open(${JSON.stringify(argvLog)}, "w").write(" ".join(sys.argv[1:]))
open(${JSON.stringify(stdinLog)}, "w").write(sys.stdin.read())
print('{"type":"assistant"}')
print("x" * 210000)
print('{"type":"result","result":"touched files"}')
`,
    );
    chmodSync(bin, 0o755);
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ""}`;
    const result = await runPipeline({
      cwd: work,
      prompt: "do the secret task",
      testCmd: "false",
      timeoutMs: 10_000,
    });
    assert.match(result.markdown, /^fail\n/);
    assert.match(result.markdown, /tests: false  exit /);
    assert.match(result.markdown, /agent:\ntouched files/);
    assert.equal(existsSync(reportPath(result.runId)), true);
    assert.doesNotMatch(readFileSync(argvLog, "utf8"), /secret task/);
    assert.equal(readFileSync(stdinLog, "utf8"), "do the secret task");
    const stdout = readFileSync(join(runsRoot(), result.runId, "agent.stdout"), "utf8");
    assert.ok(Buffer.byteLength(stdout) > 200_000);
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
  }
});
