import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CURSOR_MODEL } from "../src/domain.js";
import { agentArgv, runProcessGroup } from "../src/adapters.js";

test("agent argv pins Cursor Grok 4.6 medium and omits the prompt", () => {
  const argv = agentArgv("cursor-agent", "/tmp/app");
  assert.equal(argv.includes("--model"), true);
  assert.equal(argv[argv.indexOf("--model") + 1], CURSOR_MODEL);
  assert.equal(CURSOR_MODEL, "cursor-grok-4.6-medium");
  assert.equal(argv.includes("do the work"), false);
  assert.equal(argv.includes("-p"), true);
  assert.equal(argv.includes("stream-json"), true);
});

test("prompt arrives on stdin not argv", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runhub-argv-"));
  const bin = join(dir, "cursor-agent");
  const argvLog = join(dir, "argv.txt");
  const stdinLog = join(dir, "stdin.txt");
  writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\n' "$*" > "$1"
cat > "$2"
`,
  );
  chmodSync(bin, 0o755);
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "secret task text");
  const stdoutFile = join(dir, "out.txt");
  const result = await runProcessGroup({
    argv: [bin, argvLog, stdinLog, "--model", "cursor-grok-4.6-medium"],
    cwd: dir,
    stdinPath: promptFile,
    stdoutPath: stdoutFile,
    timeoutMs: 5000,
  });
  assert.equal(result.code, 0);
  const recordedArgv = readFileSync(argvLog, "utf8");
  assert.doesNotMatch(recordedArgv, /secret task text/);
  assert.equal(readFileSync(stdinLog, "utf8"), "secret task text");
});

test("timeout kills a sleeping process group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runhub-to-"));
  const bin = join(dir, "sleep-agent");
  writeFileSync(bin, "#!/bin/sh\nexec sleep 999\n");
  chmodSync(bin, 0o755);
  const started = Date.now();
  const result = await runProcessGroup({
    argv: [bin],
    cwd: dir,
    timeoutMs: 800,
  });
  const elapsed = Date.now() - started;
  assert.equal(result.timedOut, true);
  assert.ok(elapsed < 8000, `elapsed ${elapsed}`);
});
