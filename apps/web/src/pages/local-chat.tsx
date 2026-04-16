import { ChatMarkdown } from "@/components/ui/chat-markdown";
import { cn } from "@/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  ChevronDown,
  File,
  FileSpreadsheet,
  FileText,
  Loader2,
  MessageSquare,
  Paperclip,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getApiV1Bots,
  getApiV1ChatHistory,
  getApiV1ChatSession,
  postApiV1ChatLocal,
} from "../../lib/api/sdk.gen";

const BOT_AVATAR = "/brand/ip-nexu.svg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BotItem {
  id: string;
  name: string;
  slug: string;
  status: "active" | "paused" | "deleted";
  modelId: string;
}

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: unknown;
  timestamp: number | null;
  createdAt: string | null;
}

/** An attachment staged in the input box, waiting to be sent */
interface PendingAttachment {
  id: string;
  type: "image" | "file";
  /** data: URL — used only for rendering thumbnails / previews in the tray */
  previewUrl: string;
  /**
   * Pure base64-encoded content (NO data: URL prefix).
   * For images this is sent via the `attachments` array to model vision.
   * For text files the content is read separately into `textContent` instead.
   */
  content: string;
  mimeType: string;
  filename?: string;
  size?: number;
  /**
   * Extracted UTF-8 text for text-readable files (txt, csv, json, code …).
   * When present, the file content is folded into the message body rather
   * than sent as a binary attachment — mirroring how mature channel adapters
   * handle documents via extractFileContentFromSource().
   */
  textContent?: string;
}

/** Typed content blocks used for rendering chat bubbles */
type ContentBlock =
  | { kind: "text"; text: string }
  | { kind: "image"; src: string; mimeType?: string }
  | { kind: "file"; filename: string; mimeType: string; size?: number };

// Channel definitions --------------------------------------------------------

type ChannelId = "webchat" | "feishu" | "wechat";

interface ChannelOption {
  id: ChannelId;
  sessionKeySuffix: string;
}

const CHANNEL_OPTIONS: ChannelOption[] = [
  { id: "webchat", sessionKeySuffix: ":main" },
  { id: "feishu", sessionKeySuffix: ":feishu:local" },
  { id: "wechat", sessionKeySuffix: ":wechat:local" },
];

// CHANNEL_OPTIONS is a non-empty tuple — the first element always exists.
const DEFAULT_CHANNEL: ChannelOption = CHANNEL_OPTIONS[0] as ChannelOption;

function buildSessionKey(botId: string, channel: ChannelOption): string {
  return `agent:${botId}${channel.sessionKeySuffix}`;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum raw file size accepted for upload.
 * OpenClaw's parseMessageWithAttachments uses a 5 MB decoded-bytes limit, so
 * 5 MB raw → ~6.7 MB base64 comfortably fits.  We keep 7.5 MB to allow for
 * slightly larger images while still staying under OpenClaw's hard cap.
 */
const MAX_FILE_BYTES = 7_500_000;

/**
 * Maximum number of UTF-8 characters extracted from a text file to include
 * in the message body.  Roughly 4 k tokens — enough for typical source files,
 * CSV snippets, and JSON payloads without bloating the context window.
 */
const MAX_FILE_TEXT_CHARS = 4_000;

// Polling / session-discovery timing constants
/** How often to poll for a new assistant message (ms) */
const POLL_INTERVAL_MS = 2_000;
/** Maximum number of polling attempts before giving up (~80 s) */
const POLL_MAX_ATTEMPTS = 40;
/** Interval between session-discovery retries after send (ms) */
const SESSION_DISCOVERY_INTERVAL_MS = 500;
/** Maximum number of session-discovery attempts after send */
const SESSION_DISCOVERY_MAX_ATTEMPTS = 6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse any message content shape into typed ContentBlock[] for rendering */
function extractContent(msg: ChatMsg): ContentBlock[] {
  const c = msg.content;

  // Plain string — could be text or a raw base64 image DataURL
  if (typeof c === "string") {
    if (c.startsWith("data:image/")) return [{ kind: "image", src: c }];
    return [{ kind: "text", text: c }];
  }

  // Anthropic-style content block array (from JSONL history)
  if (Array.isArray(c)) {
    // Already-processed ContentBlocks (e.g. optimistic messages) carry a
    // `kind` discriminator rather than Anthropic's `type` field — pass through.
    if (
      c.length > 0 &&
      typeof (c[0] as Record<string, unknown>).kind === "string"
    ) {
      return c as ContentBlock[];
    }
    return (c as Array<Record<string, unknown>>).flatMap(
      (b): ContentBlock[] => {
        if (b.type === "text") {
          return [{ kind: "text" as const, text: String(b.text ?? "") }];
        }
        if (b.type === "image") {
          const src = b.source as Record<string, unknown> | undefined;
          const data = String(src?.data ?? "");
          const mediaType = String(src?.media_type ?? "image/jpeg");
          return [
            { kind: "image" as const, src: `data:${mediaType};base64,${data}` },
          ];
        }
        if (b.type === "file") {
          return [
            {
              kind: "file" as const,
              filename: String(b.filename ?? "file"),
              mimeType: String(b.mimeType ?? "application/octet-stream"),
              size: typeof b.size === "number" ? b.size : undefined,
            },
          ];
        }
        return [];
      },
    );
  }

  // Object with a text field
  if (typeof c === "object" && c !== null && "text" in c) {
    return [
      { kind: "text", text: String((c as Record<string, unknown>).text ?? "") },
    ];
  }

  return [];
}

/** Strip assistant [[reply_to_current]] prefix and <final>…</final> wrapper tags */
function cleanText(raw: string): string {
  return raw
    .replace(/^\s*\[\[reply_to_current\]\]\s*/u, "")
    .replace(/<final>\s*/giu, "")
    .replace(/\s*<\/final>/giu, "")
    .trim();
}

/** Format HH:mm from ms timestamp */
function formatTs(ts?: number | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Human-readable file size */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Strip the `data:<mime>;base64,` header from a DataURL and return pure
 * base64.  If the string is already bare base64 it is returned unchanged.
 * This mirrors the channel-adapter pattern where attachments always carry
 * raw base64 — never a DataURL — in the `content` field.
 */
function extractBase64FromDataUrl(dataUrl: string): string {
  const commaIdx = dataUrl.indexOf(",");
  if (commaIdx !== -1 && dataUrl.startsWith("data:")) {
    return dataUrl.slice(commaIdx + 1);
  }
  return dataUrl;
}

/**
 * Returns true for MIME types whose content can be meaningfully read as
 * UTF-8 text and included in the message body.
 * Matches the categories handled by OpenClaw's extractFileContentFromSource().
 */
function isTextReadable(mimeType: string): boolean {
  if (mimeType.startsWith("text/")) return true;
  const textSubtypes = new Set([
    "application/json",
    "application/xml",
    "application/javascript",
    "application/typescript",
    "application/x-yaml",
    "application/toml",
    "application/csv",
    "application/x-sh",
    "application/x-shellscript",
  ]);
  return textSubtypes.has(mimeType);
}

/** Pick a lucide icon and colour based on MIME type */
function fileIconProps(mimeType: string): { Icon: typeof File; color: string } {
  // Use exact / prefix matches to avoid false positives from substring collisions
  if (mimeType === "application/pdf")
    return { Icon: FileText, color: "text-red-500" };
  if (
    mimeType === "application/vnd.ms-excel" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimeType === "text/csv"
  ) {
    return { Icon: FileSpreadsheet, color: "text-green-600" };
  }
  return { Icon: File, color: "text-blue-500" };
}

// ---------------------------------------------------------------------------
// Small display components
// ---------------------------------------------------------------------------

/** Inline image with click-to-expand lightbox */
function ImageBubble({ src }: { src: string }) {
  const [expanded, setExpanded] = useState(false);
  const backdropRef = useRef<HTMLDialogElement>(null);

  // Close on Escape key; trap focus inside the dialog while open
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    // Move focus into the backdrop so Escape is captured consistently
    backdropRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded]);

  return (
    <>
      <button
        type="button"
        className="cursor-zoom-in rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        onClick={() => setExpanded(true)}
        aria-label="Expand image"
      >
        <img
          src={src}
          alt=""
          className="max-w-[240px] max-h-[240px] rounded-2xl object-cover"
        />
      </button>
      {expanded && (
        // Native <dialog> satisfies useSemanticElements; we manage open state
        // ourselves (no showModal()) so the backdrop is a sibling fixed div.
        // eslint-disable-next-line jsx-a11y/no-autofocus
        <dialog
          ref={backdropRef}
          aria-label="Image preview"
          open
          className="fixed inset-0 z-50 m-0 flex max-h-none max-w-none items-center justify-center border-0 bg-black/70 p-0 outline-none backdrop:hidden"
          onClick={() => setExpanded(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setExpanded(false);
          }}
        >
          {/* Clicking the image itself should not close the lightbox; wrap in a
              button so keyboard users can also interact with it without closing. */}
          <button
            type="button"
            className="cursor-default outline-none"
            onClick={(e) => e.stopPropagation()}
            aria-label="Image (press Escape to close)"
          >
            <img
              src={src}
              alt=""
              className="max-h-[90vh] max-w-[90vw] rounded-xl shadow-2xl"
            />
          </button>
        </dialog>
      )}
    </>
  );
}

/** File card: icon + filename + optional size */
function FileBubble({
  filename,
  mimeType,
  size,
}: {
  filename: string;
  mimeType: string;
  size?: number;
}) {
  const { Icon, color } = fileIconProps(mimeType);
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-2 px-3 py-2.5 min-w-[180px] max-w-[260px]">
      <Icon className={cn("h-8 w-8 shrink-0", color)} />
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-text-primary">
          {filename}
        </p>
        {size !== undefined && (
          <p className="text-[11px] text-text-muted">{formatBytes(size)}</p>
        )}
      </div>
    </div>
  );
}

/** Pending attachment tray shown above the textarea */
function AttachmentTray({
  attachments,
  onRemove,
}: {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-2.5 pb-1">
      {attachments.map((att) => (
        <div key={att.id} className="relative group">
          {att.type === "image" ? (
            <img
              src={att.previewUrl}
              alt=""
              className="h-16 w-16 rounded-xl object-cover border border-border"
            />
          ) : (
            <FileBubble
              filename={att.filename ?? "file"}
              mimeType={att.mimeType}
              size={att.size}
            />
          )}
          <button
            type="button"
            onClick={() => onRemove(att.id)}
            title={t("localChat.removeAttachment")}
            aria-label={t("localChat.removeAttachment")}
            className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-text-primary text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow"
          >
            <X size={10} />
          </button>
        </div>
      ))}
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex items-start gap-3">
      <img
        src={BOT_AVATAR}
        alt=""
        className="h-9 w-9 shrink-0 object-contain -ml-1"
      />
      <div className="flex items-center gap-1.5 rounded-[20px] rounded-tl-sm border border-border bg-surface-1 px-4 py-3 shadow-[0_10px_24px_rgba(15,23,42,0.04)]">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted"
            style={{ animationDelay: `${i * 150}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

/** Renders a single chat message — supports text, images, and file cards */
function ChatBubble({ msg }: { msg: ChatMsg }) {
  const isBot = msg.role === "assistant";
  const time = formatTs(msg.timestamp);

  // Parse content into typed blocks; apply assistant cleanup to text blocks
  const blocks = extractContent(msg).map((b) =>
    isBot && b.kind === "text" ? { ...b, text: cleanText(b.text) } : b,
  );

  const hasContent = blocks.some(
    (b) => b.kind !== "text" || b.text.trim().length > 0,
  );
  if (!hasContent) return null;

  return (
    <div
      className={cn(
        "flex gap-3",
        isBot ? "items-start" : "flex-row-reverse items-start",
      )}
    >
      {/* Avatar */}
      {isBot ? (
        <img
          src={BOT_AVATAR}
          alt=""
          className="h-9 w-9 shrink-0 object-contain -ml-1"
        />
      ) : (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 ring-1 ring-border/50">
          <span className="text-[11px] font-semibold leading-none text-white">
            Me
          </span>
        </div>
      )}

      {/* Content column */}
      <div
        className={cn(
          "flex max-w-[44rem] flex-col gap-2",
          isBot ? "items-start" : "items-end",
        )}
      >
        {blocks.map((block, i) => {
          // Composite key: kind + index — blocks within a single message bubble
          // have no stable ids; position is the correct reconciliation boundary.
          const key = `${block.kind}-${i}`;
          if (block.kind === "image") {
            return <ImageBubble key={key} src={block.src} />;
          }
          if (block.kind === "file") {
            return (
              <FileBubble
                key={key}
                filename={block.filename}
                mimeType={block.mimeType}
                size={block.size}
              />
            );
          }
          if (!block.text.trim()) return null;
          return (
            <div
              key={key}
              className={cn(
                "inline-block max-w-full break-words rounded-[20px] px-4 py-3 text-[13px] shadow-[0_10px_24px_rgba(15,23,42,0.04)]",
                isBot
                  ? "border border-border bg-surface-1 text-text-primary rounded-tl-sm"
                  : "bg-surface-3 text-text-primary rounded-tr-sm",
              )}
            >
              <ChatMarkdown content={block.text} />
            </div>
          );
        })}
        {time && (
          <div
            className={cn(
              "text-[10px] text-text-muted",
              isBot ? "pl-1" : "pr-1 text-right",
            )}
          >
            {time}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bot selector dropdown
// ---------------------------------------------------------------------------

function BotSelector({
  bots,
  selected,
  onSelect,
}: {
  bots: BotItem[];
  selected: BotItem | null;
  onSelect: (bot: BotItem) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const activeBots = bots.filter((b: BotItem) => b.status === "active");

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-2 rounded-xl border px-3 py-2 text-[13px] font-medium transition-colors",
          "border-border bg-surface-1 text-text-primary hover:bg-surface-2",
          open && "bg-surface-2",
        )}
      >
        <Bot size={14} className="text-text-muted" />
        <span>{selected?.name ?? t("localChat.selectBot")}</span>
        <ChevronDown
          size={13}
          className={cn(
            "text-text-muted transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1.5 min-w-[180px] rounded-xl border border-border bg-surface-1 py-1 shadow-[0_8px_24px_rgba(15,23,42,0.12)]">
          {activeBots.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-text-muted">
              {t("localChat.noBots")}
            </div>
          ) : (
            activeBots.map((bot) => (
              <button
                key={bot.id}
                type="button"
                onClick={() => {
                  onSelect(bot);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-surface-2",
                  selected?.id === bot.id && "font-medium text-accent",
                )}
              >
                <Sparkles size={13} className="shrink-0 text-text-muted" />
                <span className="truncate">{bot.name}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channel selector dropdown
// ---------------------------------------------------------------------------

function ChannelSelector({
  selected,
  onSelect,
}: {
  selected: ChannelOption;
  onSelect: (channel: ChannelOption) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-2 rounded-xl border px-3 py-2 text-[13px] font-medium transition-colors",
          "border-border bg-surface-1 text-text-primary hover:bg-surface-2",
          open && "bg-surface-2",
        )}
        title={t("localChat.selectChannel")}
      >
        <MessageSquare size={14} className="text-text-muted" />
        <span>{t(`localChat.channel.${selected.id}`)}</span>
        <ChevronDown
          size={13}
          className={cn(
            "text-text-muted transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 min-w-[160px] rounded-xl border border-border bg-surface-1 py-1 shadow-[0_8px_24px_rgba(15,23,42,0.12)]">
          {CHANNEL_OPTIONS.map((ch) => (
            <button
              key={ch.id}
              type="button"
              onClick={() => {
                onSelect(ch);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-surface-2",
                selected.id === ch.id && "font-medium text-accent",
              )}
            >
              <span className="truncate">
                {t(`localChat.channel.${ch.id}`)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

/** Compose ContentBlock[] for an optimistic user bubble from pending state */
function buildOptimisticBlocks(
  text: string,
  atts: PendingAttachment[],
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (text.trim()) blocks.push({ kind: "text", text });
  for (const a of atts) {
    if (a.type === "image") {
      blocks.push({ kind: "image", src: a.previewUrl, mimeType: a.mimeType });
    } else {
      blocks.push({
        kind: "file",
        filename: a.filename ?? "file",
        mimeType: a.mimeType,
        size: a.size,
      });
    }
  }
  return blocks;
}

export function LocalChatPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [selectedBot, setSelectedBot] = useState<BotItem | null>(null);
  const [selectedChannel, setSelectedChannel] =
    useState<ChannelOption>(DEFAULT_CHANNEL);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([]);
  const [sending, setSending] = useState(false);
  const [waitingReply, setWaitingReply] = useState(false);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const assistantCountRef = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Tracks the current bot+channel combo so async effects can bail if stale
  const contextKeyRef = useRef<string>("");
  // True while a sendMessage call is in flight — prevents the history-load
  // effect from overwriting the optimistic bubble with stale history.
  const activeSendRef = useRef(false);
  // When loading history for the first time (or after switching bot/channel),
  // snap to the bottom instantly so the user sees the latest message without
  // watching the page scroll through the whole history.  Reset to true on
  // every bot/channel switch; set to false after the first scroll fires.
  const scrollInstantRef = useRef(true);

  // Fetch bots
  const { data: botsData, isLoading: botsLoading } = useQuery({
    queryKey: ["bots"],
    queryFn: async () => {
      const { data } = await getApiV1Bots();
      return data;
    },
  });
  const bots = (botsData?.bots ?? []) as BotItem[];
  const activeBots = bots.filter((b) => b.status === "active");

  // Auto-select when there's exactly one active bot
  useEffect(() => {
    if (activeBots.length === 1 && !selectedBot && activeBots[0]) {
      setSelectedBot(activeBots[0]);
    }
  }, [activeBots, selectedBot]);

  // Auto-scroll on new messages.
  // Uses "instant" on initial history load so the page snaps to the bottom
  // without animating through the full history; subsequent scrolls (new
  // messages, typing indicator) use "smooth" for a natural feel.
  //
  // IMPORTANT: do NOT consume the instant-scroll token when the message list
  // is still empty (the effect fires once on mount before history arrives).
  // Consuming it early would cause the history load scroll to use "smooth"
  // and scroll from top to bottom visibly.
  useEffect(() => {
    if (messages.length === 0 && !waitingReply) return;
    const behavior = scrollInstantRef.current ? "instant" : "smooth";
    scrollInstantRef.current = false;
    endRef.current?.scrollIntoView({ behavior });
  }, [messages, waitingReply]);

  // ── Polling for AI reply ──────────────────────────────────────────────────

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    setWaitingReply(false);
  }, []);

  const startPolling = useCallback(
    (botId: string, currentAssistantCount: number) => {
      stopPolling();
      assistantCountRef.current = currentAssistantCount;
      setWaitingReply(true);
      let attempts = 0;
      pollingRef.current = setInterval(async () => {
        attempts++;
        try {
          const { data } = await getApiV1ChatHistory({
            query: { botId, limit: 500 },
          });
          const latest = ((data as Record<string, unknown>)?.messages ??
            []) as ChatMsg[];
          const newAssistantCount = latest.filter(
            (m) => m.role === "assistant",
          ).length;
          if (newAssistantCount > assistantCountRef.current) {
            // Update baseline BEFORE stopping so the next send has the right count
            assistantCountRef.current = newAssistantCount;
            setMessages(latest);
            void queryClient.invalidateQueries({
              queryKey: ["sidebar-sessions"],
            });
            stopPolling();
            return;
          }
        } catch {
          // swallow polling errors
        }
        if (attempts >= POLL_MAX_ATTEMPTS) stopPolling();
      }, POLL_INTERVAL_MS);
    },
    [stopPolling, queryClient],
  );

  // Cleanup on unmount
  useEffect(() => () => stopPolling(), [stopPolling]);

  // ── Session discovery: load full history when bot/channel changes ────────
  // Calls the aggregated history endpoint which transparently spans all
  // compacted sessions — the user always sees one continuous conversation.

  useEffect(() => {
    if (!selectedBot) return;

    const botId = selectedBot.id;
    const sessionKey = buildSessionKey(botId, selectedChannel);
    const ctxKey = `${botId}::${sessionKey}`;
    contextKeyRef.current = ctxKey;

    void (async () => {
      try {
        // Load the full cross-session history immediately.
        const { data: histData } = await getApiV1ChatHistory({
          query: { botId, limit: 500 },
        });
        if (contextKeyRef.current !== ctxKey) return;
        if (activeSendRef.current) return;

        const msgs = ((histData as Record<string, unknown>)?.messages ??
          []) as ChatMsg[];
        if (msgs.length > 0) {
          setMessages(msgs);
          assistantCountRef.current = msgs.filter(
            (m) => m.role === "assistant",
          ).length;
        }

        // Also resolve the current session ID so we can use it for send flow.
        const { data: sessionData } = await getApiV1ChatSession({
          query: { botId, sessionKey },
        });
        if (contextKeyRef.current !== ctxKey) return;
        const sid = sessionData?.session?.id;
        if (sid) setSessionId(sid);
      } catch {
        // silently ignore — session simply doesn't exist yet
      }
    })();
  }, [selectedBot, selectedChannel]);

  // ── Bot / channel selection ───────────────────────────────────────────────

  const handleSelectBot = useCallback(
    (bot: BotItem) => {
      scrollInstantRef.current = true;
      setSelectedBot(bot);
      setSessionId(null);
      setMessages([]);
      setPendingAttachments([]);
      stopPolling();
    },
    [stopPolling],
  );

  const handleSelectChannel = useCallback(
    (channel: ChannelOption) => {
      scrollInstantRef.current = true;
      setSelectedChannel(channel);
      setSessionId(null);
      setMessages([]);
      setPendingAttachments([]);
      stopPolling();
    },
    [stopPolling],
  );

  // ── Attachment helpers ────────────────────────────────────────────────────

  const addAttachment = useCallback((att: Omit<PendingAttachment, "id">) => {
    setPendingAttachments((prev) => [
      ...prev,
      { ...att, id: crypto.randomUUID() },
    ]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // ── Send message ──────────────────────────────────────────────────────────

  const sendMessage = useCallback(
    async (
      msgContent: {
        type: "text" | "image" | "file";
        content: string;
        metadata?: { mimeType?: string; filename?: string; size?: number };
        // Only images go via the attachments array; file content goes in `content`.
        attachments?: Array<{
          type: "image";
          content: string;
          metadata?: { mimeType?: string; filename?: string; size?: number };
        }>;
      },
      optimisticBlocks: ContentBlock[],
    ) => {
      if (!selectedBot) return;

      const botId = selectedBot.id;
      const sessionKey = buildSessionKey(botId, selectedChannel);
      const ctxKey = `${botId}::${sessionKey}`;

      // Mark send as active BEFORE the optimistic update so the history-load
      // effect cannot overwrite the optimistic bubble if it fires concurrently.
      activeSendRef.current = true;

      // 1. Optimistic user bubble — shows immediately in the chat
      const optimisticMsg: ChatMsg = {
        id: `optimistic-${Date.now()}`,
        role: "user",
        // Store the pre-built ContentBlock[] as content so ChatBubble can render
        // images and files correctly before the real message arrives from history.
        content: optimisticBlocks,
        timestamp: Date.now(),
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, optimisticMsg]);
      setSending(true);
      // Show typing indicator straight away so the user knows the AI is working
      setWaitingReply(true);

      try {
        // 2. Fire the chat.send — this may return quickly (OpenClaw queues the
        //    message) or after the full AI round-trip, depending on version.
        await postApiV1ChatLocal({
          body: {
            botId,
            sessionKey,
            message: {
              type: msgContent.type,
              content: msgContent.content,
              metadata: msgContent.metadata,
              attachments: msgContent.attachments,
            },
          },
        });

        setSending(false);

        if (contextKeyRef.current !== ctxKey) return;

        // 3. Discover the session with retries — OpenClaw writes sessions.json
        //    asynchronously, so we poll until it appears (≤ 3 s).
        let sid = sessionId;
        if (!sid) {
          for (
            let attempt = 0;
            attempt < SESSION_DISCOVERY_MAX_ATTEMPTS;
            attempt++
          ) {
            if (attempt > 0) {
              await new Promise((r) =>
                setTimeout(r, SESSION_DISCOVERY_INTERVAL_MS),
              );
            }
            if (contextKeyRef.current !== ctxKey) return;
            try {
              const { data: sessionData } = await getApiV1ChatSession({
                query: { botId, sessionKey },
              });
              const found = sessionData?.session?.id;
              if (found) {
                sid = found;
                setSessionId(found);
                break;
              }
            } catch {
              // retry
            }
          }
        }

        if (!sid) {
          // Could not discover session — keep optimistic, drop waitingReply
          setWaitingReply(false);
          return;
        }

        // 4. Kick off polling so the optimistic bubble stays visible until the
        //    AI reply arrives.  Do NOT fetch and replace messages here — that
        //    would overwrite the optimistic with stale history because OpenClaw
        //    may not have written the new user message to disk yet.
        //    assistantCountRef.current is already up-to-date from the last
        //    history load or polling cycle, so polling will correctly detect
        //    the first new assistant message.
        startPolling(botId, assistantCountRef.current);
      } catch {
        setSending(false);
        setWaitingReply(false);
        setMessages((prev) => prev.filter((m) => m.id !== optimisticMsg.id));
      } finally {
        activeSendRef.current = false;
      }
    },
    [selectedBot, selectedChannel, sessionId, startPolling],
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    const atts = pendingAttachments;
    if ((!text && atts.length === 0) || sending || waitingReply || !selectedBot)
      return;

    setInput("");
    setPendingAttachments([]);

    const optimisticBlocks = buildOptimisticBlocks(text, atts);

    // ── Mirror mature channel-adapter pattern ────────────────────────────────
    // Images  → sent via `attachments[]` → OpenClaw normalises + MIME-sniffs
    //           → Anthropic vision content block.
    // Files   → text content folded into message body (extractFileContentFromSource
    //           equivalent); binary files get a filename/size note so the model
    //           at least knows what was attached.
    // ────────────────────────────────────────────────────────────────────────
    const imageAtts = atts.filter((a) => a.type === "image");
    const fileAtts = atts.filter((a) => a.type === "file");

    // Build enriched message text: append extracted file content / filename notes.
    let fullText = text;
    for (const f of fileAtts) {
      if (f.textContent !== undefined) {
        // Text-readable file — include content as a fenced code block
        const excerpt = f.textContent.slice(0, MAX_FILE_TEXT_CHARS);
        const truncated = f.textContent.length > MAX_FILE_TEXT_CHARS;
        fullText += `\n\n[文件: ${f.filename ?? "file"}]\n\`\`\`\n${excerpt}${truncated ? "\n…（内容过长，已截断）" : ""}\n\`\`\``;
      } else {
        // Binary file (PDF, Office, …) — model can't read content, note it
        fullText += `\n\n[附件: ${f.filename ?? "file"} (${formatBytes(f.size ?? 0)}，二进制文件，内容无法直接传递)]`;
      }
    }

    if (imageAtts.length === 0) {
      // Pure text — may include appended file content
      await sendMessage({ type: "text", content: fullText }, optimisticBlocks);
    } else if (
      imageAtts.length === 1 &&
      !fullText.trim() &&
      fileAtts.length === 0 &&
      imageAtts[0]
    ) {
      // Single image, no text, no files — legacy single-image path
      const singleImage = imageAtts[0];
      await sendMessage(
        {
          type: "image",
          content: singleImage.content, // already pure base64
          metadata: { mimeType: singleImage.mimeType },
        },
        optimisticBlocks,
      );
    } else {
      // Images + optional text (file content already folded into fullText)
      await sendMessage(
        {
          type: "text",
          content: fullText,
          attachments: imageAtts.map((a) => ({
            type: "image" as const, // only images go via the attachments array
            content: a.content, // pure base64
            metadata: {
              mimeType: a.mimeType,
              filename: a.filename,
              size: a.size,
            },
          })),
        },
        optimisticBlocks,
      );
    }
  }, [
    input,
    pendingAttachments,
    sending,
    waitingReply,
    selectedBot,
    sendMessage,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  // ── File / paste handling ─────────────────────────────────────────────────

  /**
   * Read a Blob/File and push it into pendingAttachments.
   *
   * Following the mature channel-adapter pattern:
   * - Images  → pure base64 in `content` (sent via `attachments` to model vision)
   * - Text files → pure base64 in `content` + UTF-8 text in `textContent`
   *               (text is folded into the message body, mirroring
   *                extractFileContentFromSource() in channel adapters)
   * - Other binary → pure base64 in `content`, no `textContent`
   *               (filename + size appended to message as a note)
   */
  const readFileBlob = useCallback(
    (file: File) => {
      if (file.size > MAX_FILE_BYTES) {
        // eslint-disable-next-line no-alert
        alert(
          `File "${file.name}" is too large (${formatBytes(file.size)}). Maximum allowed size is ${formatBytes(MAX_FILE_BYTES)}.`,
        );
        return;
      }
      const isImage = file.type.startsWith("image/");

      // Phase 1: read as DataURL — gives us preview URL + base64 content
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64 = extractBase64FromDataUrl(dataUrl);

        if (isImage) {
          addAttachment({
            type: "image",
            previewUrl: dataUrl,
            content: base64, // pure base64 — matches channel-adapter convention
            mimeType: file.type,
            filename: file.name,
            size: file.size,
          });
          return;
        }

        if (isTextReadable(file.type)) {
          // Phase 2 (text files only): also read as UTF-8 text
          const textReader = new FileReader();
          textReader.onload = () => {
            addAttachment({
              type: "file",
              previewUrl: dataUrl,
              content: base64,
              mimeType: file.type,
              filename: file.name,
              size: file.size,
              textContent: textReader.result as string,
            });
          };
          textReader.readAsText(file, "utf-8");
          return;
        }

        // Binary non-image file (PDF, Office, …) — no text extraction
        addAttachment({
          type: "file",
          previewUrl: dataUrl,
          content: base64,
          mimeType: file.type,
          filename: file.name,
          size: file.size,
        });
      };
      reader.readAsDataURL(file);
    },
    [addAttachment],
  );

  const handleFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      readFileBlob(file);
      e.target.value = "";
    },
    [readFileBlob],
  );

  /** Capture clipboard image paste anywhere inside the input container */
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      // Don't queue attachments while waiting for a reply or when no bot is selected
      if (!selectedBot || waitingReply) return;
      const imageItem = Array.from(e.clipboardData.items).find((i) =>
        i.type.startsWith("image/"),
      );
      if (!imageItem) return;
      e.preventDefault();
      const blob = imageItem.getAsFile();
      if (!blob) return;
      if (blob.size > MAX_FILE_BYTES) {
        alert(
          `Pasted image is too large (${formatBytes(blob.size)}). Maximum allowed size is ${formatBytes(MAX_FILE_BYTES)}.`,
        );
        return;
      }
      // Read the blob directly — no need to wrap in File constructor
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        addAttachment({
          type: "image",
          previewUrl: dataUrl,
          content: extractBase64FromDataUrl(dataUrl), // pure base64
          mimeType: blob.type || "image/png",
          filename: `pasted-image-${Date.now()}.png`,
          size: blob.size,
        });
      };
      reader.readAsDataURL(blob);
    },
    [addAttachment, selectedBot, waitingReply],
  );

  const canSend =
    !!selectedBot &&
    !sending &&
    !waitingReply &&
    (input.trim().length > 0 || pendingAttachments.length > 0);

  const placeholder = !selectedBot
    ? t("localChat.selectBotFirst")
    : waitingReply
      ? t("localChat.waiting")
      : t("localChat.inputPlaceholder");

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border px-6 py-4 md:pt-12">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[15px] font-bold text-text-heading">
              {t("localChat.title")}
            </h1>
            <p className="mt-0.5 text-[11px] text-text-muted">
              {t("localChat.subtitle")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {botsLoading ? (
              <Loader2 size={16} className="animate-spin text-text-muted" />
            ) : (
              <BotSelector
                bots={bots}
                selected={selectedBot}
                onSelect={handleSelectBot}
              />
            )}
            <ChannelSelector
              selected={selectedChannel}
              onSelect={handleSelectChannel}
            />
          </div>
        </div>
      </div>

      {/* Message list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 && !waitingReply ? (
          <div className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-3">
                <Sparkles className="h-7 w-7 text-text-muted" />
              </div>
              <div>
                <p className="text-[14px] font-medium text-text-primary">
                  {selectedBot
                    ? t("localChat.startChat", { name: selectedBot.name })
                    : t("localChat.pickBot")}
                </p>
                <p className="mt-1 text-[12px] text-text-muted">
                  {t("localChat.emptyHint")}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="px-4 py-8 sm:px-6">
            <div className="mx-auto flex w-full max-w-[920px] flex-col gap-5">
              {messages.map((msg) => (
                <ChatBubble key={msg.id} msg={msg} />
              ))}
              {waitingReply && <TypingIndicator />}
              <div ref={endRef} />
            </div>
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="shrink-0 border-t border-border bg-surface-1 px-4 py-4">
        <div className="mx-auto flex w-full max-w-[920px] items-center gap-2">
          {/* Input container: attachment tray + textarea row */}
          <div
            className="flex min-h-[44px] flex-1 flex-col rounded-2xl border border-border bg-white shadow-[0_2px_8px_rgba(15,23,42,0.04)] focus-within:border-accent/60 focus-within:shadow-[0_2px_12px_rgba(15,23,42,0.08)]"
            onPaste={handlePaste}
          >
            {pendingAttachments.length > 0 && (
              <AttachmentTray
                attachments={pendingAttachments}
                onRemove={removeAttachment}
              />
            )}
            <div className="flex items-center px-3 py-2.5">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                disabled={!selectedBot || waitingReply}
                rows={1}
                className="flex-1 resize-none bg-transparent text-[13px] text-text-primary placeholder-text-muted outline-none disabled:cursor-not-allowed"
                style={{ maxHeight: "120px", overflowY: "auto" }}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={!selectedBot || sending || waitingReply}
                className="ml-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                title={t("localChat.attachFile")}
              >
                <Paperclip size={15} />
              </button>
            </div>
          </div>

          {/* Send button */}
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={!canSend}
            className={cn(
              "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors",
              canSend
                ? "bg-accent text-white shadow-[0_4px_12px_rgba(0,0,0,0.15)] hover:bg-accent/90"
                : "bg-surface-3 text-text-muted cursor-not-allowed",
            )}
          >
            <Send size={16} />
          </button>
        </div>

        {/* Hidden file input — accepts images and common documents */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*,.pdf,.doc,.docx,.xls,.xlsx"
          className="hidden"
          onChange={handleFile}
        />
      </div>
    </div>
  );
}
