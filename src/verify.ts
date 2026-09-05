import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { TEST_TAIL_BYTES, TEST_TIMEOUT_MS, tailBytes, type DiffRange, type VerifyResult } from "./domain.js";
import { diffStatText } from "./git.js";
import { runProcessGroup } from "./adapters.js";

export type DetectedCmd = { cmd: string; cwd: string };

export function detectTestCmd(cwd: string, override?: string): DetectedCmd | undefined {
  if (override !== undefined && override.length > 0) return { cmd: override, cwd };
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (typeof raw === "object" && raw !== null) {
        const scripts = (raw as { scripts?: unknown }).scripts;
        if (typeof scripts === "object" && scripts !== null) {
          const test = (scripts as { test?: unknown }).test;
          if (typeof test === "string" && test.trim().length > 0) return { cmd: "npm test", cwd };
        }
      }
    } catch {}
  }
  const makePath = join(cwd, "Makefile");
  if (existsSync(makePath)) {
    const text = readFileSync(makePath, "utf8");
    if (/^test\s*:/m.test(text)) return { cmd: "make test", cwd };
  }
  const pytestDir = findPytest(cwd);
  if (pytestDir !== undefined) return { cmd: pytestCmd(cwd, pytestDir), cwd: pytestDir };
  return undefined;
}

const SKIP_WALK = new Set([".git", "node_modules", ".venv", "venv", "dist", "tree", ".tox", "target"]);

function hasPytest(dir: string): boolean {
  const pyPath = join(dir, "pyproject.toml");
  if (!existsSync(pyPath)) return false;
  let text = "";
  try {
    text = readFileSync(pyPath, "utf8");
  } catch {
    return false;
  }
  if (/^\[tool\.pytest/m.test(text)) return true;
  if (/\bpytest\b/.test(text)) return true;
  try {
    return statSync(join(dir, "tests")).isDirectory();
  } catch {
    return false;
  }
}

function listedDirs(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function venvPytest(dir: string): string | undefined {
  const path = join(dir, ".venv", "bin", "pytest");
  return isExecutableFile(path) ? path : undefined;
}

function pythonHasPytest(bin: string): boolean {
  const r = spawnSync(bin, ["-c", "import pytest"], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return r.status === 0;
}

function pytestCmd(searchRoot: string, pytestDir: string): string {
  const fromSearch = venvPytest(searchRoot);
  if (fromSearch !== undefined) return fromSearch;
  if (pytestDir !== searchRoot) {
    const fromPkg = venvPytest(pytestDir);
    if (fromPkg !== undefined) return fromPkg;
  }
  if (pythonHasPytest("python")) return "python -m pytest";
  if (pythonHasPytest("python3")) return "python3 -m pytest";
  return "pytest";
}

function findPytest(cwd: string): string | undefined {
  if (hasPytest(cwd)) return cwd;
  for (const name of listedDirs(cwd)) {
    if (SKIP_WALK.has(name)) continue;
    const child = join(cwd, name);
    try {
      if (!statSync(child).isDirectory()) continue;
    } catch {
      continue;
    }
    if (hasPytest(child)) return child;
    if (name !== "packages") continue;
    for (const pkg of listedDirs(child)) {
      const dir = join(child, pkg);
      if (hasPytest(dir)) return dir;
    }
  }
  return undefined;
}

function npmScript(cwd: string, name: "typecheck" | "lint"): DetectedCmd | undefined {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (typeof raw !== "object" || raw === null) return undefined;
    const scripts = (raw as { scripts?: unknown }).scripts;
    if (typeof scripts !== "object" || scripts === null) return undefined;
    const value = (scripts as Record<string, unknown>)[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return { cmd: `npm run ${name}`, cwd };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function tomlHasTable(dir: string, table: string): boolean {
  const pyPath = join(dir, "pyproject.toml");
  if (!existsSync(pyPath)) return false;
  try {
    return new RegExp(`^\\[tool\\.${table}\\]`, "m").test(readFileSync(pyPath, "utf8"));
  } catch {
    return false;
  }
}

function detectInTree(
  cwd: string,
  override: string | undefined,
  npmName: "typecheck" | "lint",
  toml: { table: string; cmd: string },
): DetectedCmd | undefined {
  if (override !== undefined && override.length > 0) return { cmd: override, cwd };
  const fromPkg = npmScript(cwd, npmName);
  if (fromPkg !== undefined) return fromPkg;
  if (tomlHasTable(cwd, toml.table)) return { cmd: toml.cmd, cwd };
  const pytestDir = findPytest(cwd);
  if (pytestDir !== undefined && pytestDir !== cwd && tomlHasTable(pytestDir, toml.table)) {
    return { cmd: toml.cmd, cwd: pytestDir };
  }
  return undefined;
}

export function detectTypecheckCmd(cwd: string, override?: string): DetectedCmd | undefined {
  return detectInTree(cwd, override, "typecheck", { table: "mypy", cmd: "mypy" });
}

export function detectLintCmd(cwd: string, override?: string): DetectedCmd | undefined {
  return detectInTree(cwd, override, "lint", { table: "ruff", cmd: "ruff check" });
}

async function runShellCmd(opts: {
  cmd: string;
  cwd: string;
  outPath: string;
  signal?: AbortSignal;
}): Promise<{ exit: number; tail: string }> {
  if (opts.signal?.aborted) return { exit: 130, tail: "aborted" };
  const errPath = `${opts.outPath}.err`;
  const result = await runProcessGroup({
    argv: ["sh", "-c", opts.cmd],
    cwd: opts.cwd,
    stdoutPath: opts.outPath,
    stderrPath: errPath,
    timeoutMs: TEST_TIMEOUT_MS,
    signal: opts.signal,
  });
  const out = existsSync(opts.outPath) ? readFileSync(opts.outPath, "utf8") : "";
  const err = existsSync(errPath) ? readFileSync(errPath, "utf8") : "";
  const exit = result.aborted ? 130 : result.timedOut ? 124 : (result.code ?? 1);
  return { exit, tail: tailBytes(`${out}${err}`, TEST_TAIL_BYTES).text };
}

export async function runVerify(opts: {
  cwd: string;
  range: DiffRange;
  testOutPath: string;
  testCmdOverride?: string;
  typecheckOverride?: string;
  lintOverride?: string;
  signal?: AbortSignal;
}): Promise<VerifyResult> {
  const baseSha = opts.range.from;
  const diffStat = diffStatText(opts.cwd, opts.range);
  const detected = detectTestCmd(opts.cwd, opts.testCmdOverride);
  const typecheck = detectTypecheckCmd(opts.cwd, opts.typecheckOverride);
  const lint = detectLintCmd(opts.cwd, opts.lintOverride);

  let result: VerifyResult = { baseSha, diffStat, testTail: "no test command" };
  if (detected !== undefined) {
    const ran = await runShellCmd({
      cmd: detected.cmd,
      cwd: detected.cwd,
      outPath: opts.testOutPath,
      signal: opts.signal,
    });
    result = {
      baseSha,
      diffStat,
      testCmd: detected.cmd,
      testExit: ran.exit,
      testTail: ran.tail,
    };
  }

  const dir = dirname(opts.testOutPath);
  if (typecheck !== undefined) {
    const ran = await runShellCmd({
      cmd: typecheck.cmd,
      cwd: typecheck.cwd,
      outPath: join(dir, "typecheck.out"),
      signal: opts.signal,
    });
    result = { ...result, typecheckCmd: typecheck.cmd, typecheckExit: ran.exit };
  }
  if (lint !== undefined) {
    const ran = await runShellCmd({
      cmd: lint.cmd,
      cwd: lint.cwd,
      outPath: join(dir, "lint.out"),
      signal: opts.signal,
    });
    result = { ...result, lintCmd: lint.cmd, lintExit: ran.exit };
  }
  return result;
}
