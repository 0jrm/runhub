import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SPAWN_MAX_BUFFER } from "../src/domain.js";
import { detectTestCmd } from "../src/verify.js";

test("spawnSync maxBuffer is 64 MB", () => {
  assert.equal(SPAWN_MAX_BUFFER, 64 * 1024 * 1024);
});

test("detectTestCmd requires scripts.test or a Makefile test target", () => {
  const root = mkdtempSync(join(tmpdir(), "runhub-detect-"));
  assert.equal(detectTestCmd(root), undefined);
  writeFileSync(join(root, "package.json"), "{}\n");
  assert.equal(detectTestCmd(root), undefined);
  writeFileSync(join(root, "package.json"), '{"scripts":{"lint":"x"}}\n');
  assert.equal(detectTestCmd(root), undefined);
  writeFileSync(join(root, "Makefile"), "all:\n\ttrue\n");
  assert.equal(detectTestCmd(root), undefined);
  writeFileSync(join(root, "Makefile"), "test:\n\ttrue\n");
  assert.equal(detectTestCmd(root), "make test");
  writeFileSync(join(root, "package.json"), '{"scripts":{"test":"node --test"}}\n');
  assert.equal(detectTestCmd(root), "npm test");
  assert.equal(detectTestCmd(root, "pytest -q"), "pytest -q");
});
