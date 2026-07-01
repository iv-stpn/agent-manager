import {
	AlertCircle,
	ArrowDownToLine,
	Bot,
	ChevronDown,
	ChevronRight,
	MessageCircle,
	Settings,
	Square,
	User,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/markdown";
import { JsonView } from "@/components/timeline/json-view";
import { ToolIconBox } from "@/components/timeline/tool-icons";
import type { Message, ToolCall } from "@/lib/agent-api";
import { cn, formatRelativeTime } from "@/lib/utils";

interface ContentBlock {
	type: string;
	text?: string;
	name?: string;
	input?: Record<string, unknown>;
	id?: string;
	tool_use_id?: string;
	content?: string | ContentBlock[];
	is_error?: boolean;
}

function parseContent(content: string | ContentBlock[]): ContentBlock[] {
	if (Array.isArray(content)) return content;
	try {
		const parsed = JSON.parse(content);
		if (Array.isArray(parsed)) return parsed;
		return [{ type: "text", text: content }];
	} catch {
		return [{ type: "text", text: content }];
	}
}

function ToolCallBubble({ name, input }: { name: string; input: Record<string, unknown> }) {
	const [open, setOpen] = useState(true);
	return (
		<div className="rounded-md border border-dashed border-border bg-muted/40 text-xs font-mono">
			<button
				type="button"
				onClick={() => setOpen((x) => !x)}
				className="flex items-center gap-2 w-full px-3 py-2 text-muted-foreground hover:text-foreground"
			>
				{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
				<ToolIconBox name={name} className="h-5 w-5" />
				<span className="font-semibold text-foreground">{name}</span>
				{!open && Boolean(input.command) && (
					<span className="truncate text-muted-foreground">{String(input.command).slice(0, 60)}</span>
				)}
			</button>
			{open && <JsonView value={input} className="px-3 pb-3" />}
		</div>
	);
}

function stringifyResult(content: string | ContentBlock[] | undefined): string {
	if (content == null) return "";
	if (typeof content === "string") return content;
	try {
		return content.map((b) => (typeof b === "string" ? b : (b.text ?? JSON.stringify(b)))).join("\n");
	} catch {
		return JSON.stringify(content);
	}
}

function ToolResultBubble({ name, content, isError }: { name: string | null; content: string; isError: boolean }) {
	const [open, setOpen] = useState(false);
	const preview = content.trim().split("\n")[0]?.slice(0, 60) ?? "";
	return (
		<div
			className={cn("rounded-md border bg-muted/30 text-xs font-mono", isError ? "border-red-400/60" : "border-emerald-400/50")}
		>
			<button
				type="button"
				onClick={() => setOpen((x) => !x)}
				className="flex items-center gap-2 w-full px-3 py-2 text-muted-foreground hover:text-foreground"
			>
				{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
				<ArrowDownToLine className={cn("h-3 w-3", isError ? "text-red-500" : "text-emerald-500")} />
				<span
					className={cn("font-semibold", isError ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400")}
				>
					{name ? `${name} response` : "Tool response"}
				</span>
				{!open && preview && <span className="truncate text-muted-foreground">{preview}</span>}
			</button>
			{open && (
				<pre className="px-3 pb-3 overflow-x-auto whitespace-pre-wrap break-all text-[11px] text-foreground/80 max-h-64">
					{content || "(empty)"}
				</pre>
			)}
		</div>
	);
}

/** Progressively reveals `text` character-by-character when `streaming` is true. */
function useStreamText(text: string, streaming: boolean) {
	const [count, setCount] = useState(() => (streaming ? 0 : text.length));

	// Reset and replay whenever the message text changes (new message assigned)
	useEffect(() => {
		if (!streaming) {
			setCount(text.length);
			return;
		}
		setCount(0);
		const id = setInterval(() => {
			setCount((c) => {
				if (c >= text.length) {
					clearInterval(id);
					return c;
				}
				// ~40 chars per frame ≈ comfortable reading speed at 60 fps
				return Math.min(c + 40, text.length);
			});
		}, 16);
		return () => clearInterval(id);
	}, [text, streaming]);

	return streaming ? text.slice(0, count) : text;
}

function StreamingTextBlock({ text, streaming, className }: { text: string; streaming: boolean; className?: string }) {
	const visible = useStreamText(text, streaming);
	const done = visible.length >= text.length;
	return (
		<div className={cn(className, !done && "streaming-cursor")}>
			<Markdown>{visible}</Markdown>
		</div>
	);
}

function MessageBubble({
	message,
	toolCallByUseId,
	isStreaming,
	isNew,
}: {
	message: Message;
	toolCallByUseId: Map<string, ToolCall>;
	isStreaming: boolean;
	isNew: boolean;
}) {
	const isAssistant = message.role === "assistant";
	const isSystem = message.role === "system";
	const blocks = parseContent(message.content);
	const hasError = Boolean(message.error);

	// Only the last text block gets the streaming cursor
	const lastTextIdx = blocks.reduce((acc, b, i) => (b.type === "text" && b.text ? i : acc), -1);

	return (
		<div
			className={cn(
				"flex gap-3 group",
				isNew && "animate-msg-in",
				isSystem ? "flex-row" : isAssistant ? "flex-row" : "flex-row-reverse"
			)}
		>
			<div
				className={cn(
					"shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs mt-1",
					isSystem
						? "bg-orange-500/20 text-orange-600 dark:text-orange-400"
						: isAssistant
							? "bg-violet-500/20 text-violet-600 dark:text-violet-400"
							: "bg-blue-500/20 text-blue-600 dark:text-blue-400"
				)}
			>
				{isSystem ? <Settings className="h-4 w-4" /> : isAssistant ? <Bot className="h-4 w-4" /> : <User className="h-4 w-4" />}
			</div>
			<div
				className={cn("flex flex-col gap-2 max-w-[85%]", isSystem ? "items-start" : isAssistant ? "items-start" : "items-end")}
			>
				{blocks.map((block, index) => {
					if (block.type === "text" && block.text) {
						return (
							<StreamingTextBlock
								key={`text-${block.text.slice(0, 20)}`}
								text={block.text}
								streaming={isStreaming && index === lastTextIdx}
								className={cn(
									"rounded-lg px-3 py-2 text-sm leading-relaxed",
									isSystem
										? "bg-orange-100 dark:bg-orange-950/30 text-orange-900 dark:text-orange-200 border border-orange-300 dark:border-orange-700"
										: isAssistant
											? "bg-muted text-foreground"
											: "bg-primary text-primary-foreground"
								)}
							/>
						);
					}
					if (block.type === "tool_use" && block.name) {
						return <ToolCallBubble key={block.id ?? `tool-${index}-${block.name}`} name={block.name} input={block.input ?? {}} />;
					}
					if (block.type === "tool_result") {
						const tc = block.tool_use_id ? toolCallByUseId.get(block.tool_use_id) : undefined;
						return (
							<ToolResultBubble
								key={`result-${block.tool_use_id ?? ""}`}
								name={tc?.toolName ?? null}
								content={stringifyResult(block.content)}
								isError={Boolean(block.is_error) || tc?.status === "error"}
							/>
						);
					}
					return null;
				})}
				{hasError && (
					<div className="rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm">
						<div className="flex items-center gap-2 text-red-600 dark:text-red-400 font-medium mb-1">
							<AlertCircle className="h-4 w-4" />
							<span>Error</span>
						</div>
						<p className="text-red-700 dark:text-red-300 text-xs">{message.error}</p>
						{message.errorDetails && (
							<details className="mt-2 text-xs text-red-600/80 dark:text-red-400/80">
								<summary className="cursor-pointer hover:text-red-600 dark:hover:text-red-300">Details</summary>
								<pre className="mt-1 whitespace-pre-wrap break-all">{message.errorDetails}</pre>
							</details>
						)}
					</div>
				)}
				<span className="text-[10px] text-muted-foreground px-1">
					<span title={new Date(message.createdAt).toLocaleString()}>{formatRelativeTime(message.createdAt)}</span>
					{message.inputTokens || message.outputTokens || message.cacheReadTokens || message.cacheWriteTokens ? (
						<>
							{" · "}
							{message.inputTokens ? `↑${message.inputTokens}` : ""}
							{message.outputTokens ? ` ↓${message.outputTokens}` : ""}
							{message.cacheReadTokens ? ` ⟳${message.cacheReadTokens}` : ""}
							{message.cacheWriteTokens ? ` ✎${message.cacheWriteTokens}` : ""}
						</>
					) : null}
				</span>
			</div>
		</div>
	);
}

// ── Status indicators ─────────────────────────────────────────────────────────

function ThinkingBubble({ label }: { label?: string }) {
	return (
		<div className="flex gap-3 items-start animate-msg-in">
			<div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-violet-500/20 mt-1">
				<Bot className="h-4 w-4 text-violet-600 dark:text-violet-400" />
			</div>
			<div className="bg-muted rounded-lg px-4 py-3 flex items-center gap-1.5 text-sm text-muted-foreground">
				<span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" style={{ animationDelay: "0ms" }} />
				<span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" style={{ animationDelay: "150ms" }} />
				<span className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" style={{ animationDelay: "300ms" }} />
				{label && <span className="ml-2">{label}</span>}
			</div>
		</div>
	);
}

/** Live extended-thinking bubble: collapsible, shows streaming reasoning text. */
function LiveThinkingBubble({ thinking }: { thinking: string }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="flex gap-3 items-start animate-msg-in">
			<div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-violet-500/20 mt-1">
				<Bot className="h-4 w-4 text-violet-600 dark:text-violet-400" />
			</div>
			<div className="bg-muted/60 border border-violet-300/40 dark:border-violet-700/40 rounded-lg text-sm max-w-[85%] overflow-hidden">
				<button
					type="button"
					onClick={() => setOpen((x) => !x)}
					className="flex items-center gap-2 w-full px-3 py-2 text-violet-600 dark:text-violet-400 hover:text-violet-700 dark:hover:text-violet-300"
				>
					{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
					<span className="flex items-center gap-1.5">
						<span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse" />
						<span className="font-medium text-xs">Thinking…</span>
					</span>
					{!open && <span className="ml-1 text-xs text-muted-foreground truncate max-w-[300px]">{thinking.slice(0, 80)}</span>}
				</button>
				{open && (
					<pre className="px-3 pb-3 text-[11px] text-muted-foreground whitespace-pre-wrap break-words leading-relaxed max-h-64 overflow-y-auto">
						{thinking}
					</pre>
				)}
			</div>
		</div>
	);
}

/** Live tool call bubble: shows the tool name and streaming JSON input. */
function LiveToolCallBubble({ name, inputDelta }: { name: string; inputDelta: string }) {
	return (
		<div className="flex gap-3 items-start animate-msg-in">
			<div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-violet-500/20 mt-1">
				<Bot className="h-4 w-4 text-violet-600 dark:text-violet-400" />
			</div>
			<div className="rounded-md border border-dashed border-border bg-muted/40 text-xs font-mono max-w-[85%]">
				<div className="flex items-center gap-2 px-3 py-2 text-muted-foreground">
					<span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
					<ToolIconBox name={name} className="h-5 w-5" />
					<span className="font-semibold text-foreground">{name}</span>
				</div>
				{inputDelta && (
					<pre className="px-3 pb-3 text-[11px] text-foreground/70 whitespace-pre-wrap break-all max-h-32 overflow-y-auto streaming-cursor">
						{inputDelta}
					</pre>
				)}
			</div>
		</div>
	);
}

function AwaitingAnswerBubble() {
	return (
		<div className="flex gap-3 items-start animate-msg-in">
			<div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-amber-500/20 mt-1">
				<MessageCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
			</div>
			<div className="bg-amber-500/10 border border-amber-400/40 rounded-lg px-4 py-3 text-sm text-amber-700 dark:text-amber-300 flex items-center gap-2">
				<span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse shrink-0" />
				Await user answers
			</div>
		</div>
	);
}

/** Neutral (non-error) notice shown when a session was intentionally stopped —
 * distinct from the red per-message error box, which is reserved for actual
 * agent/API failures. */
function AbortedBubble() {
	return (
		<div className="flex gap-3 items-start animate-msg-in">
			<div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-gray-500/15 mt-1">
				<Square className="h-3.5 w-3.5 text-gray-600 dark:text-gray-400" />
			</div>
			<div className="bg-gray-500/10 border border-gray-400/30 rounded-lg px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
				Request aborted by user.
			</div>
		</div>
	);
}

// ── Public component ──────────────────────────────────────────────────────────

interface Props {
	messages: Message[];
	toolCalls: ToolCall[];
	sessionStatus?: string;
	pendingToolCalls?: number;
	streamingText?: string;
	streamingThinking?: string;
	streamingToolcall?: { name: string; inputDelta: string } | null;
	autoScroll?: boolean;
}

export function MessageFeed({
	messages,
	toolCalls,
	sessionStatus,
	pendingToolCalls = 0,
	streamingText = "",
	streamingThinking = "",
	streamingToolcall = null,
	autoScroll = true,
}: Props) {
	const bottomRef = useRef<HTMLDivElement>(null);

	// Track which message IDs are "new" so we can apply entrance animation
	const prevIdsRef = useRef(new Set(messages.map((m) => m.id)));
	const [newIds, setNewIds] = useState<Set<string>>(new Set());

	useEffect(() => {
		const incoming = messages.filter((m) => !prevIdsRef.current.has(m.id));
		if (incoming.length > 0) {
			const ids = new Set(incoming.map((m) => m.id));
			setNewIds(ids);
			for (const m of incoming) prevIdsRef.current.add(m.id);
			const t = setTimeout(() => setNewIds(new Set()), 600);
			return () => clearTimeout(t);
		}
	}, [messages]);

	// Index tool calls by their tool_use_id
	const toolCallByUseId = new Map<string, ToolCall>();
	for (const tc of toolCalls) toolCallByUseId.set(tc.toolUseId, tc);

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-run when messages array grows or streaming text arrives
	useEffect(() => {
		if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages.length, sessionStatus, streamingText, autoScroll]);

	const isRunning = sessionStatus === "running";
	const isPaused = sessionStatus === "paused";
	const isCompacting = sessionStatus === "compacting";
	const isAborted = sessionStatus === "aborted";
	// A pending ask_user_question call means the agent is blocked waiting for the
	// user's answer (the handler awaits Discord without flipping status to paused),
	// so prefer the awaiting-answer bubble over the generic "Running N tools" one.
	const awaitingAnswer = toolCalls.some((tc) => tc.status === "pending" && tc.toolName === "ask_user_question");

	if (messages.length === 0 && !isRunning && !isPaused && !isCompacting && !isAborted) {
		return (
			<div className="flex items-center justify-center h-full text-sm text-muted-foreground">Waiting for agent to start...</div>
		);
	}

	return (
		<div className="flex flex-col gap-4 p-4">
			{messages.map((msg) => (
				<MessageBubble
					key={msg.id}
					message={msg}
					toolCallByUseId={toolCallByUseId}
					isStreaming={false}
					isNew={newIds.has(msg.id)}
				/>
			))}

			{/* Live streaming text from the assistant */}
			{isRunning && streamingText && (
				<div className="flex gap-3 group">
					<div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-violet-500/20 text-violet-600 dark:text-violet-400 mt-1">
						<Bot className="h-4 w-4" />
					</div>
					<div className="bg-muted rounded-lg px-3 py-2 text-sm leading-relaxed max-w-[85%] streaming-cursor">
						<Markdown>{streamingText}</Markdown>
					</div>
				</div>
			)}
			{/* Live streaming tool call being constructed */}
			{isRunning && !streamingText && streamingToolcall && (
				<LiveToolCallBubble name={streamingToolcall.name} inputDelta={streamingToolcall.inputDelta} />
			)}
			{/* Live extended-thinking text */}
			{isRunning && !streamingText && !streamingToolcall && streamingThinking && (
				<LiveThinkingBubble thinking={streamingThinking} />
			)}
			{/* Fallback status bubbles when no streaming content */}
			{isRunning && !streamingText && !streamingToolcall && !streamingThinking && !awaitingAnswer && pendingToolCalls > 0 && (
				<ThinkingBubble label={`Running ${pendingToolCalls} tool${pendingToolCalls > 1 ? "s" : ""}…`} />
			)}
			{isRunning && !streamingText && !streamingToolcall && !streamingThinking && !awaitingAnswer && pendingToolCalls === 0 && <ThinkingBubble />}
			{(isPaused || awaitingAnswer) && <AwaitingAnswerBubble />}
			{isCompacting && <ThinkingBubble label="Compacting context…" />}
			{isAborted && <AbortedBubble />}

			<div ref={bottomRef} />
		</div>
	);
}
