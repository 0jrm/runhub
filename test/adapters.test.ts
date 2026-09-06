import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CURSOR_MODEL } from "../src/domain.js";
import { agentArgv, reviewArgv, runProcessGroup } from "../src/adapters.js";
import { prependPath, tempDir, writeBin } from "./helpers.js";

test("cursor argv pins Grok 4.6 medium, --force, and omits the prompt", () => {
  const argv = agentArgv({
    agent: "cursor",
    bin: "cursor-agent",
    cwd: "/tmp/app",
    model: CURSOR_MODEL,
  });
  assert.equal(argv[argv.indexOf("--model") + 1], CURSOR_MODEL);
  assert.ok(argv.includes("--force"));
  assert.equal(argv.includes("do the work"), false);
});

test("claude argv uses stream-json and skip-permissions", () => {
  const argv = agentArgv({ agent: "claude", bin: "claude", cwd: "/tmp/app", model: "sonnet" });
  assert.deepEqual(argv.slice(0, 5), ["claude", "-p", "--verbose", "--output-format", "stream-json"]);
  assert.ok(argv.includes("--dangerously-skip-permissions"));
  assert.equal(argv.includes("/tmp/app"), false);
});

test("review argv is read-only print text with no tools", () => {
  const argv = reviewArgv("claude", "sonnet");
  assert.deepEqual(argv, [
    "claude",
    "-p",
    "--output-format",
    "text",
    "--model",
    "sonnet",
    "--tools",
    "",
  ]);
  assert.equal(argv.includes("--dangerously-skip-permissions"), false);
  assert.equal(argv[argv.length - 1], "");
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
  const result = await runProcessGroup({
    argv: [bin, argvLog, stdinLog, "--model", "cursor-grok-4.6-medium"],
    cwd: dir,
    stdinPath: promptFile,
    stdoutPath: join(dir, "out.txt"),
    timeoutMs: 5000,
  });
  assert.equal(result.code, 0);
  assert.doesNotMatch(readFileSync(argvLog, "utf8"), /secret task text/);
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
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 8000);
});

test("abort signal kills the child and skips waiting for timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runhub-ab-"));
  const bin = join(dir, "sleep-agent");
  writeFileSync(bin, "#!/bin/sh\nexec sleep 999\n");
  chmodSync(bin, 0o755);
  const ac = new AbortController();
  const started = Date.now();
  const pending = runProcessGroup({ argv: [bin], cwd: dir, timeoutMs: 30_000, signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  const result = await pending;
  assert.equal(result.aborted, true);
  assert.ok(Date.now() - started < 8000);
});

test("abort resolves only once the whole process group is gone", async () => {
  const dir = tempDir("pgroup");
  const pgidPath = join(dir, "pgid.txt");
  const bin = writeBin(
    dir,
    "group-agent",
    `#!/bin/sh
echo $$ > "${pgidPath}"
sleep 999 &
sleep 999
`,
  );
  const ac = new AbortController();
  const pending = runProcessGroup({ argv: [bin], cwd: dir, timeoutMs: 30_000, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 400));
  ac.abort();
  const result = await pending;
  assert.equal(result.aborted, true);

  const pgid = Number(readFileSync(pgidPath, "utf8").trim());
  assert.ok(Number.isInteger(pgid) && pgid > 1, `bad pgid: ${pgid}`);
  await new Promise((r) => setTimeout(r, 1000));
  assert.throws(
    () => process.kill(-pgid, 0),
    (err: unknown) => (err as NodeJS.ErrnoException).code === "ESRCH",
  );
});

test("user option runs sudo -n -u env -i and drops SSH_AUTH_SOCK GH_TOKEN GIT_ASKPASS", async () => {
  const dir = tempDir("sudo-user");
  const envLog = join(dir, "child.env");
  const argvLog = join(dir, "sudo.argv");
  const inner = writeBin(
    dir,
    "inner-agent",
    `#!/bin/sh
printenv > ${JSON.stringify(envLog)}
`,
  );
  writeBin(
    dir,
    "sudo",
    `#!/bin/sh
printf '%s\\n' "$*" > ${JSON.stringify(argvLog)}
printenv > ${JSON.stringify(join(dir, "sudo.env"))}
while [ "$#" -gt 0 ]; do
  case "$1" in
    env|*/env) exec "$@" ;;
  esac
  shift
done
exit 127
`,
  );
  const prevPath = process.env.PATH;
  const prevSock = process.env.SSH_AUTH_SOCK;
  const prevGh = process.env.GH_TOKEN;
  const prevAsk = process.env.GIT_ASKPASS;
  process.env.PATH = prependPath(dir);
  process.env.SSH_AUTH_SOCK = "/run/user/1000/gcr/ssh";
  process.env.GH_TOKEN = "secret-token";
  process.env.GIT_ASKPASS = "askpass";
  try {
    const result = await runProcessGroup({
      argv: [inner],
      cwd: dir,
      timeoutMs: 5000,
      user: "runhub-agent",
    });
    assert.equal(result.code, 0);
    const sudoArgv = readFileSync(argvLog, "utf8");
    assert.match(sudoArgv, /-n -u runhub-agent /);
    assert.match(sudoArgv, /HOME=\/home\/runhub-agent/);
    assert.match(sudoArgv, /PATH=\/usr\/local\/bin:\/usr\/bin:\/bin/);
    assert.match(sudoArgv, /TERM=xterm/);
    const childEnv = readFileSync(envLog, "utf8");
    assert.doesNotMatch(childEnv, /SSH_AUTH_SOCK/);
    assert.doesNotMatch(childEnv, /GH_TOKEN/);
    assert.doesNotMatch(childEnv, /GIT_ASKPASS/);
    assert.match(childEnv, /^HOME=\/home\/runhub-agent$/m);
    const sudoEnv = readFileSync(join(dir, "sudo.env"), "utf8");
    assert.doesNotMatch(sudoEnv, /SSH_AUTH_SOCK/);
    assert.doesNotMatch(sudoEnv, /GH_TOKEN/);
    assert.doesNotMatch(sudoEnv, /GIT_ASKPASS/);
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevSock === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = prevSock;
    if (prevGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevGh;
    if (prevAsk === undefined) delete process.env.GIT_ASKPASS;
    else process.env.GIT_ASKPASS = prevAsk;
  }
});
