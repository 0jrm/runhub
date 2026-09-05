import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import {
  QUOTA_TIMEOUT_MS,
  assertNever,
  stripYoloFlags,
  yoloFlagsFor,
  type Provider,
} from "./domain.js";

export type ProcResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export function findOnPath(names: readonly string[]): string | undefined {
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(delimiter);
  for (const name of names) {
    if (name.includes("/") || name.includes("\\")) continue;
    for (const dir of dirs) {
      if (dir.length === 0) continue;
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

export const BINS: Record<Provider, readonly string[]> = {
  cursor: ["cursor-agent", "agent"],
  claude: ["claude"],
  grok: ["grok"],
};

export function resolveBin(provider: Provider): string | undefined {
  return findOnPath(BINS[provider]);
}

export function runCaptured(opts: {
  argv: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<ProcResult> {
  const argv = stripYoloFlags(opts.argv);
  const [file, ...args] = argv;
  if (file === undefined) {
    return Promise.resolve({ code: 127, stdout: "", stderr: "empty argv", timedOut: false });
  }
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr, timedOut });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      stderr += err.message;
      finish(127);
    });
    child.on("close", (code) => finish(code));
    if (opts.timeoutMs !== undefined) {
      setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 400).unref();
      }, opts.timeoutMs);
    }
  });
}

export function probeArgv(provider: Provider, bin: string): string[][] {
  switch (provider) {
    case "cursor":
      return [[bin, "--list-models"]];
    case "claude":
      return [[bin, "--version"]];
    case "grok":
      return [
        [bin, "--version"],
        [bin, "version"],
      ];
    default:
      return assertNever(provider);
  }
}

export type AgentInvoke = {
  argv: string[];
  cwd: string;
};

export function agentArgv(opts: {
  provider: Provider;
  bin: string;
  prompt: string;
  cwd: string;
  cheap: boolean;
}): AgentInvoke {
  const extra = yoloFlagsFor(opts.provider);
  switch (opts.provider) {
    case "cursor":
      return {
        cwd: opts.cwd,
        argv: [
          opts.bin,
          "-p",
          "--trust",
          "--output-format",
          "text",
          ...(opts.cheap ? ["--mode", "ask"] : []),
          opts.prompt,
          "--workspace",
          opts.cwd,
          ...extra,
        ],
      };
    case "claude":
      return {
        cwd: opts.cwd,
        argv: [opts.bin, "-p", ...(opts.cheap ? ["--max-turns", "1"] : []), opts.prompt, ...extra],
      };
    case "grok":
      return {
        cwd: opts.cwd,
        argv: [
          opts.bin,
          "-p",
          "--single",
          opts.prompt,
          "--output-format",
          "json",
          "--cwd",
          opts.cwd,
          ...extra,
        ],
      };
    default:
      return assertNever(opts.provider);
  }
}

export function grokTextFallbackArgv(opts: { bin: string; prompt: string; cwd: string }): string[] {
  return [
    opts.bin,
    "-p",
    "--single",
    opts.prompt,
    "--output-format",
    "text",
    "--cwd",
    opts.cwd,
    ...yoloFlagsFor("grok"),
  ];
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function grokStdoutToText(stdout: string): string {
  try {
    const raw: unknown = JSON.parse(stdout);
    if (typeof raw === "string") return raw;
    if (isRecord(raw)) {
      for (const key of ["response", "text", "content", "message", "output"] as const) {
        const v = raw[key];
        if (typeof v === "string") return v;
      }
    }
  } catch {
    return stdout;
  }
  return stdout;
}

export { QUOTA_TIMEOUT_MS };
