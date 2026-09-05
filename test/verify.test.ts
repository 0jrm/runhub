import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("detectTestCmd finds pytest from pyproject, deps, or a tests/ dir", () => {
  const root = mkdtempSync(join(tmpdir(), "runhub-py-"));
  assert.equal(detectTestCmd(root), undefined);
  writeFileSync(join(root, "pyproject.toml"), "[project]\nname = \"x\"\n");
  assert.equal(detectTestCmd(root), undefined);
  writeFileSync(join(root, "pyproject.toml"), "[tool.pytest.ini_options]\n");
  assert.equal(detectTestCmd(root), "pytest");
  writeFileSync(join(root, "pyproject.toml"), "dependencies = [\"pytest\"]\n");
  assert.equal(detectTestCmd(root), "pytest");
  writeFileSync(join(root, "pyproject.toml"), "[project]\nname = \"x\"\n");
  mkdirSync(join(root, "tests"));
  assert.equal(detectTestCmd(root), "pytest");
});

test("detectTestCmd reads markitdown's pyproject and finds pytest from the git root", () => {
  const pkg = "/home/jrm22n/markitdown/packages/markitdown";
  const py = join(pkg, "pyproject.toml");
  assert.equal(existsSync(py), true, "markitdown pyproject must exist for this test");
  const isolated = mkdtempSync(join(tmpdir(), "runhub-mdpy-"));
  writeFileSync(join(isolated, "pyproject.toml"), readFileSync(py, "utf8"));
  assert.equal(detectTestCmd(isolated), undefined);
  mkdirSync(join(isolated, "tests"));
  assert.equal(detectTestCmd(isolated), "pytest");
  assert.equal(detectTestCmd(pkg), "pytest");
  assert.equal(detectTestCmd("/home/jrm22n/markitdown"), "pytest");
});
