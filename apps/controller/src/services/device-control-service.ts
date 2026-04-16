import type {
  CancelTaskBody,
  DeviceExecuteTaskBody,
  DeviceInfo,
  DeviceListResponse,
  TaskResult,
} from "@nexu/shared";
import type { NexuConfigStore } from "../store/nexu-config-store.js";

interface RpcErrorDetail {
  code: string;
  message: string;
}

type RpcResponse<T> =
  | { result: T; error?: undefined }
  | { error: RpcErrorDetail; result?: undefined };

const DEFAULT_RPC_TIMEOUT_MS = 10_000;
const DEFAULT_LIST_TIMEOUT_MS = 5_000;

export class DeviceControlRpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeviceControlRpcError";
  }
}

export class DeviceControlService {
  constructor(private readonly configStore: NexuConfigStore) {}

  private async getRpcPort(): Promise<number> {
    const config = await this.configStore.getConfig();
    return config.deviceControl.rpcPort;
  }

  private async rpc<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  ): Promise<T> {
    const port = await this.getRpcPort();
    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new Error(
        `Device control RPC failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as RpcResponse<T>;

    if (data.error !== undefined) {
      throw new DeviceControlRpcError(data.error.code, data.error.message);
    }

    return data.result as T;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const port = await this.getRpcPort();
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async listDevices(): Promise<DeviceListResponse> {
    const port = await this.getRpcPort();
    const response = await fetch(`http://127.0.0.1:${port}/devices`, {
      signal: AbortSignal.timeout(DEFAULT_LIST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to list devices: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as DeviceListResponse;
  }

  async getDevice(deviceId: string): Promise<DeviceInfo | null> {
    return this.rpc<DeviceInfo | null>("device.get_status", { deviceId });
  }

  async executeTask(
    deviceId: string,
    body: DeviceExecuteTaskBody,
  ): Promise<{ result: TaskResult }> {
    const taskTimeout = body.timeout ?? 120_000;
    const result = await this.rpc<TaskResult>(
      "device.execute_task",
      { deviceId, task: body.task, timeoutMs: taskTimeout },
      taskTimeout + 5_000,
    );
    return { result };
  }

  async cancelTask(
    deviceId: string,
    body: CancelTaskBody,
  ): Promise<{ cancelled: boolean; message?: string }> {
    return this.rpc<{ cancelled: boolean; message?: string }>(
      "device.cancel_task",
      { deviceId, taskId: body.taskId },
    );
  }
}
