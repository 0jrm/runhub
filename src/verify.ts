import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { TEST_TAIL_BYTES, TEST_TIMEOUT_MS, tailBytes, type DiffRange, type VerifyResult } from "./domain.js";
import { diffStatText } from "./git.js";
import { runProcessGroup } from "./adapters.js";

export type DetectedTest = { cmd: string; cwd: string };

export function detectTestCmd(cwd: string, override?: string): DetectedTest | undefined {
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
  if (pytestDir !== undefined) return { cmd: "pytest", cwd: pytestDir };
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

export async function runVerify(opts: {
  cwd: string;
  range: DiffRange;
  testOutPath: string;
  testCmdOverride?: string;
  signal?: AbortSignal;
}): Promise<VerifyResult> {
  const baseSha = opts.range.from;
  const diffStat = diffStatText(opts.cwd, opts.range);
  const detected = detectTestCmd(opts.cwd, opts.testCmdOverride);
  if (detected === undefined) {
    return { baseSha, diffStat, testTail: "no test command" };
  }
  if (opts.signal?.aborted) {
    return { baseSha, diffStat, testCmd: detected.cmd, testExit: 130, testTail: "aborted" };
  }
  const errPath = `${opts.testOutPath}.err`;
  const result = await runProcessGroup({
    argv: ["sh", "-c", detected.cmd],
    cwd: detected.cwd,
    stdoutPath: opts.testOutPath,
    stderrPath: errPath,
    timeoutMs: TEST_TIMEOUT_MS,
    signal: opts.signal,
  });
  const out = existsSync(opts.testOutPath) ? readFileSync(opts.testOutPath, "utf8") : "";
  const err = existsSync(errPath) ? readFileSync(errPath, "utf8") : "";
  const combined = `${out}${err}`;
  const testExit = result.aborted ? 130 : result.timedOut ? 124 : (result.code ?? 1);
  return {
    baseSha,
    diffStat,
    testCmd: detected.cmd,
    testExit,
    testTail: tailBytes(combined, TEST_TAIL_BYTES).text,
  };
}
