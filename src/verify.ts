import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { TEST_TAIL_BYTES, TEST_TIMEOUT_MS, tailBytes, type DiffRange, type VerifyResult } from "./domain.js";
import { diffStatText } from "./git.js";
import { runProcessGroup } from "./adapters.js";

export function detectTestCmd(cwd: string, override?: string): string | undefined {
  if (override !== undefined && override.length > 0) return override;
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (typeof raw === "object" && raw !== null) {
        const scripts = (raw as { scripts?: unknown }).scripts;
        if (typeof scripts === "object" && scripts !== null) {
          const test = (scripts as { test?: unknown }).test;
          if (typeof test === "string" && test.trim().length > 0) return "npm test";
        }
      }
    } catch {}
  }
  const makePath = join(cwd, "Makefile");
  if (existsSync(makePath)) {
    const text = readFileSync(makePath, "utf8");
    if (/^test\s*:/m.test(text)) return "make test";
  }
  if (findPytest(cwd)) return "pytest";
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

function findPytest(cwd: string): boolean {
  if (hasPytest(cwd)) return true;
  let names: string[] = [];
  try {
    names = readdirSync(cwd);
  } catch {
    return false;
  }
  for (const name of names) {
    if (SKIP_WALK.has(name)) continue;
    const child = join(cwd, name);
    try {
      if (!statSync(child).isDirectory()) continue;
    } catch {
      continue;
    }
    if (hasPytest(child)) return true;
    if (name !== "packages") continue;
    let pkgs: string[] = [];
    try {
      pkgs = readdirSync(child);
    } catch {
      continue;
    }
    for (const pkg of pkgs) {
      if (hasPytest(join(child, pkg))) return true;
    }
  }
  return false;
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
  const testCmd = detectTestCmd(opts.cwd, opts.testCmdOverride);
  if (testCmd === undefined) {
    return { baseSha, diffStat, testTail: "no test command" };
  }
  if (opts.signal?.aborted) {
    return { baseSha, diffStat, testCmd, testExit: 130, testTail: "aborted" };
  }
  const errPath = `${opts.testOutPath}.err`;
  const result = await runProcessGroup({
    argv: ["sh", "-c", testCmd],
    cwd: opts.cwd,
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
    testCmd,
    testExit,
    testTail: tailBytes(combined, TEST_TAIL_BYTES).text,
  };
}
