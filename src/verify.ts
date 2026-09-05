import { existsSync, readFileSync } from "node:fs";
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
