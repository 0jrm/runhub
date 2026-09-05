import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { assertNever, type AgentKind } from "./domain.js";

export type SpawnResult = {
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
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

export function resolveAgentBin(agent: AgentKind): string | undefined {
  switch (agent) {
    case "cursor":
      return findOnPath(["cursor-agent", "agent"]);
    case "claude":
      return findOnPath(["claude"]);
    default:
      return assertNever(agent);
  }
}

export function agentArgv(opts: { agent: AgentKind; bin: string; cwd: string; model: string }): string[] {
  switch (opts.agent) {
    case "cursor":
      return [
        opts.bin,
        "-p",
        "--trust",
        "--output-format",
        "stream-json",
        "--model",
        opts.model,
        "--workspace",
        opts.cwd,
        "--force",
      ];
    case "claude":
      return [
        opts.bin,
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--model",
        opts.model,
        "--dangerously-skip-permissions",
      ];
    default:
      return assertNever(opts.agent);
  }
}

export function reviewArgv(bin: string, model: string): string[] {
  return [bin, "-p", "--output-format", "text", "--model", model, "--dangerously-skip-permissions"];
}

export function runProcessGroup(opts: {
  argv: string[];
  cwd: string;
  stdinPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<SpawnResult> {
  const [file, ...args] = opts.argv;
  if (file === undefined) {
    return Promise.resolve({ code: 127, timedOut: false, aborted: false });
  }

  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: process.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pid = child.pid;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, timedOut, aborted });
    };

    const killGroup = (signal: NodeJS.Signals) => {
      if (pid === undefined) return;
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          return;
        }
      }
    };

    const onAbort = () => {
      aborted = true;
      killGroup("SIGTERM");
      setTimeout(() => {
        if (!settled) killGroup("SIGKILL");
      }, 400).unref();
    };

    if (opts.signal?.aborted) {
      onAbort();
    } else {
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    }

    if (opts.stdinPath !== undefined && child.stdin) {
      const inn = createReadStream(opts.stdinPath);
      inn.pipe(child.stdin);
      inn.on("error", () => {
        child.stdin?.end();
      });
    } else {
      child.stdin?.end();
    }

    if (opts.stdoutPath !== undefined && child.stdout) {
      const out = createWriteStream(opts.stdoutPath);
      child.stdout.pipe(out);
    } else {
      child.stdout?.resume();
    }

    if (opts.stderrPath !== undefined && child.stderr) {
      const err = createWriteStream(opts.stderrPath);
      child.stderr.pipe(err);
    } else {
      child.stderr?.resume();
    }

    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code));

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => {
        if (!settled) killGroup("SIGKILL");
      }, 400).unref();
    }, opts.timeoutMs);
  });
}
