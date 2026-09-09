import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { ParseError } from "./domain.js";

export class NotInProjectsError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`not in projects.toml: ${path}`);
    this.name = "NotInProjectsError";
    this.path = path;
  }
}

export type Project = {
  name: string;
  path: string;
  test?: string;
  typecheck?: string;
  lint?: string;
  remote?: string;
  preamble?: string;
};

export function runhubConfigDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "runhub");
}

export function projectsTomlPath(): string {
  return join(runhubConfigDir(), "projects.toml");
}

export function projectTableName(projectPath: string): string {
  const raw = basename(resolve(projectPath));
  const name = raw.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  if (name.length === 0) throw new Error(`cannot derive a projects.toml table name from ${projectPath}`);
  return name;
}

function quoteTomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Append a git repo path to projects.toml. Idempotent if the same path is already listed. */
export function addProjectPath(raw: string): { name: string; path: string; added: boolean } {
  const cwd = resolve(raw);
  const name = projectTableName(cwd);
  const projects = loadProjects();
  const samePath = projects.find((p) => pathsEqual(cwd, resolve(p.path)));
  if (samePath !== undefined) {
    return { name: samePath.name, path: resolve(samePath.path), added: false };
  }
  const sameName = projects.find((p) => p.name === name);
  if (sameName !== undefined) {
    throw new Error(`[${name}] already exists at ${sameName.path}`);
  }
  mkdirSync(runhubConfigDir(), { recursive: true, mode: 0o700 });
  const file = projectsTomlPath();
  const block = `[${name}]\npath = ${quoteTomlString(cwd)}\n`;
  const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
  const next = prev.length === 0 ? block : prev.endsWith("\n") ? `${prev}${block}` : `${prev}\n${block}`;
  writeFileSync(file, next);
  return { name, path: cwd, added: true };
}

export function loadProjects(): Project[] {
  const file = projectsTomlPath();
  if (!existsSync(file)) return [];
  return parseProjects(readFileSync(file, "utf8"));
}

export function parseProjects(text: string): Project[] {
  const projects: Project[] = [];
  let current: {
    name: string;
    path?: string;
    test?: string;
    typecheck?: string;
    lint?: string;
    remote?: string;
    preamble?: string;
  } | undefined;

  const flush = (): void => {
    if (current === undefined) return;
    const name = current.name;
    if (current.path === undefined || current.path.length === 0) {
      throw new ParseError(`project [${name}] is missing path`);
    }
    if (projects.some((p) => p.name === name)) {
      throw new ParseError(`duplicate project [${name}]`);
    }
    const project: Project = { name, path: current.path };
    if (current.test !== undefined && current.test.length > 0) project.test = current.test;
    if (current.typecheck !== undefined && current.typecheck.length > 0) {
      project.typecheck = current.typecheck;
    }
    if (current.lint !== undefined && current.lint.length > 0) project.lint = current.lint;
    if (current.remote !== undefined && current.remote.length > 0) project.remote = current.remote;
    if (current.preamble !== undefined && current.preamble.length > 0) project.preamble = current.preamble;
    projects.push(project);
    current = undefined;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("[")) {
      const close = trimmed.indexOf("]");
      if (close === -1) throw new ParseError(`unterminated table: ${trimmed}`);
      const after = trimmed.slice(close + 1).trim();
      if (after.length > 0 && !after.startsWith("#")) {
        throw new ParseError(`trailing garbage after table: ${trimmed}`);
      }
      flush();
      const name = trimmed.slice(1, close).trim();
      if (name.length === 0) throw new ParseError("empty table name");
      current = { name };
      continue;
    }

    const eq = trimmed.indexOf("=");
    if (eq === -1) throw new ParseError(`invalid line: ${trimmed}`);
    if (current === undefined) throw new ParseError(`key outside table: ${trimmed}`);
    const key = trimmed.slice(0, eq).trim();
    if (key.length === 0) throw new ParseError(`invalid line: ${trimmed}`);
    const value = parseTomlValue(trimmed.slice(eq + 1));
    if (key === "path") current.path = value;
    else if (key === "test") current.test = value;
    else if (key === "typecheck") current.typecheck = value;
    else if (key === "lint") current.lint = value;
    else if (key === "remote") current.remote = value;
    else if (key === "preamble") current.preamble = value;
  }
  flush();
  return projects;
}

export type ResolvedCwd = {
  cwd: string;
  test?: string;
  typecheck?: string;
  lint?: string;
  remote?: string;
  preamble?: string;
};

function withProjectCmds(cwd: string, project: Project): ResolvedCwd {
  const out: ResolvedCwd = { cwd };
  if (project.test !== undefined) out.test = project.test;
  if (project.typecheck !== undefined) out.typecheck = project.typecheck;
  if (project.lint !== undefined) out.lint = project.lint;
  if (project.remote !== undefined) out.remote = project.remote;
  if (project.preamble !== undefined) out.preamble = project.preamble;
  return out;
}

export function resolveRunCwd(raw: string, projects: readonly Project[]): ResolvedCwd {
  const named = projects.find((p) => p.name === raw);
  if (named !== undefined) return withProjectCmds(resolve(named.path), named);
  const cwd = resolve(raw);
  const matched = projects.find((p) => pathsEqual(cwd, resolve(p.path)));
  if (matched !== undefined) return withProjectCmds(cwd, matched);
  throw new NotInProjectsError(cwd);
}

function parseTomlValue(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    if (end === -1) throw new ParseError("unterminated quoted value");
    const after = s.slice(end + 1).trim();
    if (after.length > 0 && !after.startsWith("#")) {
      throw new ParseError("trailing garbage after quoted value");
    }
    return s.slice(1, end);
  }
  const token = s.match(/^([^\s#]+)/);
  if (token?.[1] === undefined) throw new ParseError("missing value");
  return token[1];
}

function pathsEqual(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}
