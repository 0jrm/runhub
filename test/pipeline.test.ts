import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runPipeline } from "../src/pipeline.js";
import { porcelainPath, prune, reportPath, reviewPath, runDir, runsRoot, worktreePath } from "../src/store.js";
import {
  TRACKED_FILE,
  UNTRACKED_FILE,
  gitRepo,
  headSha,
  porcelainOf,
  prependPath,
  restrictedPath,
  tempDir,
  withEnv,
  writeBin,
  writeFakeAgent,
} from "./helpers.js";

function mergeCommandOf(markdown: string): string {
  const line = markdown.split("\n").find((l) => l.startsWith("merge: "));
  assert.ok(line, `no merge line in report: ${markdown}`);
  return line.slice("merge: ".length);
}

test("agent work is committed after the agent, so the branch and the diff carry it", async () => {
  await withEnv(async () => {
    const work = tempDir("work");
    gitRepo(work);
    const base = headSha(work);
    const binDir = tempDir("bin");
    writeFakeAgent(binDir);
    process.env.PATH = prependPath(binDir);

    const result = await runPipeline({
      cwd: work,
      prompt: "  edit the readme\nand add a file  ",
      testCmd: "true",
      timeoutMs: 15_000,
    });

    const tree = worktreePath(result.runId);
    const treeHead = headSha(tree);
    assert.notEqual(treeHead, base);
    const events = readFileSync(join(runsRoot(), result.runId, "events.jsonl"), "utf8");
    assert.equal(events.split('"work_committed"').length - 1, 1);
    assert.match(events, new RegExp(`"work_committed"[^\\n]*"sha":"${treeHead}"`));

    assert.match(result.markdown, /files changed:/);
    assert.match(result.markdown, new RegExp(TRACKED_FILE));
    assert.match(result.markdown, /NEW\.txt/);

    assert.match(readFileSync(porcelainPath(result.runId), "utf8"), /\?\? NEW\.txt/);
    assert.doesNotMatch(result.markdown, /^[ M?]{2} /m);
    assert.equal(porcelainOf(tree).trim(), "");

    const subject = spawnSync("git", ["log", "-1", "--format=%s"], { cwd: tree, encoding: "utf8" }).stdout.trim();
    assert.equal(subject, "runhub: edit the readme and add a file");

    const merge = spawnSync("sh", ["-c", mergeCommandOf(result.markdown)], { encoding: "utf8" });
    assert.equal(merge.status, 0, merge.stderr);
    assert.equal(existsSync(join(work, UNTRACKED_FILE)), true);
    assert.match(readFileSync(join(work, TRACKED_FILE), "utf8"), /agent edit/);
    prune(0);
  });
});

test("an agent that commits its own work gets no second commit", async () => {
  await withEnv(async () => {
    const work = tempDir("work");
    gitRepo(work);
    const base = headSha(work);
    const binDir = tempDir("bin");
    writeBin(
      binDir,
      "cursor-agent",
      `#!/usr/bin/env python3
import subprocess
open("STAMP.txt", "w").write("v031\\n")
subprocess.check_call(["git", "add", "STAMP.txt"])
subprocess.check_call(["git", "commit", "-q", "-m", "stamp"])
print('{"type":"result","result":"committed STAMP.txt"}')
`,
    );
    process.env.PATH = prependPath(binDir);

    const result = await runPipeline({ cwd: work, prompt: "stamp it", testCmd: "true", timeoutMs: 15_000 });

    const events = readFileSync(join(runsRoot(), result.runId, "events.jsonl"), "utf8");
    assert.match(events, new RegExp(base));
    assert.doesNotMatch(events, /work_committed/);
    assert.match(result.markdown, /STAMP\.txt/);
    assert.equal(readFileSync(porcelainPath(result.runId), "utf8").trim(), "");
    assert.equal(existsSync(join(work, "STAMP.txt")), false);
    prune(0);
  });
});

test("the reviewer reads the committed diff, not the pre-commit tree", async () => {
  await withEnv(async () => {
    const work = tempDir("work");
    gitRepo(work);
    const binDir = tempDir("bin");
    writeFakeAgent(binDir);
    const stdinLog = join(binDir, "review-stdin.txt");
    writeBin(
      binDir,
      "claude",
      `#!/usr/bin/env python3
import sys
open(${JSON.stringify(stdinLog)}, "w").write(sys.stdin.read())
print("- diff looks small")
print("APPROVE")
`,
    );
    process.env.PATH = prependPath(binDir);

    const result = await runPipeline({
      cwd: work,
      prompt: "edit and add",
      testCmd: "true",
      review: "claude",
      timeoutMs: 20_000,
    });

    const captured = readFileSync(stdinLog, "utf8");
    const marker = captured.indexOf("Diff:");
    assert.ok(marker > 0, `no Diff: section: ${captured}`);
    const diff = captured.slice(marker);
    assert.match(diff, new RegExp(TRACKED_FILE));
    assert.match(diff, /NEW\.txt/);
    assert.match(diff, /agent edit/);
    assert.equal(existsSync(reviewPath(result.runId)), true);
    assert.match(result.markdown, /review: APPROVE/);
    prune(0);
  });
});

test("gitignored dependency dirs are symlinked so tests can run in the worktree", async () => {
  await withEnv(async () => {
    const work = tempDir("work");
    gitRepo(work, [
      { path: ".gitignore", body: "node_modules\n" },
      {
        path: "package.json",
        body: `${JSON.stringify(
          { name: "depcheck", version: "1.0.0", scripts: { test: "node -e \"require('dep')\"" } },
          null,
          2,
        )}\n`,
      },
    ]);
    mkdirSync(join(work, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(work, "node_modules", "dep", "package.json"), '{"name":"dep","main":"index.js"}\n');
    writeFileSync(join(work, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    const binDir = tempDir("bin");
    writeFakeAgent(binDir);
    process.env.PATH = prependPath(binDir);

    const result = await runPipeline({ cwd: work, prompt: "use the dep", timeoutMs: 60_000 });

    const tree = worktreePath(result.runId);
    assert.equal(lstatSync(join(tree, "node_modules")).isSymbolicLink(), true);
    assert.match(result.markdown, /tests: npm test {2}exit 0/);
    assert.doesNotMatch(result.markdown, /node_modules/);

    prune(0);
    assert.equal(existsSync(join(work, "node_modules", "dep", "index.js")), true);
  });
});

test("a dependency dir the repo does not ignore is still left out of the commit", async () => {
  await withEnv(async () => {
    const work = tempDir("work");
    gitRepo(work);
    const binDir = tempDir("bin");
    writeBin(
      binDir,
      "cursor-agent",
      `#!/usr/bin/env python3
import os
os.makedirs("node_modules/junk", exist_ok=True)
open("node_modules/junk/index.js", "w").write("module.exports = 1;\\n")
open(${JSON.stringify(TRACKED_FILE)}, "a").write("agent edit\\n")
print('{"type":"result","result":"installed junk"}')
`,
    );
    process.env.PATH = prependPath(binDir);

    const result = await runPipeline({ cwd: work, prompt: "install junk", timeoutMs: 15_000 });

    assert.match(result.markdown, /^changed, untested  /);
    assert.equal(result.failed, false);

    const tree = worktreePath(result.runId);
    const committed = spawnSync("git", ["show", "--stat", "--format=", "HEAD"], {
      cwd: tree,
      encoding: "utf8",
    }).stdout;
    assert.match(committed, new RegExp(TRACKED_FILE));
    assert.doesNotMatch(committed, /node_modules/);
    assert.match(porcelainOf(tree), /\?\? node_modules\//);
    prune(0);
  });
});

test("a failing test prints a 12-line excerpt and keeps the full log", async () => {
  await withEnv(async () => {
    const work = tempDir("work");
    gitRepo(work);
    const binDir = tempDir("bin");
    writeFakeAgent(binDir);
    process.env.PATH = prependPath(binDir);

    const result = await runPipeline({
      cwd: work,
      prompt: "break the tests",
      testCmd: 'i=1; while [ $i -le 40 ]; do echo "line$i"; i=$((i+1)); done; exit 1',
      timeoutMs: 20_000,
    });

    assert.match(result.markdown, /^fail  /);
    assert.match(result.markdown, /line40/);
    assert.match(result.markdown, /line29/);
    assert.doesNotMatch(result.markdown, /line28/);
    const full = readFileSync(join(runDir(result.runId), "verify.out"), "utf8");
    assert.equal(full.trimEnd().split("\n").length, 40);
    assert.match(full, /line1\n/);
    prune(0);
  });
});

test("SIGINT abort skips land and verify and still writes report.md once", async () => {
  await withEnv(async () => {
    const work = tempDir("work");
    gitRepo(work);
    const binDir = tempDir("bin");
    writeBin(binDir, "cursor-agent", "#!/bin/sh\nexec sleep 999\n");
    process.env.PATH = prependPath(binDir);
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
    assert.doesNotMatch(events, /work_committed/);
    assert.equal(events.split("run_finished").length - 1, 1);
    prune(0);
  });
});

test("a non-zero agent still lands its work and shows 20 stderr lines", async () => {
  await withEnv(async () => {
    const work = tempDir("work");
    gitRepo(work);
    const binDir = tempDir("bin");
    writeBin(
      binDir,
      "cursor-agent",
      `#!/usr/bin/env python3
import sys
open(${JSON.stringify(TRACKED_FILE)}, "a").write("half done\\n")
for i in range(25):
    print(f"err{i}", file=sys.stderr)
sys.exit(2)
`,
    );
    process.env.PATH = prependPath(binDir);
    const result = await runPipeline({ cwd: work, prompt: "fail", testCmd: "true", timeoutMs: 10_000 });
    assert.match(result.markdown, /^fail  /);
    assert.match(result.markdown, /stderr:\nerr5/);
    assert.doesNotMatch(result.markdown, /err4\n/);
    const events = readFileSync(join(runsRoot(), result.runId, "events.jsonl"), "utf8");
    assert.match(events, /work_committed/);
    assert.match(result.markdown, new RegExp(`files changed:\\n[^]*${TRACKED_FILE}`));
    prune(0);
  });
});

test("a missing pytest binary is changed-untested, not fail", async () => {
  await withEnv(async () => {
    const work = tempDir("work");
    gitRepo(work, [
      { path: "packages/x/pyproject.toml", body: "[project]\nname = \"x\"\n" },
      { path: "packages/x/tests/test_ok.py", body: "def test_ok():\n    assert True\n" },
    ]);
    const binDir = restrictedPath(["git", "sh", "python3"]);
    writeFakeAgent(binDir);
    process.env.PATH = binDir;
    const result = await runPipeline({ cwd: work, prompt: "edit", timeoutMs: 20_000 });
    assert.equal(result.failed, false);
    assert.match(result.markdown, /^changed, untested  /);
    assert.match(result.markdown, /tests: pytest \(not found on PATH\)/);
    assert.doesNotMatch(result.markdown, /exit 12[67]/);
    prune(0);
  });
});

test("tests pass and review REJECT still print pass then review REJECT", async () => {
  await withEnv(async () => {
    const work = tempDir("work");
    gitRepo(work);
    const binDir = tempDir("bin");
    writeFakeAgent(binDir);
    writeBin(
      binDir,
      "claude",
      `#!/usr/bin/env python3
print("- a risk")
print("REJECT")
`,
    );
    process.env.PATH = prependPath(binDir);
    const result = await runPipeline({
      cwd: work,
      prompt: "edit",
      testCmd: "true",
      review: "claude",
      timeoutMs: 20_000,
    });
    assert.match(result.markdown, /^pass  /);
    assert.match(result.markdown, /review: REJECT/);
    assert.equal(result.failed, false);
    prune(0);
  });
});

test("one retry reruns the agent when tests fail then pass", async () => {
  await withEnv(async () => {
    const work = tempDir("work");
    gitRepo(work);
    const binDir = tempDir("bin");
    writeBin(
      binDir,
      "cursor-agent",
      `#!/usr/bin/env python3
from pathlib import Path
p = Path(".agent-calls")
n = int(p.read_text()) + 1 if p.exists() else 1
p.write_text(str(n))
Path("STAMP.txt").write_text("n=%s\\n" % n)
print('{"type":"result","result":"call %s","usage":{"inputTokens":1100,"outputTokens":20}}' % n)
`,
    );
    process.env.PATH = prependPath(binDir);
    const result = await runPipeline({
      cwd: work,
      prompt: "fix tests",
      testCmd: 'test "$(cat .agent-calls)" = 2',
      timeoutMs: 20_000,
    });
    const events = readFileSync(join(runsRoot(), result.runId, "events.jsonl"), "utf8");
    assert.equal(events.split('"retry_started"').length - 1, 1);
    assert.equal(events.split('"verify_recorded"').length - 1, 2);
    assert.match(result.markdown, /retry: 1, tests then passed/);
    assert.match(result.markdown, /usage: 1k in \/ 0k out/);
    prune(0);
  });
});

test("push and gh pr create record argv and replace the merge line", async () => {
  await withEnv(async () => {
    const work = tempDir("work");
    gitRepo(work);
    const bare = tempDir("bare");
    spawnSync("git", ["init", "-q", "--bare"], { cwd: bare, encoding: "utf8" });
    spawnSync("git", ["remote", "add", "origin", bare], { cwd: work, encoding: "utf8" });
    const binDir = tempDir("bin");
    writeFakeAgent(binDir);
    const argvLog = join(binDir, "gh-argv.txt");
    writeBin(
      binDir,
      "gh",
      `#!/bin/sh
echo "$@" >> ${JSON.stringify(argvLog)}
if [ "$1" = "auth" ]; then exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then echo "https://github.com/0jrm/toy/pull/9"; exit 0; fi
exit 0
`,
    );
    process.env.PATH = prependPath(binDir);
    const result = await runPipeline({ cwd: work, prompt: "open a pr please", testCmd: "true", timeoutMs: 20_000 });
    const logged = readFileSync(argvLog, "utf8");
    assert.match(logged, /auth status/);
    assert.match(logged, /pr create --head runhub\//);
    assert.match(logged, /--body-file /);
    assert.match(result.markdown, /pr: https:\/\/github.com\/0jrm\/toy\/pull\/9/);
    assert.doesNotMatch(result.markdown, /^merge: /m);
    const events = readFileSync(join(runsRoot(), result.runId, "events.jsonl"), "utf8");
    assert.match(events, /pr_opened/);
    prune(0);
  });
});

test("typecheck and lint lines are recorded and a missing binary is not fail", async () => {
  await withEnv(async () => {
    const work = tempDir("work");
    gitRepo(work, [
      {
        path: "package.json",
        body: `${JSON.stringify({ name: "t", scripts: { typecheck: "true", lint: "true" } })}\n`,
      },
    ]);
    const binDir = tempDir("bin");
    writeFakeAgent(binDir);
    process.env.PATH = prependPath(binDir);
    const result = await runPipeline({ cwd: work, prompt: "edit", testCmd: "true", timeoutMs: 20_000 });
    assert.match(result.markdown, /typecheck: npm run typecheck {2}exit 0/);
    assert.match(result.markdown, /lint: npm run lint {2}exit 0/);
    prune(0);
  });
});
