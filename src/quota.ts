import {
  PROVIDERS,
  QUOTA_DETAIL_CHARS,
  QUOTA_TIMEOUT_MS,
  nowIso,
  truncateChars,
  type Provider,
  type QuotaProbe,
  type QuotaSnapshot,
} from "./domain.js";
import { probeArgv, resolveBin, runCaptured } from "./adapters.js";

async function probeProvider(provider: Provider): Promise<QuotaProbe> {
  const bin = resolveBin(provider);
  if (bin === undefined) {
    return {
      provider,
      probe: "missing",
      detail: truncateChars(`not on PATH (tried ${provider} binaries)`, QUOTA_DETAIL_CHARS),
    };
  }
  const attempts = probeArgv(provider, bin);
  let lastDetail = "";
  for (const argv of attempts) {
    const result = await runCaptured({ argv, timeoutMs: QUOTA_TIMEOUT_MS });
    const combined = `${result.stdout}${result.stderr}`.trim();
    lastDetail = result.timedOut ? `timeout 8s: ${combined}` : combined;
    const looksFailed = /failed to load|not found|ENOENT|EACCES/i.test(combined);
    if (!result.timedOut && result.code === 0 && !looksFailed) {
      return {
        provider,
        probe: "ok",
        detail: truncateChars(lastDetail.length > 0 ? lastDetail : `${argv.join(" ")} exit 0`, QUOTA_DETAIL_CHARS),
      };
    }
  }
  return {
    provider,
    probe: "error",
    detail: truncateChars(lastDetail.length > 0 ? lastDetail : "probe failed", QUOTA_DETAIL_CHARS),
  };
}

export async function captureQuota(): Promise<QuotaSnapshot> {
  const providers: QuotaProbe[] = [];
  for (const provider of PROVIDERS) {
    providers.push(await probeProvider(provider));
  }
  return { capturedAt: nowIso(), providers };
}
