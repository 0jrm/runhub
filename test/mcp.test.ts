import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { callTool, handleRpc, listTools, TOOL_NAMES } from "../src/mcp.js";

const mcp = join(dirname(fileURLToPath(import.meta.url)), "../../dist/mcp.js");

test("MCP tool list is run run_and_wait wait list status report inspect and omits merge", async () => {
  assert.deepEqual(
    listTools().map((t) => t.name),
    ["run", "run_and_wait", "wait", "list", "status", "report", "inspect"],
  );
  assert.deepEqual([...TOOL_NAMES], ["run", "run_and_wait", "wait", "list", "status", "report", "inspect"]);

  const listed = await handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.ok(listed?.result);
  const tools = (listed.result as { tools: { name: string }[] }).tools.map((t) => t.name);
  assert.deepEqual(tools, ["run", "run_and_wait", "wait", "list", "status", "report", "inspect"]);
  assert.ok(!tools.includes("merge"));

  const merge = await callTool("merge", {});
  assert.equal(merge.isError, true);
  assert.match(merge.content[0]?.text ?? "", /unknown tool: merge/);
});

test("MCP run refuses a cwd that is not in projects.toml", async () => {
  const cfg = mkdtempSync(join(tmpdir(), "runhub-mcp-cfg-"));
  const missingPath = join(tmpdir(), "no-such-runhub-mcp-dir");
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = cfg;
  try {
    const result = await callTool("run", { cwd: missingPath, prompt: "x" });
    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.text, `not in projects.toml: ${resolve(missingPath)}\n`);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test("stdio MCP initialize then tools/list", () => {
  const r = spawnSync(process.execPath, [mcp], {
    encoding: "utf8",
    input:
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
          },
        }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      ].join("\n") + "\n",
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { id?: number; result?: { tools?: { name: string }[] } });
  assert.equal(lines.length, 2);
  const names = lines[1]?.result?.tools?.map((t) => t.name) ?? [];
  assert.deepEqual(names, ["run", "run_and_wait", "wait", "list", "status", "report", "inspect"]);
});
