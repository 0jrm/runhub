#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTailKind } from "./inspect.js";
import { NotInProjectsError } from "./projects.js";
import { listRun, reportRun, startRun, statusRun, waitRun, inspectRun, type CmdResult } from "./commands.js";

export const MCP_PROTOCOL = "2024-11-05";
export const TOOL_NAMES = ["run", "wait", "list", "status", "report", "inspect"] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type ToolContent = { content: { type: "text"; text: string }[]; isError?: boolean };

const TOOLS: {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}[] = [
  {
    name: "run",
    description:
      "Start a runhub pipeline in a projects.toml cwd. Same as `runhub run`. Returns `runhub: <runId>` and returns immediately.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["cwd"],
      properties: {
        cwd: { type: "string", description: "Project table name or allowed filesystem path from projects.toml" },
        prompt: { type: "string", description: "Spec text. Required unless prompt_file is set. Not stdin." },
        prompt_file: { type: "string", description: "Read the spec from this file instead of prompt" },
        agent: { type: "string", description: "cursor or claude" },
        model: { type: "string" },
        review: { type: "string", description: "claude or none" },
        timeout: { type: "string", description: "Agent timeout, e.g. 30m" },
        test_cmd: { type: "string" },
        no_preamble: { type: "boolean" },
      },
    },
  },
  {
    name: "wait",
    description: "Wait for a run and print its report. Same as `runhub wait`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        run_id: { type: "string" },
        timeout: { type: "string", description: "Wait timeout, default 10m" },
      },
    },
  },
  {
    name: "list",
    description: "List stored runs. Same as `runhub list`.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "status",
    description: "Print status of a run. Same as `runhub status`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { run_id: { type: "string" } },
    },
  },
  {
    name: "report",
    description: "Print the stored report. Same as `runhub report`.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { run_id: { type: "string" } },
    },
  },
  {
    name: "inspect",
    description:
      "Read a run directory: session links and log tails. Same as `runhub inspect`. Defaults to the latest running run, else the most recent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        run_id: { type: "string" },
        n: { type: "number", description: "Tail line count" },
        tail: { type: "string", description: "agent, review, verify, or all" },
        links_only: { type: "boolean" },
        no_tail: { type: "boolean" },
        json: { type: "boolean" },
      },
    },
  },
];

export function listTools(): { name: string }[] {
  return TOOLS.map((t) => ({ name: t.name }));
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("params must be an object");
  }
  return value as Record<string, unknown>;
}

function str(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Error(`${key} must be a string`);
  return v;
}

function num(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${key} must be a number`);
  return v;
}

function bool(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new Error(`${key} must be a boolean`);
  return v;
}

function promptFromArgs(args: Record<string, unknown>): string {
  const prompt = str(args, "prompt");
  const promptFile = str(args, "prompt_file");
  if (prompt !== undefined && promptFile !== undefined) {
    throw new Error("pass either prompt or prompt_file, not both");
  }
  if (promptFile !== undefined) return readFileSync(promptFile, "utf8");
  if (prompt === undefined) throw new Error("run requires prompt or prompt_file");
  if (prompt === "-") throw new Error("MCP run does not read the prompt from stdin; pass prompt or prompt_file");
  return prompt;
}

function toToolContent(result: CmdResult): ToolContent {
  const text = `${result.stdout}${result.stderr}`;
  const out: ToolContent = { content: [{ type: "text", text }] };
  if (result.code !== 0 && result.code !== 3) out.isError = true;
  return out;
}

function failContent(err: unknown): ToolContent {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `${message}\n` }], isError: true };
}

export async function callTool(name: string, rawArgs: unknown): Promise<ToolContent> {
  try {
    if (name === "run") {
      const args = asObject(rawArgs);
      const cwd = str(args, "cwd");
      if (cwd === undefined) throw new Error("run requires cwd");
      return toToolContent(
        startRun({
          cwd,
          prompt: promptFromArgs(args),
          timeout: str(args, "timeout"),
          testCmd: str(args, "test_cmd"),
          agent: str(args, "agent"),
          model: str(args, "model"),
          review: str(args, "review"),
          noPreamble: bool(args, "no_preamble") === true,
        }),
      );
    }
    if (name === "wait") {
      const args = asObject(rawArgs);
      return toToolContent(await waitRun(str(args, "run_id"), str(args, "timeout")));
    }
    if (name === "list") return toToolContent(listRun());
    if (name === "status") return toToolContent(statusRun(str(asObject(rawArgs), "run_id")));
    if (name === "report") return toToolContent(reportRun(str(asObject(rawArgs), "run_id")));
    if (name === "inspect") {
      const args = asObject(rawArgs);
      const n = num(args, "n");
      return toToolContent(
        inspectRun({
          runId: str(args, "run_id"),
          ...(n === undefined ? {} : { n }),
          tail: parseTailKind(str(args, "tail")),
          linksOnly: bool(args, "links_only") === true,
          noTail: bool(args, "no_tail") === true,
          json: bool(args, "json") === true,
        }),
      );
    }
    return failContent(new Error(`unknown tool: ${name}`));
  } catch (err) {
    if (err instanceof NotInProjectsError) return failContent(err);
    return failContent(err);
  }
}

function initializeResult(params: unknown): unknown {
  const obj = asObject(params);
  const requested = obj.protocolVersion;
  const protocolVersion = typeof requested === "string" && requested.startsWith("20") ? requested : MCP_PROTOCOL;
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: "runhub", version: "0.3.1" },
  };
}

export async function handleRpc(msg: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
  const id = msg.id ?? null;
  const method = msg.method;
  if (method === undefined) {
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } };
  }
  if (msg.id === undefined && method.startsWith("notifications/")) return undefined;
  try {
    if (method === "initialize") {
      return { jsonrpc: "2.0", id, result: initializeResult(msg.params) };
    }
    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    }
    if (method === "tools/call") {
      const params = asObject(msg.params);
      const name = str(params, "name");
      if (name === undefined) throw new Error("tools/call requires name");
      const result = await callTool(name, params.arguments);
      return { jsonrpc: "2.0", id, result };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { jsonrpc: "2.0", id, error: { code: -32602, message } };
  }
}

export async function handleLine(line: string): Promise<JsonRpcResponse | undefined> {
  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
  }
  return handleRpc(msg);
}

export async function serveStdio(): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    const response = await handleLine(line);
    if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

const entry = process.argv[1];
if (entry !== undefined) {
  let self = false;
  try {
    self = realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    self = fileURLToPath(import.meta.url) === resolve(entry);
  }
  if (self) {
    serveStdio().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    });
  }
}
