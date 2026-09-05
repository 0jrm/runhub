import assert from "node:assert/strict";
import { test } from "node:test";
import { agentArgv } from "../src/adapters.js";

test("cheap cursor uses ask mode and cheap claude uses one turn", () => {
  const cursor = agentArgv({
    provider: "cursor",
    bin: "cursor-agent",
    prompt: "pong",
    cwd: "/tmp",
    cheap: true,
  });
  assert.deepEqual(
    cursor.argv.slice(0, 8),
    ["cursor-agent", "-p", "--trust", "--output-format", "text", "--mode", "ask", "pong"],
  );
  const claude = agentArgv({
    provider: "claude",
    bin: "claude",
    prompt: "pong",
    cwd: "/tmp",
    cheap: true,
  });
  assert.ok(claude.argv.includes("--max-turns"));
  assert.equal(claude.argv[claude.argv.indexOf("--max-turns") + 1], "1");
  const grok = agentArgv({
    provider: "grok",
    bin: "grok",
    prompt: "pong",
    cwd: "/tmp",
    cheap: true,
  });
  assert.equal(grok.argv[1], "--single");
  assert.equal(grok.argv[2], "pong");
});
