import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { TEST_TAIL_BYTES, TEST_TIMEOUT_MS, tailBytes, type VerifyResult } from "./domain.js";

const DETECT: { marker: string; cmd: string }[] = [
  { marker: "package.json", cmd: "npm test" },
  { marker: "pyproject.toml", cmd: "pytest" },
  { marker: "pytest.ini", cmd: "pytest" },
  { marker: "Makefile", cmd: "make test" },
];

export function detectTestCmd(cwd: string, override?: string): string | undefined {
  if (override !== undefined && override.length > 0) return override;
  for (const row of DETECT) {
    if (existsSync(join(cwd, row.marker))) return row.cmd;
  }
  return undefined;
}

function gitText(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return text.trimEnd();
}

export function runVerify(cwd: string, testCmdOverride?: string): VerifyResult {
  const porcelain = gitText(cwd, ["status", "--porcelain"]);
  const diffStat = gitText(cwd, ["diff", "--stat", "HEAD"]);
  const testCmd = detectTestCmd(cwd, testCmdOverride);
  if (testCmd === undefined) {
    return { porcelain, diffStat, testTail: "no test command" };
  }
  const r = spawnSync("sh", ["-c", testCmd], {
    cwd,
    encoding: "utf8",
    timeout: TEST_TIMEOUT_MS,
    env: process.env,
  });
  const combined = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const timedOut = r.error?.name === "Error" && /TIMEDOUT/i.test(r.error.message);
  const testExit = timedOut ? 124 : (r.status ?? 1);
  return {
    porcelain,
    diffStat,
    testCmd,
    testExit,
    testTail: tailBytes(combined, TEST_TAIL_BYTES).text,
  };
}
