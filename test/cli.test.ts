import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { parseTimeout } from "../src/cli.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "../../dist/cli.js");

test("symlink to dist/cli.js still runs help", () => {
  const dir = mkdtempSync(join(tmpdir(), "runhub-link-"));
  const linked = join(dir, "runhub");
  symlinkSync(cli, linked);
  const r = spawnSync(process.execPath, [linked, "help"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /runhub <command>/);
});

function gitRepo(dir: string): void {
  spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "README"), "x\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
}

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

  const missing = spawnSync(
    process.execPath,
    [cli, "run", "--cwd", join(tmpdir(), "no-such-runhub-dir"), "--prompt", "x"],
    { encoding: "utf8" },
  );
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /not a directory/);

  const prev = process.env.XDG_DATA_HOME;
  const xdg = mkdtempSync(join(tmpdir(), "runhub-cli-xdg-"));
  const bare = mkdtempSync(join(tmpdir(), "runhub-nongit-"));
  process.env.XDG_DATA_HOME = xdg;
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
