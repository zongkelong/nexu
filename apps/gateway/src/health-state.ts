import type { RuntimeStatus } from "./state";

export interface GatewayHealthEvaluatorConfig {
  failDegradedThreshold: number;
  failUnhealthyThreshold: number;
  recoverThreshold: number;
  unhealthyWindowMs: number;
  minStateHoldMs: number;
}

interface ProbeCounters {
  consecutiveLivenessFailures: number;
  consecutiveLivenessSuccesses: number;
  consecutiveDeepFailures: number;
  consecutiveDeepSuccesses: number;
}

export interface GatewayHealthEvaluator {
  status: RuntimeStatus;
  counters: ProbeCounters;
  lastStateChangedAtMs: number;
  deepFailureWindowStartedAtMs: number | null;
  lastDeepFailureAtMs: number | null;
}

export interface GatewayStatusTransition {
  from: RuntimeStatus;
  to: RuntimeStatus;
  reason: string;
}

function canTransition(
  evaluator: GatewayHealthEvaluator,
  nowMs: number,
  minStateHoldMs: number,
): boolean {
  return nowMs - evaluator.lastStateChangedAtMs >= minStateHoldMs;
}

function transitionStatus(
  evaluator: GatewayHealthEvaluator,
  nextStatus: RuntimeStatus,
  reason: string,
  nowMs: number,
): GatewayStatusTransition {
  const from = evaluator.status;
  evaluator.status = nextStatus;
  evaluator.lastStateChangedAtMs = nowMs;
  return {
    from,
    to: nextStatus,
    reason,
  };
}

export function createGatewayHealthEvaluator(
  nowMs: number,
): GatewayHealthEvaluator {
  return {
    status: "active",
    counters: {
      consecutiveLivenessFailures: 0,
      consecutiveLivenessSuccesses: 0,
      consecutiveDeepFailures: 0,
      consecutiveDeepSuccesses: 0,
    },
    lastStateChangedAtMs: nowMs,
    deepFailureWindowStartedAtMs: null,
    lastDeepFailureAtMs: null,
  };
}

export function onLivenessSuccess(
  evaluator: GatewayHealthEvaluator,
  config: GatewayHealthEvaluatorConfig,
  nowMs: number,
): GatewayStatusTransition | null {
  evaluator.counters.consecutiveLivenessFailures = 0;
  evaluator.counters.consecutiveLivenessSuccesses += 1;

  if (evaluator.status !== "degraded") {
    return null;
  }

  const livenessRecovered =
    evaluator.counters.consecutiveLivenessSuccesses >= config.recoverThreshold;
  const deepHasRecentFailures =
    evaluator.lastDeepFailureAtMs !== null &&
    nowMs - evaluator.lastDeepFailureAtMs <= config.unhealthyWindowMs;

  if (!livenessRecovered || deepHasRecentFailures) {
    return null;
  }

  if (!canTransition(evaluator, nowMs, config.minStateHoldMs)) {
    return null;
  }

  return transitionStatus(
    evaluator,
    "active",
    "liveness_recovered_and_deep_window_clean",
    nowMs,
  );
}

export function onLivenessFailure(
  evaluator: GatewayHealthEvaluator,
  config: GatewayHealthEvaluatorConfig,
  nowMs: number,
): GatewayStatusTransition | null {
  evaluator.counters.consecutiveLivenessFailures += 1;
  evaluator.counters.consecutiveLivenessSuccesses = 0;

  if (evaluator.status !== "active") {
    return null;
  }

  if (
    evaluator.counters.consecutiveLivenessFailures <
    config.failDegradedThreshold
  ) {
    return null;
  }

  if (!canTransition(evaluator, nowMs, config.minStateHoldMs)) {
    return null;
  }

  evaluator.counters.consecutiveDeepFailures = 0;
  evaluator.counters.consecutiveDeepSuccesses = 0;
  evaluator.deepFailureWindowStartedAtMs = null;

  return transitionStatus(
    evaluator,
    "degraded",
    "liveness_failure_threshold_reached",
    nowMs,
  );
}

export function onDeepHealthSuccess(
  evaluator: GatewayHealthEvaluator,
  config: GatewayHealthEvaluatorConfig,
  nowMs: number,
): GatewayStatusTransition | null {
  evaluator.counters.consecutiveDeepFailures = 0;
  evaluator.counters.consecutiveDeepSuccesses += 1;
  evaluator.deepFailureWindowStartedAtMs = null;

  if (evaluator.status !== "unhealthy") {
    return null;
  }

  if (evaluator.counters.consecutiveDeepSuccesses < config.recoverThreshold) {
    return null;
  }

  if (!canTransition(evaluator, nowMs, config.minStateHoldMs)) {
    return null;
  }

  return transitionStatus(evaluator, "degraded", "deep_recovered", nowMs);
}

export function onDeepHealthFailure(
  evaluator: GatewayHealthEvaluator,
  config: GatewayHealthEvaluatorConfig,
  nowMs: number,
): GatewayStatusTransition | null {
  evaluator.counters.consecutiveDeepFailures += 1;
  evaluator.counters.consecutiveDeepSuccesses = 0;
  evaluator.lastDeepFailureAtMs = nowMs;

  if (evaluator.deepFailureWindowStartedAtMs === null) {
    evaluator.deepFailureWindowStartedAtMs = nowMs;
  }

  if (evaluator.status !== "degraded") {
    return null;
  }

  const failThresholdReached =
    evaluator.counters.consecutiveDeepFailures >= config.failUnhealthyThreshold;
  const unhealthyWindowReached =
    nowMs - evaluator.deepFailureWindowStartedAtMs >= config.unhealthyWindowMs;

  if (!failThresholdReached && !unhealthyWindowReached) {
    return null;
  }

  if (!canTransition(evaluator, nowMs, config.minStateHoldMs)) {
    return null;
  }

  return transitionStatus(
    evaluator,
    "unhealthy",
    failThresholdReached
      ? "deep_failure_threshold_reached"
      : "deep_failure_window_reached",
    nowMs,
  );
}
