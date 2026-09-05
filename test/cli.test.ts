import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { parseTimeout } from "../src/cli.js";
import { gitRepo, prependPath, tempDir, writeFakeAgent } from "./helpers.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "../../dist/cli.js");

test("symlink to dist/cli.js still runs help", () => {
  const dir = mkdtempSync(join(tmpdir(), "runhub-link-"));
  const linked = join(dir, "runhub");
  symlinkSync(cli, linked);
  const r = spawnSync(process.execPath, [linked, "help"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /runhub <command>/);
});

test("parseTimeout accepts duration and seconds", () => {
  assert.equal(parseTimeout(undefined), 30 * 60 * 1000);
  assert.equal(parseTimeout("90s"), 90_000);
  assert.equal(parseTimeout("2m"), 120_000);
  assert.equal(parseTimeout("1h"), 3_600_000);
  assert.equal(parseTimeout("15"), 15_000);
});

test("unknown flag, bad agent/review, and missing cwd fail fast", () => {
  const unknown = spawnSync(process.execPath, [cli, "run", "--cwd", "/tmp", "--prompt", "x", "--cheap"], {
    encoding: "utf8",
  });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown flag --cheap/);

  const agent = spawnSync(
    process.execPath,
    [cli, "run", "--cwd", "/tmp", "--prompt", "x", "--agent", "codex"],
    { encoding: "utf8" },
  );
  assert.notEqual(agent.status, 0);
  assert.match(agent.stderr, /--agent must be cursor or claude/);

  const review = spawnSync(
    process.execPath,
    [cli, "run", "--cwd", "/tmp", "--prompt", "x", "--review", "gpt"],
    { encoding: "utf8" },
  );
  assert.notEqual(review.status, 0);
  assert.match(review.stderr, /--review must be claude or none/);

  const cfg = mkdtempSync(join(tmpdir(), "runhub-cli-cfg-"));
  const missing = spawnSync(
    process.execPath,
    [cli, "run", "--cwd", join(tmpdir(), "no-such-runhub-dir"), "--prompt", "x"],
    { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: cfg } },
  );
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /not a directory/);

  const prev = process.env.XDG_DATA_HOME;
  const prevCfg = process.env.XDG_CONFIG_HOME;
  const xdg = mkdtempSync(join(tmpdir(), "runhub-cli-xdg-"));
  const bare = mkdtempSync(join(tmpdir(), "runhub-nongit-"));
  process.env.XDG_DATA_HOME = xdg;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const nongit = spawnSync(process.execPath, [cli, "run", "--cwd", bare, "--prompt", "x"], {
      encoding: "utf8",
      env: process.env,
    });
    assert.notEqual(nongit.status, 0);
    assert.match(nongit.stderr, /not a git repo/);
  } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev;
    if (prevCfg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevCfg;
  }
});

test("run prints only the run id and wait prints the report", () => {
  const prevXdg = process.env.XDG_DATA_HOME;
  const xdg = mkdtempSync(join(tmpdir(), "runhub-cli-trail-"));
  const work = mkdtempSync(join(tmpdir(), "runhub-cli-work-"));
  const binDir = mkdtempSync(join(tmpdir(), "runhub-cli-bin-"));
  gitRepo(work);
  writeFileSync(join(binDir, "cursor-agent"), "#!/bin/sh\necho '{\"type\":\"result\",\"result\":\"ok\"}'\n");
  chmodSync(join(binDir, "cursor-agent"), 0o755);
  const env = {
    ...process.env,
    XDG_DATA_HOME: xdg,
    XDG_CONFIG_HOME: xdg,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
  };
  try {
    const started = Date.now();
    const r = spawnSync(
      process.execPath,
      [cli, "run", "--cwd", work, "--prompt", "x", "--timeout", "10s", "--test-cmd", "true"],
      { encoding: "utf8", env },
    );
    const elapsed = Date.now() - started;
    assert.equal(r.status, 0, r.stderr);
    assert.ok(elapsed < 2000, `run took ${elapsed}ms`);
    const idLine = r.stdout.trim();
    assert.match(idLine, /^runhub: [0-9a-f-]{36}$/);
    const id = idLine.slice("runhub: ".length);
    const waited = spawnSync(process.execPath, [cli, "wait", id, "--timeout", "30s"], {
      encoding: "utf8",
      env,
    });
    assert.equal(waited.status, 0, waited.stderr);
    assert.match(waited.stdout, /files changed:/);
    assert.match(waited.stdout, /took /);
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
  }
});

test("run takes the prompt from a file or stdin, and needs exactly one source", () => {
  const xdg = tempDir("cli-prompt-xdg");
  const work = tempDir("cli-prompt-work");
  const binDir = tempDir("cli-prompt-bin");
  gitRepo(work);
  writeFakeAgent(binDir);
  const env = { ...process.env, XDG_DATA_HOME: xdg, XDG_CONFIG_HOME: xdg, PATH: prependPath(binDir) };
  const spec = "line one\nline two\n";
  const specPath = join(binDir, "spec.md");
  writeFileSync(specPath, spec);
  const base = [cli, "run", "--cwd", work, "--timeout", "20s", "--test-cmd", "true"];

  const promptOf = (stdout: string): string => {
    const last = stdout.trimEnd().split("\n").pop() ?? "";
    const m = last.match(/^runhub: ([0-9a-f-]{36})$/);
    assert.ok(m?.[1], `missing id: ${JSON.stringify(stdout)}`);
    return readFileSync(join(xdg, "runhub", "runs", m[1], "prompt.txt"), "utf8");
  };

  const fromFile = spawnSync(process.execPath, [...base, "--prompt-file", specPath], {
    encoding: "utf8",
    env,
  });
  assert.equal(fromFile.status, 0, fromFile.stderr);
  assert.equal(promptOf(fromFile.stdout), spec);

  const fromStdin = spawnSync(process.execPath, [...base, "--prompt", "-"], {
    encoding: "utf8",
    env,
    input: spec,
  });
  assert.equal(fromStdin.status, 0, fromStdin.stderr);
  assert.equal(promptOf(fromStdin.stdout), spec);

  const both = spawnSync(
    process.execPath,
    [...base, "--prompt", "x", "--prompt-file", specPath],
    { encoding: "utf8", env },
  );
  assert.notEqual(both.status, 0);
  assert.match(both.stderr, /either --prompt or --prompt-file, not both/);

  const neither = spawnSync(process.execPath, base, { encoding: "utf8", env });
  assert.notEqual(neither.status, 0);
  assert.match(neither.stderr, /run requires --prompt or --prompt-file/);
});

test("wait times out with exit 3 while a sleeping agent keeps running", async () => {
  const xdg = mkdtempSync(join(tmpdir(), "runhub-cli-sig-"));
  const work = mkdtempSync(join(tmpdir(), "runhub-cli-sigw-"));
  const binDir = mkdtempSync(join(tmpdir(), "runhub-cli-sigb-"));
  gitRepo(work);
  writeFileSync(join(binDir, "cursor-agent"), "#!/bin/sh\nexec sleep 999\n");
  chmodSync(join(binDir, "cursor-agent"), 0o755);
  const env = {
    ...process.env,
    XDG_DATA_HOME: xdg,
    XDG_CONFIG_HOME: xdg,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
  };
  const r = spawnSync(
    process.execPath,
    [cli, "run", "--cwd", work, "--prompt", "hang", "--timeout", "30s"],
    { encoding: "utf8", env },
  );
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.trim().slice("runhub: ".length);
  const waited = spawnSync(process.execPath, [cli, "wait", id, "--timeout", "1s"], {
    encoding: "utf8",
    env,
  });
  assert.equal(waited.status, 3);
  assert.equal(waited.stdout.trim(), `still running: ${id}`);
  const events = readFileSync(join(xdg, "runhub", "runs", id, "events.jsonl"), "utf8");
  const pidMatch = events.match(/"pid":(\d+)/);
  assert.ok(pidMatch?.[1], events);
  try {
    process.kill(-Number(pidMatch[1]), "SIGKILL");
  } catch {
    return;
  }
});

test("SIGKILL of the __exec worker makes list show stale", async () => {
  const xdg = mkdtempSync(join(tmpdir(), "runhub-cli-kill-"));
  const work = mkdtempSync(join(tmpdir(), "runhub-cli-killw-"));
  const binDir = mkdtempSync(join(tmpdir(), "runhub-cli-killb-"));
  gitRepo(work);
  writeFileSync(join(binDir, "cursor-agent"), "#!/bin/sh\nexec sleep 999\n");
  chmodSync(join(binDir, "cursor-agent"), 0o755);
  const env = {
    ...process.env,
    XDG_DATA_HOME: xdg,
    XDG_CONFIG_HOME: xdg,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
  };
  const r = spawnSync(
    process.execPath,
    [cli, "run", "--cwd", work, "--prompt", "hang", "--timeout", "30s"],
    { encoding: "utf8", env },
  );
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.trim().slice("runhub: ".length);
  const eventsPath = join(xdg, "runhub", "runs", id, "events.jsonl");
  let pid: number | undefined;
  let agentPgid: number | undefined;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    let events = "";
    try {
      events = readFileSync(eventsPath, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    const pidMatch = events.match(/"kind":"pipeline_started"[^}]*"pid":(\d+)/);
    const pgidMatch = events.match(/"kind":"pgid_recorded"[^}]*"pgid":(\d+)/);
    if (pidMatch?.[1] !== undefined) pid = Number(pidMatch[1]);
    if (pgidMatch?.[1] !== undefined) agentPgid = Number(pgidMatch[1]);
    if (pid !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(pid !== undefined, "pipeline pid missing");
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
  if (agentPgid !== undefined) {
    try {
      process.kill(-agentPgid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  let listed = "";
  const listDeadline = Date.now() + 5_000;
  while (Date.now() < listDeadline) {
    const out = spawnSync(process.execPath, [cli, "list"], { encoding: "utf8", env });
    listed = out.stdout;
    if (new RegExp(`${id} \\S+ stale `).test(listed)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(listed, new RegExp(`${id} \\S+ stale `));
});

test("kill stops a live run and list shows killed", async () => {
  const xdg = mkdtempSync(join(tmpdir(), "runhub-cli-rhkill-"));
  const work = mkdtempSync(join(tmpdir(), "runhub-cli-rhkillw-"));
  const binDir = mkdtempSync(join(tmpdir(), "runhub-cli-rhkillb-"));
  gitRepo(work);
  writeFileSync(join(binDir, "cursor-agent"), "#!/bin/sh\nexec sleep 999\n");
  chmodSync(join(binDir, "cursor-agent"), 0o755);
  const env = {
    ...process.env,
    XDG_DATA_HOME: xdg,
    XDG_CONFIG_HOME: xdg,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
  };
  const r = spawnSync(
    process.execPath,
    [cli, "run", "--cwd", work, "--prompt", "hang", "--timeout", "30s"],
    { encoding: "utf8", env },
  );
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.trim().slice("runhub: ".length);
  const eventsPath = join(xdg, "runhub", "runs", id, "events.jsonl");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    let events = "";
    try {
      events = readFileSync(eventsPath, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    if (/"kind":"pgid_recorded"/.test(events) && /"kind":"pipeline_started"/.test(events)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const killed = spawnSync(process.execPath, [cli, "kill", id], { encoding: "utf8", env });
  assert.equal(killed.status, 0, killed.stderr);
  assert.equal(killed.stdout.trim(), `killed ${id}`);
  const listed = spawnSync(process.execPath, [cli, "list"], { encoding: "utf8", env });
  assert.match(listed.stdout, new RegExp(`${id} \\S+ killed `));
});

test("--cwd accepts a project name and uses that project's test", () => {
  const xdg = tempDir("cli-name-xdg");
  const work = tempDir("cli-name-work");
  const binDir = tempDir("cli-name-bin");
  gitRepo(work, [{ path: "package.json", body: '{"scripts":{"test":"node --test"}}\n' }]);
  writeFakeAgent(binDir);
  mkdirSync(join(xdg, "runhub"), { recursive: true });
  writeFileSync(join(xdg, "runhub", "projects.toml"), `[toy]\npath = "${work}"\ntest = "true"\nsandbox = none\n`);
  const env = {
    ...process.env,
    XDG_DATA_HOME: xdg,
    XDG_CONFIG_HOME: xdg,
    PATH: prependPath(binDir),
  };
  const named = spawnSync(
    process.execPath,
    [cli, "run", "--cwd", "toy", "--prompt", "x", "--timeout", "20s"],
    { encoding: "utf8", env },
  );
  assert.equal(named.status, 0, named.stderr);
  const namedId = named.stdout.trim().slice("runhub: ".length);
  const namedWait = spawnSync(process.execPath, [cli, "wait", namedId, "--timeout", "30s"], {
    encoding: "utf8",
    env,
  });
  assert.equal(namedWait.status, 0, namedWait.stderr);
  assert.match(namedWait.stdout, /tests: true {2}exit 0/);
  assert.doesNotMatch(namedWait.stdout, /npm test/);
  assert.doesNotMatch(namedWait.stdout, /pytest/);

  writeFileSync(join(xdg, "runhub", "projects.toml"), `[toy]\npath = "${work}"\ntest = "false"\nsandbox = none\n`);
  const override = spawnSync(
    process.execPath,
    [cli, "run", "--cwd", "toy", "--prompt", "x", "--timeout", "20s", "--test-cmd", "true"],
    { encoding: "utf8", env },
  );
  assert.equal(override.status, 0, override.stderr);
  const overrideId = override.stdout.trim().slice("runhub: ".length);
  const overrideWait = spawnSync(process.execPath, [cli, "wait", overrideId, "--timeout", "30s"], {
    encoding: "utf8",
    env,
  });
  assert.match(overrideWait.stdout, /tests: true {2}exit 0/);
  assert.doesNotMatch(overrideWait.stdout, /tests: false/);
});

test("merge uses gh pr merge when a PR URL was recorded", () => {
  const xdg = tempDir("cli-merge-xdg");
  const work = tempDir("cli-merge-work");
  const binDir = tempDir("cli-merge-bin");
  gitRepo(work);
  writeFakeAgent(binDir);
  const argvLog = join(binDir, "gh-argv.txt");
  writeFileSync(
    join(binDir, "gh"),
    `#!/bin/sh
echo "$@" >> ${JSON.stringify(argvLog)}
exit 0
`,
  );
  chmodSync(join(binDir, "gh"), 0o755);
  const env = { ...process.env, XDG_DATA_HOME: xdg, XDG_CONFIG_HOME: xdg, PATH: prependPath(binDir) };
  mkdirSync(join(xdg, "runhub", "runs", "run-merge01aaaa"), { recursive: true });
  writeFileSync(
    join(xdg, "runhub", "runs", "run-merge01aaaa", "events.jsonl"),
    [
      {
        kind: "run_created",
        ts: "2026-01-01T00:00:00.000Z",
        runId: "run-merge01aaaa",
        prompt: "p",
        cwd: work,
        timeoutMs: 1000,
      },
      {
        kind: "base_recorded",
        ts: "2026-01-01T00:00:01.000Z",
        runId: "run-merge01aaaa",
        baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        branch: "runhub/run-merge01aaaa",
      },
      {
        kind: "pr_opened",
        ts: "2026-01-01T00:00:02.000Z",
        runId: "run-merge01aaaa",
        url: "https://github.com/0jrm/toy/pull/9",
      },
      {
        kind: "run_finished",
        ts: "2026-01-01T00:00:03.000Z",
        runId: "run-merge01aaaa",
        status: "done",
        summary: "pass",
      },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  const merged = spawnSync(process.execPath, [cli, "merge", "run-merge01aaaa"], { encoding: "utf8", env });
  assert.equal(merged.status, 0, merged.stderr);
  assert.match(readFileSync(argvLog, "utf8"), /pr merge https:\/\/github.com\/0jrm\/toy\/pull\/9 --squash --delete-branch/);
});

