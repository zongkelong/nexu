import {
  runtimePoolHeartbeatSchema,
  runtimePoolRegisterSchema,
} from "@nexu/shared";
import { env } from "./env";
import type { RuntimeState } from "./state";
import { withTimeout } from "./utils";

export async function fetchJson(
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(`${env.RUNTIME_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-internal-token": env.INTERNAL_API_TOKEN,
      ...(init?.headers ?? {}),
    },
    signal: withTimeout(env.RUNTIME_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `request failed: ${response.status} ${response.statusText} ${text}`,
    );
  }

  return response.json() as Promise<unknown>;
}

export async function registerPool(): Promise<void> {
  const input = runtimePoolRegisterSchema.parse({
    poolId: env.RUNTIME_POOL_ID,
    podIp: env.RUNTIME_POD_IP,
    status: "active",
  });

  await fetchJson("/api/internal/pools/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function sendHeartbeat(state: RuntimeState): Promise<void> {
  const input = runtimePoolHeartbeatSchema.parse({
    poolId: env.RUNTIME_POOL_ID,
    podIp: env.RUNTIME_POD_IP,
    status: state.status,
    lastSeenVersion: state.lastSeenVersion,
    timestamp: new Date().toISOString(),
  });

  await fetchJson("/api/internal/pools/heartbeat", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
