import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ParseError } from "../src/domain.js";
import { addProjectPath, loadProjects, NotInProjectsError, parseProjects, resolveRunCwd } from "../src/projects.js";
import { gitRepo, tempDir } from "./helpers.js";

test("parseProjects reads tables, quoted test, comments, and blanks", () => {
  const projects = parseProjects(`
# a comment

[hycom]
path = /tmp/hycom
test = "cd packages/markitdown && hatch test"

[runhub]
path = "/tmp/runhub"
`);
  assert.deepEqual(projects, [
    { name: "hycom", path: "/tmp/hycom", test: "cd packages/markitdown && hatch test" },
    { name: "runhub", path: "/tmp/runhub" },
  ]);
});

test("parseProjects reads typecheck, lint, and remote keys", () => {
  const projects = parseProjects(`[hycom]
path = /tmp/hycom
test = true
typecheck = mypy
lint = "ruff check"
remote = origin
`);
  assert.deepEqual(projects, [
    {
      name: "hycom",
      path: "/tmp/hycom",
      test: "true",
      typecheck: "mypy",
      lint: "ruff check",
      remote: "origin",
    },
  ]);
});

test("parseProjects reads a preamble path", () => {
  const projects = parseProjects(`[hycom]
path = /tmp/hycom
preamble = /tmp/hycom/PREAMBLE.md
`);
  assert.deepEqual(projects, [{ name: "hycom", path: "/tmp/hycom", preamble: "/tmp/hycom/PREAMBLE.md" }]);
});

test("parseProjects throws on a table with no path or on garbage", () => {
  assert.throws(() => parseProjects("[hycom]\ntest = true\n"), ParseError);
  assert.throws(() => parseProjects("not a toml line\n"), ParseError);
  assert.throws(() => parseProjects("path = /tmp/x\n"), ParseError);
  assert.throws(() => parseProjects('[hycom]\npath = "/tmp/x\n'), ParseError);
  assert.throws(() => parseProjects("[hycom]\npath = /tmp/a\n[hycom]\npath = /tmp/b\n"), ParseError);
});

test("loadProjects returns an empty list when the file is missing", () => {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(tempDir("cfg-missing"), "nope");
  try {
    assert.deepEqual(loadProjects(), []);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test("loadProjects reads projects.toml under XDG_CONFIG_HOME", () => {
  const prev = process.env.XDG_CONFIG_HOME;
  const xdg = tempDir("cfg-present");
  mkdirSync(join(xdg, "runhub"), { recursive: true });
  writeFileSync(join(xdg, "runhub", "projects.toml"), "[toy]\npath = /tmp/toy\ntest = true\n");
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    assert.deepEqual(loadProjects(), [{ name: "toy", path: "/tmp/toy", test: "true" }]);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test("resolveRunCwd matches a project name or a listed path, and refuses anything else", () => {
  const dir = tempDir("proj-cwd");
  const parent = tempDir("proj-linkp");
  const link = join(parent, "link");
  symlinkSync(dir, link);
  const projects = [{ name: "toy", path: dir, test: "true" }];
  assert.deepEqual(resolveRunCwd("toy", projects), { cwd: resolve(dir), test: "true" });
  assert.deepEqual(resolveRunCwd(dir, projects), { cwd: resolve(dir), test: "true" });
  assert.deepEqual(resolveRunCwd(link, projects), { cwd: resolve(link), test: "true" });
  const other = resolve("other");
  assert.throws(
    () => resolveRunCwd("other", projects),
    (err: unknown) => err instanceof NotInProjectsError && err.message === `not in projects.toml: ${other}`,
  );
  assert.throws(
    () => resolveRunCwd(dir, []),
    (err: unknown) => err instanceof NotInProjectsError && err.message === `not in projects.toml: ${resolve(dir)}`,
  );
  assert.deepEqual(resolveRunCwd("toy", [{ name: "toy", path: dir }]), { cwd: resolve(dir) });
  assert.deepEqual(resolveRunCwd("toy", [{ name: "toy", path: dir, typecheck: "mypy", lint: "ruff check", remote: "origin" }]), {
    cwd: resolve(dir),
    typecheck: "mypy",
    lint: "ruff check",
    remote: "origin",
  });
});

test("addProjectPath appends a table and skips the same path", () => {
  const prev = process.env.XDG_CONFIG_HOME;
  const xdg = tempDir("cfg-add");
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const repo = tempDir("proj-add-repo");
    gitRepo(repo);
    const first = addProjectPath(repo);
    assert.equal(first.added, true);
    assert.deepEqual(loadProjects().map((p) => p.path), [repo]);
    const second = addProjectPath(repo);
    assert.equal(second.added, false);
    assert.equal(second.name, first.name);
    assert.equal(loadProjects().length, 1);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});
