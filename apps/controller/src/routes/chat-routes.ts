import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sessionResponseSchema } from "@nexu/shared";
import type { ControllerContainer } from "../app/container.js";
import { ChatService } from "../services/chat-service.js";
import type { ControllerBindings } from "../types.js";

// ~10 MB base64 cap → raw file ≈ 7.5 MB; prevents OOM/body-size attacks
const MAX_ATTACHMENT_CONTENT_BYTES = 10_000_000;

const chatAttachmentSchema = z.object({
  type: z.enum(["image", "file"]),
  content: z.string().max(MAX_ATTACHMENT_CONTENT_BYTES),
  metadata: z
    .object({
      mimeType: z.string().optional(),
      filename: z.string().optional(),
      size: z.number().optional(),
    })
    .optional(),
});

const localChatMessageInputSchema = z.object({
  type: z.enum(["text", "image", "video", "audio", "file"]),
  content: z.string().max(MAX_ATTACHMENT_CONTENT_BYTES),
  metadata: z
    .object({
      width: z.number().optional(),
      height: z.number().optional(),
      duration: z.number().optional(),
      mimeType: z.string().optional(),
      filename: z.string().optional(),
      size: z.number().optional(),
    })
    .optional(),
  /** Optional additional attachments for multipart (text + images/files) messages */
  attachments: z.array(chatAttachmentSchema).optional(),
});

const localChatMessageOutputSchema = z.object({
  id: z.string(),
  role: z.string(),
  type: z.string(),
  content: z.unknown(),
  timestamp: z.number().nullable(),
  createdAt: z.string().nullable(),
});

export function registerChatRoutes(
  app: OpenAPIHono<ControllerBindings>,
  container: ControllerContainer,
): void {
  const chatService = new ChatService(container.gatewayService);

  // GET /api/v1/chat/session - Resolve a named sessionKey to a real session
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/chat/session",
      tags: ["Chat"],
      request: {
        query: z.object({
          botId: z.string(),
          sessionKey: z.string(),
        }),
      },
      responses: {
        200: {
          description: "Session resolved from sessionKey",
          content: {
            "application/json": {
              schema: z.object({
                session: sessionResponseSchema.nullable(),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const { botId, sessionKey } = c.req.valid("query");
      const session = await container.sessionService.getSessionBySessionKey(
        botId,
        sessionKey,
      );
      return c.json({ session });
    },
  );

  // POST /api/v1/chat/local - Send local chat message (direct to main session)
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/chat/local",
      tags: ["Chat"],
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                botId: z.string(),
                sessionKey: z.string(),
                message: localChatMessageInputSchema,
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Local chat message sent",
          content: {
            "application/json": {
              schema: z.object({
                session: sessionResponseSchema.nullable(),
                message: localChatMessageOutputSchema,
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const { botId, sessionKey, message } = c.req.valid("json");

      // Send message to agent main session — do NOT pre-create the session
      // here.  Pre-creating writes an empty key-based .jsonl file that
      // appears as a ghost entry in the sessions list.  OpenClaw will create
      // the real UUID-named JSONL and register it in sessions.json as part of
      // processing chat.send, so we look it up afterwards.
      const result = await chatService.sendLocalMessage(botId, message);

      // Best-effort session lookup immediately after send.  sessions.json is
      // flushed asynchronously by OpenClaw, so this may return null on the
      // very first message.  The frontend handles that case with its own
      // 3-second discovery retry loop — no server-side sleep needed here.
      const session = await container.sessionService.getSessionBySessionKey(
        botId,
        sessionKey,
      );

      return c.json({
        session,
        message: result,
      });
    },
  );
}
