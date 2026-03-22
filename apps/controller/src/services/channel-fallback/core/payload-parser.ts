import type { ChannelReplyOutcomePayload } from "./channel-fallback-types.js";

export function parseChannelReplyOutcomePayload(
  raw: unknown,
): ChannelReplyOutcomePayload | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const channel = asString(value.channel);
  const status = asString(value.status);
  if (!channel || !status) {
    return null;
  }

  return {
    channel,
    status,
    reasonCode: asString(value.reasonCode) ?? undefined,
    accountId: asString(value.accountId) ?? undefined,
    to: asString(value.to) ?? undefined,
    chatId: asString(value.chatId) ?? undefined,
    threadId: asString(value.threadId) ?? undefined,
    replyToMessageId: asString(value.replyToMessageId) ?? undefined,
    sessionKey: asString(value.sessionKey) ?? undefined,
    actionId: asString(value.actionId) ?? undefined,
    turnId: asString(value.turnId) ?? undefined,
    messageId: asString(value.messageId) ?? undefined,
    error: asString(value.error) ?? undefined,
    ts: asString(value.ts) ?? undefined,
    syntheticInput: asString(value.syntheticInput) ?? undefined,
  };
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
