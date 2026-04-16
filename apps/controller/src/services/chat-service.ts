import { logger } from "../lib/logger.js";
import type { OpenClawGatewayService } from "./openclaw-gateway-service.js";

export interface LocalChatMessageMetadata {
  width?: number;
  height?: number;
  duration?: number;
  mimeType?: string;
  filename?: string;
  size?: number;
}

export interface LocalChatAttachment {
  /** Only images are sent via attachments; files go via message text. */
  type: "image";
  content: string;
  metadata?: {
    mimeType?: string;
    filename?: string;
    size?: number;
  };
}

export interface LocalChatMessageInput {
  type: "text" | "image" | "video" | "audio" | "file";
  content: string;
  metadata?: LocalChatMessageMetadata;
  attachments?: LocalChatAttachment[];
}

export interface LocalChatMessageOutput {
  id: string;
  role: "user" | "assistant";
  type: "text" | "image" | "video" | "audio" | "file";
  content: unknown;
  timestamp: number | null;
  createdAt: string | null;
}

export interface SendToMainSessionInput {
  botId: string;
  sessionKey: string;
  message: string;
  messageType: string;
  metadata?: LocalChatMessageMetadata;
  attachments?: LocalChatAttachment[];
}

export interface SendToMainSessionResult {
  messageId?: string;
  content?: unknown;
}

/**
 * ChatService
 *
 * Handles local chat messages sent directly to an agent's main session,
 * bypassing channel configurations.
 *
 * This service integrates with OpenClaw Gateway's main session mechanism.
 * The actual sendToMainSession implementation will be completed in task 6.
 */
export class ChatService {
  constructor(private readonly gatewayService: OpenClawGatewayService) {}

  /**
   * Send a local chat message to agent main session
   *
   * Message format: { type: "text" | "image" | "video" | "audio", content: string, metadata?: {...} }
   *
   * Uses OpenClaw Gateway's main session mechanism,
   * bypassing any channel configuration.
   */
  async sendLocalMessage(
    botId: string,
    message: LocalChatMessageInput,
  ): Promise<LocalChatMessageOutput> {
    // Build main session key: agent:{botId}:main
    const sessionKey = `agent:${botId}:main`;

    // Convert structured message to OpenClaw-compatible format
    const messageContent = message.content;

    logger.info(
      {
        route: "chat.sendLocalMessage",
        botId,
        sessionKey,
        messageType: message.type,
      },
      "sending local chat via main session",
    );

    // Send via Gateway using chat.send — queues message to agent main session.
    // Throws on failure; the route handler will propagate a 500 to the client.
    const result = await this.sendToMainSession({
      botId,
      sessionKey,
      message: messageContent,
      messageType: message.type,
      metadata: message.metadata,
      attachments: message.attachments,
    });

    return {
      id: result.messageId ?? `local_${Date.now()}`,
      role: "assistant",
      type: message.type,
      content: result.content ?? null,
      timestamp: Date.now(),
      createdAt: new Date().toISOString(),
    };
  }

  private async sendToMainSession(
    input: SendToMainSessionInput,
  ): Promise<SendToMainSessionResult> {
    return this.gatewayService.sendToMainSession({
      botId: input.botId,
      sessionKey: input.sessionKey,
      message: input.message,
      messageType: input.messageType as
        | "text"
        | "image"
        | "video"
        | "audio"
        | "file",
      metadata: input.metadata as Record<string, unknown> | undefined,
      attachments: input.attachments?.map((a) => ({
        type: a.type,
        data: a.content,
        mimeType: a.metadata?.mimeType,
        filename: a.metadata?.filename,
      })),
    });
  }
}
