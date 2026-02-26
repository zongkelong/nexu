import { registerPool } from "./api";
import { env, envWarnings } from "./env";
import { waitGatewayReady } from "./gateway-health";
import { log } from "./log";
import { runGatewayHealthLoops, runHeartbeatLoop, runPollLoop } from "./loops";
import { createRuntimeState } from "./state";
import { sleep } from "./utils";

const state = createRuntimeState();

async function registerPoolWithRetry(): Promise<void> {
  let attempt = 1;
  let retryDelayMs = 1000;

  while (true) {
    try {
      await registerPool();
      return;
    } catch (error: unknown) {
      log("pool registration failed; retrying", {
        attempt,
        poolId: env.RUNTIME_POOL_ID,
        retryDelayMs,
        error: error instanceof Error ? error.message : "unknown_error",
      });

      await sleep(retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, env.RUNTIME_MAX_BACKOFF_MS);
      attempt += 1;
    }
  }
}

async function main(): Promise<void> {
  if (envWarnings.usedHostnameAsRuntimePoolId) {
    log("warning: RUNTIME_POOL_ID is unset; using hostname fallback", {
      nodeEnv: env.NODE_ENV,
      poolId: env.RUNTIME_POOL_ID,
    });
  }

  if (envWarnings.deprecatedGatewayHttpEnvKeys.length > 0) {
    log("deprecated gateway HTTP env vars detected and ignored", {
      keys: envWarnings.deprecatedGatewayHttpEnvKeys,
    });
  }

  log("starting gateway", { poolId: env.RUNTIME_POOL_ID });
  await waitGatewayReady();
  await registerPoolWithRetry();
  log("pool registered", { poolId: env.RUNTIME_POOL_ID });

  runGatewayHealthLoops(state);
  void runHeartbeatLoop(state);
  await runPollLoop(state);
}

main().catch((error: unknown) => {
  console.error("[gateway] fatal error", {
    error: error instanceof Error ? error.message : "unknown_error",
  });
  process.exitCode = 1;
});
