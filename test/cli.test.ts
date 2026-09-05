import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { parseTimeout } from "../src/cli.js";

const cli = join(dirname(fileURLToPath(import.meta.url)), "../../dist/cli.js");

test("parseTimeout accepts duration and seconds", () => {
  assert.equal(parseTimeout(undefined), 30 * 60 * 1000);
  assert.equal(parseTimeout("90s"), 90_000);
  assert.equal(parseTimeout("2m"), 120_000);
  assert.equal(parseTimeout("1h"), 3_600_000);
  assert.equal(parseTimeout("15"), 15_000);
});

test("unknown flag and missing cwd fail fast", () => {
  const unknown = spawnSync(process.execPath, [cli, "run", "--cwd", "/tmp", "--prompt", "x", "--cheap"], {
    encoding: "utf8",
  });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown flag --cheap/);

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
