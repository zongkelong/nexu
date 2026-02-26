import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { runtimePoolConfigResponseSchema } from "@nexu/shared";
import { fetchJson } from "./api";
import { env } from "./env";
import { log } from "./log";
import type { RuntimeState } from "./state";
import { setConfigSyncStatus } from "./state";

async function atomicWriteConfig(configJson: string): Promise<void> {
  await mkdir(dirname(env.OPENCLAW_CONFIG_PATH), { recursive: true });
  const tempPath = `${env.OPENCLAW_CONFIG_PATH}.tmp`;
  await writeFile(tempPath, configJson, "utf8");
  await rename(tempPath, env.OPENCLAW_CONFIG_PATH);
}

export async function pollLatestConfig(state: RuntimeState): Promise<boolean> {
  const response = await fetchJson(
    `/api/internal/pools/${env.RUNTIME_POOL_ID}/config/latest`,
    {
      method: "GET",
    },
  );

  const payload = runtimePoolConfigResponseSchema.parse(response);
  if (payload.configHash === state.lastConfigHash) {
    return false;
  }

  const configJson = JSON.stringify(payload.config, null, 2);
  await atomicWriteConfig(configJson);

  state.lastConfigHash = payload.configHash;
  state.lastSeenVersion = payload.version;
  setConfigSyncStatus(state, "active");

  log("applied new pool config", {
    poolId: payload.poolId,
    version: payload.version,
    hash: payload.configHash,
  });

  return true;
}
