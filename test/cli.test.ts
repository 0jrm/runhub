import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
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

test("run stdout last line is the runhub trailer", () => {
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
    const r = spawnSync(
      process.execPath,
      [cli, "run", "--cwd", work, "--prompt", "x", "--timeout", "10s", "--test-cmd", "true"],
      { encoding: "utf8", env },
    );
    const lines = r.stdout.trimEnd().split("\n");
    const last = lines[lines.length - 1] ?? "";
    assert.match(last, /^runhub: [0-9a-f-]{36} \S+report\.md$/);
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
    const m = last.match(/^runhub: ([0-9a-f-]{36}) /);
    assert.ok(m?.[1], `missing trailer: ${JSON.stringify(stdout)}`);
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

test("SIGINT aborts the CLI run and still prints one trailer", async () => {
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
  const child = spawn(
    process.execPath,
    [cli, "run", "--cwd", work, "--prompt", "hang", "--timeout", "30s"],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise((r) => setTimeout(r, 600));
  child.kill("SIGINT");
  const stdout = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (b: Buffer) => {
      out += b.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });
  const lines = stdout.trimEnd().split("\n");
  const last = lines[lines.length - 1] ?? "";
  const m = last.match(/^runhub: ([0-9a-f-]{36}) (\S+report\.md)$/);
  assert.ok(m?.[1] && m[2], `missing trailer: ${JSON.stringify(stdout)}`);
  const events = readFileSync(join(xdg, "runhub", "runs", m[1], "events.jsonl"), "utf8");
  assert.equal(events.split("run_finished").length - 1, 1);
  assert.doesNotMatch(events, /verify_recorded/);
});

test("--cwd accepts a project name and uses that project's test", () => {
  const xdg = tempDir("cli-name-xdg");
  const work = tempDir("cli-name-work");
  const binDir = tempDir("cli-name-bin");
  gitRepo(work, [{ path: "package.json", body: '{"scripts":{"test":"node --test"}}\n' }]);
  writeFakeAgent(binDir);
  mkdirSync(join(xdg, "runhub"), { recursive: true });
  writeFileSync(join(xdg, "runhub", "projects.toml"), `[toy]\npath = "${work}"\ntest = "true"\n`);
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
  assert.match(named.stdout, /tests: true {2}exit 0/);
  assert.doesNotMatch(named.stdout, /npm test/);
  assert.doesNotMatch(named.stdout, /pytest/);

  writeFileSync(join(xdg, "runhub", "projects.toml"), `[toy]\npath = "${work}"\ntest = "false"\n`);
  const override = spawnSync(
    process.execPath,
    [cli, "run", "--cwd", "toy", "--prompt", "x", "--timeout", "20s", "--test-cmd", "true"],
    { encoding: "utf8", env },
  );
  assert.equal(override.status, 0, override.stderr);
  assert.match(override.stdout, /tests: true {2}exit 0/);
  assert.doesNotMatch(override.stdout, /tests: false/);
});
