import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { findOnPath } from "./adapters.js";
import { CLAUDE_MODEL } from "./domain.js";
import { identityTomlPath } from "./git.js";
import { claudeModelResolves } from "./model.js";
import { addProjectPath, runhubConfigDir } from "./projects.js";

type CmdResult = { code: number; stdout: string; stderr: string };

export const DOCTOR_TOOLS = ["git", "gh", "cursor-agent", "claude"] as const;

export function identityExamplePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "identity.toml.example");
}

export type InitOpts = { yes?: boolean; identity?: boolean };

export function initRunhub(opts: InitOpts = {}): CmdResult {
  mkdirSync(runhubConfigDir(), { recursive: true, mode: 0o700 });
  const dest = identityTomlPath();
  const lines: string[] = [];
  if (!existsSync(dest)) {
    const example = identityExamplePath();
    if (!existsSync(example)) {
      throw new Error(`missing identity example: ${example}`);
    }
    copyFileSync(example, dest);
    chmodSync(dest, 0o600);
    lines.push(`wrote ${dest}`);
    lines.push("edit name and email in that file");
  } else {
    lines.push(`kept ${dest}`);
  }
  if (opts.identity !== true) {
    lines.push(`config ${runhubConfigDir()}`);
    lines.push("add a project: runhub add <path>");
    const doc = doctorRunhub();
    lines.push(doc.stdout.trimEnd());
  }
  return { code: 0, stdout: `${lines.filter((l) => l.length > 0).join("\n")}\n`, stderr: "" };
}

export function doctorRunhub(): CmdResult {
  const lines: string[] = [];
  let gitOk = false;
  for (const name of DOCTOR_TOOLS) {
    const found = findOnPath([name]);
    if (found !== undefined) {
      lines.push(`${name}: ok ${found}`);
      if (name === "git") gitOk = true;
    } else {
      lines.push(`${name}: missing`);
    }
  }
  const modelOk = claudeModelResolves(CLAUDE_MODEL);
  lines.push(`claude model ${CLAUDE_MODEL}: ${modelOk ? "ok" : "unrecognized"}`);
  return { code: gitOk ? 0 : 1, stdout: `${lines.join("\n")}\n`, stderr: "" };
}

function assertGitRepo(cwd: string): void {
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`not a directory: ${cwd}`);
  }
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0 || r.stdout.trim() !== "true") {
    throw new Error(`not a git repo: ${cwd}`);
  }
}

export function addProject(raw: string): CmdResult {
  assertGitRepo(raw);
  const result = addProjectPath(raw);
  if (result.added) {
    return { code: 0, stdout: `added [${result.name}] ${result.path}\n`, stderr: "" };
  }
  return { code: 0, stdout: `already listed: [${result.name}]\n`, stderr: "" };
}
