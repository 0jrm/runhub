import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SPAWN_MAX_BUFFER } from "../src/domain.js";
import { detectLintCmd, detectTestCmd, detectTypecheckCmd, runVerify } from "../src/verify.js";
import { gitRepo, headSha, restrictedPath, tempDir, withEnv, writeBin } from "./helpers.js";

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
  assert.deepEqual(detectTestCmd(root), { cmd: "make test", cwd: root });
  writeFileSync(join(root, "package.json"), '{"scripts":{"test":"node --test"}}\n');
  assert.deepEqual(detectTestCmd(root), { cmd: "npm test", cwd: root });
  assert.deepEqual(detectTestCmd(root, "pytest -q"), { cmd: "pytest -q", cwd: root });
});

test("detectTypecheckCmd and detectLintCmd read package.json and pyproject", () => {
  const root = mkdtempSync(join(tmpdir(), "runhub-checks-"));
  assert.equal(detectTypecheckCmd(root), undefined);
  writeFileSync(join(root, "package.json"), '{"scripts":{"typecheck":"tsc","lint":"eslint ."}}\n');
  assert.deepEqual(detectTypecheckCmd(root), { cmd: "npm run typecheck", cwd: root });
  assert.deepEqual(detectLintCmd(root), { cmd: "npm run lint", cwd: root });
  writeFileSync(join(root, "pyproject.toml"), "[tool.mypy]\n[tool.ruff]\n");
  const py = mkdtempSync(join(tmpdir(), "runhub-pycheck-"));
  writeFileSync(join(py, "pyproject.toml"), "[tool.mypy]\n[tool.ruff]\n");
  assert.deepEqual(detectTypecheckCmd(py), { cmd: "mypy", cwd: py });
  assert.deepEqual(detectLintCmd(py), { cmd: "ruff check", cwd: py });
});

test("detectTestCmd finds pytest from pyproject, deps, or a tests/ dir", () => {
  const prev = process.env.PATH;
  process.env.PATH = tempDir("nopy");
  try {
    const root = mkdtempSync(join(tmpdir(), "runhub-py-"));
    assert.equal(detectTestCmd(root), undefined);
    writeFileSync(join(root, "pyproject.toml"), "[project]\nname = \"x\"\n");
    assert.equal(detectTestCmd(root), undefined);
    writeFileSync(join(root, "pyproject.toml"), "[tool.pytest.ini_options]\n");
    assert.deepEqual(detectTestCmd(root), { cmd: "pytest", cwd: root });
    writeFileSync(join(root, "pyproject.toml"), "dependencies = [\"pytest\"]\n");
    assert.deepEqual(detectTestCmd(root), { cmd: "pytest", cwd: root });
    writeFileSync(join(root, "pyproject.toml"), "[project]\nname = \"x\"\n");
    mkdirSync(join(root, "tests"));
    assert.deepEqual(detectTestCmd(root), { cmd: "pytest", cwd: root });
  } finally {
    process.env.PATH = prev;
  }
});

test("detectTestCmd uses packages/markitdown as cwd from a git-root pyproject layout", () => {
  const prev = process.env.PATH;
  process.env.PATH = tempDir("nopy");
  try {
    const root = mkdtempSync(join(tmpdir(), "runhub-mdpy-"));
    const pkg = join(root, "packages", "markitdown");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "pyproject.toml"), "[project]\nname = \"markitdown\"\n");
    assert.equal(detectTestCmd(root), undefined);
    mkdirSync(join(pkg, "tests"));
    assert.deepEqual(detectTestCmd(root), { cmd: "pytest", cwd: pkg });
    writeFileSync(join(pkg, "pyproject.toml"), "[tool.pytest.ini_options]\n");
    assert.deepEqual(detectTestCmd(pkg), { cmd: "pytest", cwd: pkg });
  } finally {
    process.env.PATH = prev;
  }
});

test("detectTestCmd uses packages/x as cwd when git root has no manifest", () => {
  const prev = process.env.PATH;
  process.env.PATH = tempDir("nopy");
  try {
    const root = mkdtempSync(join(tmpdir(), "runhub-mono-"));
    const pkg = join(root, "packages", "x");
    mkdirSync(join(pkg, "tests"), { recursive: true });
    writeFileSync(join(pkg, "pyproject.toml"), "[project]\nname = \"x\"\n");
    assert.deepEqual(detectTestCmd(root), { cmd: "pytest", cwd: pkg });
  } finally {
    process.env.PATH = prev;
  }
});

test("detectTestCmd prefers an executable searchRoot .venv pytest", () => {
  const root = mkdtempSync(join(tmpdir(), "runhub-venv-"));
  const pkg = join(root, "packages", "x");
  mkdirSync(join(pkg, "tests"), { recursive: true });
  writeFileSync(join(pkg, "pyproject.toml"), "[project]\nname = \"x\"\n");
  const venvBin = join(root, ".venv", "bin");
  mkdirSync(venvBin, { recursive: true });
  const pytest = writeBin(venvBin, "pytest", "#!/bin/sh\nexit 0\n");
  assert.deepEqual(detectTestCmd(root), { cmd: pytest, cwd: pkg });
});

test("detectTestCmd falls back to pytest when no venv pytest and no importable pytest", () => {
  const prev = process.env.PATH;
  process.env.PATH = tempDir("nopy");
  try {
    const root = mkdtempSync(join(tmpdir(), "runhub-nofall-"));
    const pkg = join(root, "packages", "x");
    mkdirSync(join(pkg, "tests"), { recursive: true });
    writeFileSync(join(pkg, "pyproject.toml"), "[project]\nname = \"x\"\n");
    assert.deepEqual(detectTestCmd(root), { cmd: "pytest", cwd: pkg });
  } finally {
    process.env.PATH = prev;
  }
});

test("runVerify runs pytest with the pyproject directory as cwd", async () => {
  const root = tempDir("pytest-cwd");
  const pkg = join(root, "packages", "x");
  gitRepo(root, [
    { path: "packages/x/pyproject.toml", body: "[project]\nname = \"x\"\n" },
    { path: "packages/x/tests/test_ok.py", body: "def test_ok():\n    assert True\n" },
  ]);
  const sha = headSha(root);
  await withEnv(async () => {
    const binDir = restrictedPath(["sh", "git"]);
    writeBin(binDir, "pytest", "#!/bin/sh\npwd > ran-from.txt\nexit 0\n");
    process.env.PATH = binDir;
    const verify = await runVerify({
      cwd: root,
      range: { from: sha, to: sha },
      testOutPath: join(root, "verify.out"),
    });
    assert.equal(verify.testCmd, "pytest");
    assert.equal(verify.testExit, 0);
    assert.equal(readFileSync(join(pkg, "ran-from.txt"), "utf8").trim(), pkg);
  });
});

test("runVerify records 126 or 127 when the detected command is not on PATH", async () => {
  const root = tempDir("pytest-missing");
  gitRepo(root, [
    { path: "packages/x/pyproject.toml", body: "[project]\nname = \"x\"\n" },
    { path: "packages/x/tests/test_ok.py", body: "def test_ok():\n    assert True\n" },
  ]);
  const sha = headSha(root);
  await withEnv(async () => {
    process.env.PATH = restrictedPath(["sh", "git"]);
    const verify = await runVerify({
      cwd: root,
      range: { from: sha, to: sha },
      testOutPath: join(root, "verify.out"),
    });
    assert.equal(verify.testCmd, "pytest");
    assert.ok(verify.testExit === 126 || verify.testExit === 127, `expected 126 or 127, got ${verify.testExit}`);
  });
});
