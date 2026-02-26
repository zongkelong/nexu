export type RuntimeStatus = "active" | "degraded" | "unhealthy";

export type GatewayProbeErrorCode =
  | "cli_timeout"
  | "cli_exit_nonzero"
  | "parse_error"
  | "cli_spawn_error";

export type ConfigSyncStatus = "active" | "degraded";

export interface RuntimeState {
  status: RuntimeStatus;
  configSyncStatus: ConfigSyncStatus;
  gatewayStatus: RuntimeStatus;
  lastSeenVersion: number;
  lastConfigHash: string;
  gatewayLastOkAt: string | null;
  gatewayLastErrorCode: GatewayProbeErrorCode | null;
  gatewayLastErrorAt: string | null;
}

export function createRuntimeState(): RuntimeState {
  return {
    status: "active",
    configSyncStatus: "active",
    gatewayStatus: "active",
    lastSeenVersion: 0,
    lastConfigHash: "",
    gatewayLastOkAt: null,
    gatewayLastErrorCode: null,
    gatewayLastErrorAt: null,
  };
}

function toSeverity(status: RuntimeStatus): 0 | 1 | 2 {
  if (status === "active") {
    return 0;
  }

  if (status === "degraded") {
    return 1;
  }

  return 2;
}

function updateRuntimeStatus(state: RuntimeState): void {
  const configSeverity = toSeverity(state.configSyncStatus);
  const gatewaySeverity = toSeverity(state.gatewayStatus);
  const severity = Math.max(configSeverity, gatewaySeverity);

  if (severity === 0) {
    state.status = "active";
    return;
  }

  if (severity === 1) {
    state.status = "degraded";
    return;
  }

  state.status = "unhealthy";
}

export function setConfigSyncStatus(
  state: RuntimeState,
  status: ConfigSyncStatus,
): void {
  state.configSyncStatus = status;
  updateRuntimeStatus(state);
}

export function setGatewayStatus(
  state: RuntimeState,
  status: RuntimeStatus,
): void {
  state.gatewayStatus = status;
  updateRuntimeStatus(state);
}

export function markGatewayProbeSuccess(
  state: RuntimeState,
  checkedAtIso: string,
): void {
  state.gatewayLastOkAt = checkedAtIso;
}

export function markGatewayProbeFailure(
  state: RuntimeState,
  errorCode: GatewayProbeErrorCode,
  checkedAtIso: string,
): void {
  state.gatewayLastErrorCode = errorCode;
  state.gatewayLastErrorAt = checkedAtIso;
}
