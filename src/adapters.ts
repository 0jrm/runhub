import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { CURSOR_MODEL, stripYoloFlags, yoloFlagsForCursor } from "./domain.js";

export type SpawnResult = {
  code: number | null;
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

export function resolveAgentBin(): string | undefined {
  return findOnPath(["cursor-agent", "agent"]);
}

export function agentArgv(bin: string, cwd: string): string[] {
  return stripYoloFlags([
    bin,
    "-p",
    "--trust",
    "--output-format",
    "stream-json",
    "--model",
    CURSOR_MODEL,
    "--workspace",
    cwd,
    ...yoloFlagsForCursor(),
  ]);
}

export function runProcessGroup(opts: {
  argv: string[];
  cwd: string;
  stdinPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
  timeoutMs: number;
}): Promise<SpawnResult> {
  const argv = stripYoloFlags(opts.argv);
  const [file, ...args] = argv;
  if (file === undefined) {
    return Promise.resolve({ code: 127, timedOut: false });
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
    let settled = false;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      resolve({ code, timedOut });
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

    const onSignal = () => {
      killGroup("SIGTERM");
      setTimeout(() => {
        if (!settled) killGroup("SIGKILL");
      }, 400).unref();
    };

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

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
