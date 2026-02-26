# Gateway

`gateway` is the pool-node worker that keeps OpenClaw config in sync with the control plane.

Current integration uses internal HTTP endpoints (not tRPC).

It does not expose a full HTTP API. It only:

- registers pool node status to `apps/api`
- reports heartbeat (`status`, `lastSeenVersion`)
- polls latest pool config snapshot
- validates and writes full config atomically (`tmp + rename`)

Internal API endpoints used by sidecar:

- `POST /api/internal/pools/register`
- `POST /api/internal/pools/heartbeat`
- `GET /api/internal/pools/{poolId}/config/latest`

## Required env vars

- `RUNTIME_POOL_ID`
- `INTERNAL_API_TOKEN` (internal API token)
- `OPENCLAW_CONFIG_PATH`
- `RUNTIME_API_BASE_URL`

Optional but recommended:

- `RUNTIME_POD_IP`
- `RUNTIME_POLL_INTERVAL_MS`
- `RUNTIME_POLL_JITTER_MS`
- `RUNTIME_MAX_BACKOFF_MS`
- `RUNTIME_REQUEST_TIMEOUT_MS`
- `RUNTIME_HEARTBEAT_INTERVAL_MS`
- `OPENCLAW_BIN`
- `OPENCLAW_PROFILE`
- `RUNTIME_GATEWAY_PROBE_ENABLED`
- `RUNTIME_GATEWAY_CLI_TIMEOUT_MS`
- `RUNTIME_GATEWAY_LIVENESS_INTERVAL_MS`
- `RUNTIME_GATEWAY_DEEP_INTERVAL_MS`
- `RUNTIME_GATEWAY_FAIL_DEGRADED_THRESHOLD`
- `RUNTIME_GATEWAY_FAIL_UNHEALTHY_THRESHOLD`
- `RUNTIME_GATEWAY_RECOVER_THRESHOLD`
- `RUNTIME_GATEWAY_UNHEALTHY_WINDOW_MS`
- `RUNTIME_GATEWAY_MIN_STATE_HOLD_MS`

## Local run

1. Start API server first:

```bash
pnpm --filter @nexu/api dev
```

2. Export sidecar env (or use `.env`):

```bash
export RUNTIME_POOL_ID=default
export INTERNAL_API_TOKEN=change-me-internal-token
export RUNTIME_API_BASE_URL=http://localhost:3000
export OPENCLAW_CONFIG_PATH=/tmp/openclaw/config.json
export RUNTIME_POD_IP=127.0.0.1
```

3. Start sidecar:

```bash
pnpm --filter @nexu/gateway dev
```

## Verify quickly

- Create/update/pause/resume a bot in dashboard/API.
- Check sidecar logs for `applied new pool config`.
- Confirm file written at `OPENCLAW_CONFIG_PATH`.
- Call API internal endpoint and compare version:

```bash
curl -H "x-internal-token: $INTERNAL_API_TOKEN" \
  "http://localhost:3000/api/internal/pools/default/config/latest"
```
