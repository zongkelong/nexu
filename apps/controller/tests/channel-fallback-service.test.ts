import { describe, expect, it, vi } from "vitest";
import {
  type ChannelFallbackEventSource,
  ChannelFallbackService,
} from "../src/services/channel-fallback-service.js";

function createEventSource(): ChannelFallbackEventSource & {
  emit: (event: string, payload?: unknown) => void;
} {
  const listeners = new Set<
    (event: { event: string; payload?: unknown }) => void
  >();
  return {
    onRuntimeEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event, payload) {
      for (const listener of listeners) {
        listener({ event, payload });
      }
    },
  };
}

describe("ChannelFallbackService", () => {
  it("sends a fallback for feishu failed reply outcomes", async () => {
    const source = createEventSource();
    const sendChannelMessage = vi.fn().mockResolvedValue({
      messageId: "om_fallback",
      channel: "feishu",
    });
    const service = new ChannelFallbackService(
      source,
      { sendChannelMessage },
      { getLocale: () => "en" },
    );

    service.start();
    source.emit("channel.reply_outcome", {
      channel: "feishu",
      status: "failed",
      accountId: "acc-1",
      chatId: "oc_123",
      replyToMessageId: "om_root",
      actionId: "act-1",
      reasonCode: "dispatch_threw",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(sendChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "feishu",
        accountId: "acc-1",
        to: "chat:oc_123",
        threadId: "om_root",
        message: expect.stringContaining(
          "couldn't deliver the previous reply successfully",
        ),
      }),
    );
    expect(service.listRecentEvents(1)[0]).toMatchObject({
      fallbackOutcome: "sent",
      fallbackReason: "fallback_sent",
    });
  });

  it("dedupes repeated failure claims for the same action", async () => {
    const source = createEventSource();
    const sendChannelMessage = vi
      .fn()
      .mockResolvedValue({ messageId: "om_fallback" });
    const service = new ChannelFallbackService(
      source,
      { sendChannelMessage },
      { getLocale: () => "en" },
    );

    service.start();
    const payload = {
      channel: "feishu",
      status: "silent",
      to: "chat:oc_123",
      replyToMessageId: "om_dup",
      actionId: "act-dup",
      reasonCode: "no_final_reply",
    };
    source.emit("channel.reply_outcome", payload);
    source.emit("channel.reply_outcome", payload);
    await Promise.resolve();
    await Promise.resolve();

    expect(sendChannelMessage).toHaveBeenCalledTimes(1);
    expect(
      service.listRecentEvents(2).map((entry) => entry.fallbackReason),
    ).toEqual(["fallback_sent", "duplicate_claim"]);
  });

  it("ignores non-feishu outcomes", async () => {
    const source = createEventSource();
    const sendChannelMessage = vi.fn();
    const service = new ChannelFallbackService(
      source,
      { sendChannelMessage },
      { getLocale: () => "en" },
    );

    service.start();
    source.emit("channel.reply_outcome", {
      channel: "slack",
      status: "failed",
      to: "channel:C123",
      actionId: "act-slack",
    });
    await Promise.resolve();

    expect(sendChannelMessage).not.toHaveBeenCalled();
    expect(service.listRecentEvents(1)[0]).toMatchObject({
      fallbackOutcome: "skipped",
      fallbackReason: "unsupported_channel",
    });
  });

  it("renders synthetic override params into unknown fallback template", async () => {
    const source = createEventSource();
    const sendChannelMessage = vi.fn().mockResolvedValue({
      messageId: "om_unknown",
      channel: "feishu",
    });
    const service = new ChannelFallbackService(
      source,
      { sendChannelMessage },
      { getLocale: () => "en" },
    );

    service.start();
    source.emit("channel.reply_outcome", {
      channel: "feishu",
      status: "failed",
      accountId: "acc-1",
      chatId: "oc_123",
      replyToMessageId: "om_unknown_root",
      reasonCode: "synthetic_pre_llm_failure",
      syntheticInput: JSON.stringify({
        errorCode: "not_exists",
        params: { hint: "A1" },
      }),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(sendChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Diagnostic hint: A1"),
      }),
    );
  });
});
