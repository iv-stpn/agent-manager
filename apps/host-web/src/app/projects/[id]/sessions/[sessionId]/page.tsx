import { createSessionStream } from "@agent-manager/utils";
import { ArrowDownToLine, ArrowLeft, Pause, RefreshCw, RotateCcw, Send, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { StartupProgressModal } from "@/components/dialog/docker-progress-modal";
import { TaskTree } from "@/components/task-tree";
import { CheckinTimeline } from "@/components/timeline/checkin-timeline";
import { CompactionTimeline } from "@/components/timeline/compaction-timeline";
import { MessageFeed } from "@/components/timeline/message-feed";
import { ToolCallCard } from "@/components/timeline/tool-call-card";
import { TokenChart } from "@/components/token-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Checkin, Compaction, Message, Question, Session, Task, ToolCall } from "@/lib/agent-api";
import {
	getCheckins,
	getCompactions,
	getMessages,
	getProject,
	getQuestions,
	getSession,
	getTasks,
	getToolCalls,
	pauseSession,
	restartSession,
	sendSessionMessage,
	stopSession,
} from "@/lib/agent-api";
import { containerClassName } from "@/lib/classes";
import { mutateCache, useQuery } from "@/lib/query-cache";
import type { Project } from "@/lib/types";
import { cn, formatTokens, statusBg } from "@/lib/utils";

export default function SessionPage() {
	const params = useParams<{ id: string; sessionId: string }>();
	const projectId = params.id;
	const sessionId = params.sessionId;

	const [stopping, setStopping] = useState(false);
	const [pausing, setPausing] = useState(false);
	const [restarting, setRestarting] = useState(false);
	const [chatInput, setChatInput] = useState("");
	const [sending, setSending] = useState(false);
	const [streamingText, setStreamingText] = useState("");
	const [streamingThinking, setStreamingThinking] = useState("");
	const [streamingToolcall, setStreamingToolcall] = useState<{ name: string; inputDelta: string } | null>(null);
	const [planMode, setPlanMode] = useState(false);
	const [tokenWarning, setTokenWarning] = useState<{
		state: string;
		estimatedTokens: number;
		threshold: number;
		contextWindow: number;
	} | null>(null);
	const chatRef = useRef<HTMLTextAreaElement>(null);
	const [viewport, setViewport] = useState<HTMLElement | null>(null);
	const [isAtBottom, setIsAtBottom] = useState(true);
	const scrollAreaRef = useCallback((node: HTMLDivElement | null) => {
		setViewport(node?.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]") ?? null);
	}, []);

	useEffect(() => {
		if (!viewport) return;
		const handleScroll = () => {
			const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
			setIsAtBottom(distanceFromBottom < 80);
		};
		handleScroll();
		viewport.addEventListener("scroll", handleScroll);
		return () => viewport.removeEventListener("scroll", handleScroll);
	}, [viewport]);

	function scrollToBottom() {
		viewport?.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
	}

	// When the project is stopped, sending a message starts it first (via the
	// startup progress modal) and the message is delivered once startup succeeds.
	const [progressOpen, setProgressOpen] = useState(false);
	const pendingMessageRef = useRef<string | null>(null);

	// Cache keys — shared across mounts so navigating away and back reuses what
	// we already fetched instead of re-querying.
	const sKey = `session:${projectId}:${sessionId}`;
	const mKey = `messages:${projectId}:${sessionId}`;
	const tKey = `tools:${projectId}:${sessionId}`;
	const cKey = `checkins:${projectId}:${sessionId}`;
	const qKey = `questions:${projectId}:${sessionId}`;
	const xKey = `compactions:${projectId}:${sessionId}`;
	const tkKey = `tasks:${projectId}`;
	const rKey = `project:${projectId}`;

	function wrapQueryList<T>(
		fn: (projectId: string, sessionId: string) => Promise<T[]>,
		projectId?: string,
		sessionId?: string
	): () => Promise<T[]> {
		return async () => (projectId && sessionId ? await fn(projectId, sessionId) : []);
	}

	function wrapQueryNull<T>(
		fn: (projectId: string, sessionId: string) => Promise<T>,
		projectId?: string,
		sessionId?: string
	): () => Promise<T | null> {
		return async () => (projectId && sessionId ? await fn(projectId, sessionId) : null);
	}

	// Initial loads only. Every subsequent update arrives over the SSE stream and
	// is folded into the cache below — these endpoints are never re-queried,
	// except on an explicit manual refresh (the button in the top bar).
	const { data: session, error, refetch: refetchSession } = useQuery(sKey, wrapQueryNull(getSession, projectId, sessionId));
	const { data: messages = [], refetch: refetchMessages } = useQuery(mKey, wrapQueryList(getMessages, projectId, sessionId));
	const { data: toolCalls = [], refetch: refetchTools } = useQuery(tKey, wrapQueryList(getToolCalls, projectId, sessionId));
	const { data: checkins = [], refetch: refetchCheckins } = useQuery(cKey, wrapQueryList(getCheckins, projectId, sessionId));
	const { data: questions = [], refetch: refetchQuestions } = useQuery(qKey, wrapQueryList(getQuestions, projectId, sessionId));
	const { data: compactions = [], refetch: refetchCompactions } = useQuery(
		xKey,
		wrapQueryList(getCompactions, projectId, sessionId)
	);
	const { data: tasks = [] } = useQuery<Task[]>(tkKey, async () => (projectId ? await getTasks(projectId) : []));

	// A pending pause clears itself once the session actually stops (status
	// leaves the active set) — there's no separate confirmation event, the
	// agent finishes its in-flight message asynchronously before that happens.
	useEffect(() => {
		const active = session?.status === "running" || session?.status === "paused" || session?.status === "compacting";
		if (!active) setPausing(false);
	}, [session?.status]);

	const refreshAll = useCallback(() => {
		refetchSession();
		refetchMessages();
		refetchTools();
		refetchCheckins();
		refetchQuestions();
		refetchCompactions();
	}, [refetchSession, refetchMessages, refetchTools, refetchCheckins, refetchQuestions, refetchCompactions]);

	// Reuse the shared project cache populated by the project page. If arriving
	// directly on this URL, fetch it once here; the project page's SSE stream
	// will keep it live if both pages are mounted simultaneously.
	const { data: project, refetch: refetchProject } = useQuery<Project | null>(rKey, () => getProject(projectId));
	const running = project?.dockerStatus?.running ?? false;
	const serverPort = project?.ports?.server;

	useEffect(() => {
		// Only open the SSE stream against a running agent server; against a
		// stopped project the stream endpoint returns 502 and EventSource would
		// retry forever.
		if (!running || !serverPort || !sessionId) return;
		const es = createSessionStream(
			sessionId,
			(event) => {
				if (event.type === "turn_start") {
					// New LLM turn beginning — clear all live streaming state
					setStreamingThinking("");
					setStreamingToolcall(null);
				} else if (event.type === "text_delta") {
					setStreamingText((prev) => prev + event.data.text);
				} else if (event.type === "thinking_delta") {
					setStreamingThinking((prev) => prev + event.data.thinking);
				} else if (event.type === "toolcall_start") {
					setStreamingToolcall({ name: event.data.name, inputDelta: "" });
				} else if (event.type === "toolcall_delta") {
					setStreamingToolcall((prev) => (prev ? { ...prev, inputDelta: prev.inputDelta + event.data.inputDelta } : prev));
				} else if (event.type === "session_updated") {
					mutateCache<Session>(sKey, (s) => (s ? { ...s, ...event.data } : s));
				} else if (event.type === "message") {
					if ((event.data as { role?: string }).role === "assistant") {
						setStreamingText("");
						setStreamingThinking("");
						setStreamingToolcall(null);
					}
					mutateCache<Message[]>(mKey, (prev = []) => (prev.some((m) => m.id === event.data.id) ? prev : [...prev, event.data]));
				} else if (event.type === "tool_call") {
					mutateCache<ToolCall[]>(tKey, (prev = []) => {
						const idx = prev.findIndex((t) => t.id === event.data.id);
						if (idx < 0) return [...prev, event.data];
						const next = [...prev];
						next[idx] = { ...next[idx], ...event.data };
						return next;
					});
				} else if (event.type === "token_update") {
					// The event already carries the running totals — merge them in
					// directly instead of re-fetching the whole session.
					mutateCache<Session>(sKey, (s) =>
						s
							? {
									...s,
									totalInputTokens: event.data.totalInputTokens,
									totalOutputTokens: event.data.totalOutputTokens,
									totalCacheReadTokens: event.data.totalCacheReadTokens,
									totalCacheWriteTokens: event.data.totalCacheWriteTokens,
								}
							: s
					);
				} else if (event.type === "checkin_started" || event.type === "checkin_completed") {
					// The check-in payload carries the record (and, on start, its
					// pending questions; on completion, the answers). Fold it into the
					// cache rather than re-fetching every check-in and question.
					const payload = event.data;
					mutateCache<Checkin[]>(cKey, (prev = []) => {
						const idx = prev.findIndex((c) => c.id === payload.id);
						if (idx < 0) return [...prev, payload];
						const next = [...prev];
						next[idx] = { ...next[idx], ...payload };
						return next;
					});
					if ("questions" in payload && payload.questions?.length) {
						mutateCache<Question[]>(qKey, (prev = []) => {
							const byId = new Map(prev.map((q) => [q.id, q]));
							for (const q of payload.questions) byId.set(q.id, { ...byId.get(q.id), ...q });
							return [...byId.values()];
						});
					}
				} else if (event.type === "compaction") {
					// A context compaction fired (token threshold reached). Append it to
					// the Compactions timeline — separate from check-ins.
					mutateCache<Compaction[]>(xKey, (prev = []) =>
						prev.some((c) => c.id === event.data.id) ? prev : [...prev, event.data]
					);
				} else if (event.type === "plan_mode") {
					setPlanMode(event.data.active);
					if (event.data.active) {
						toast.info("Agent entered plan mode (read-only)");
					} else {
						toast.success("Agent exited plan mode");
					}
				} else if (event.type === "token_warning") {
					setTokenWarning(event.data);
					if (event.data.state === "warning") {
						toast.warning(
							`Context reaching capacity (${Math.round((event.data.estimatedTokens / event.data.contextWindow) * 100)}%)`
						);
					} else if (event.data.state === "error") {
						toast.error("Context near limit — auto-compacting");
					} else if (event.data.state === "blocking") {
						toast.error("Context at maximum capacity");
					}
				} else if (event.type === "error_recovered") {
					toast.info(
						`API retry #${event.data.attempt}: ${event.data.error} (retrying in ${Math.round(event.data.nextRetryMs / 1000)}s)`
					);
				}
			},
			serverPort
		);

		es.onopen = () => {
			refreshAll();
		};
		es.onerror = () => {
			// The browser auto-reconnects on a transient drop (readyState goes back
			// to CONNECTING). Only treat this as "the project stopped" once the
			// browser itself has given up (CLOSED) — otherwise closing here would
			// permanently kill the stream on a one-off blip, with no way back short
			// of a full page reload.
			if (es.readyState === EventSource.CLOSED) {
				mutateCache<Project>(rKey, (p) => (p ? { ...p, dockerStatus: { ...p.dockerStatus, running: false } } : p));
			}
		};

		return () => es.close();
	}, [serverPort, sessionId, running, sKey, mKey, tKey, cKey, qKey, xKey, rKey, refreshAll]);

	async function handleStop() {
		if (!projectId || !sessionId) {
			toast.info("No session is loaded.");
			return;
		}
		setStopping(true);
		await stopSession(projectId, sessionId);
		// Don't wait on the SSE round-trip for the badge/buttons to reflect this —
		// update locally now; the eventual session_updated event is a no-op merge.
		mutateCache<Session>(sKey, (s) => (s ? { ...s, status: "aborted" } : s));
		setStopping(false);
	}

	async function handlePause() {
		if (!projectId || !sessionId) {
			toast.info("No session is loaded.");
			return;
		}
		setPausing(true);
		await pauseSession(projectId, sessionId);
		toast.info("Agent will stop after its current message");
		// No optimistic status update here — the agent is still actively running
		// until it finishes its in-flight message; `pausing` resets itself (see
		// the effect above) once the session_updated event reports it stopped.
	}

	async function handleRestart() {
		if (!projectId || !sessionId) {
			toast.info("No session is loaded.");
			return;
		}
		setRestarting(true);
		await restartSession(projectId, sessionId);
		mutateCache<Session>(sKey, (s) => (s ? { ...s, status: "running" } : s));
		setRestarting(false);
	}

	async function handleSendMessage() {
		if (!projectId || !sessionId) {
			toast.info("No session is loaded.");
			return;
		}

		const text = chatInput.trim();
		if (!text || sending) return;
		setChatInput("");

		if (!running) {
			// Project is stopped — start it first, then deliver the message once
			// startup succeeds (see handleStartupComplete).
			pendingMessageRef.current = text;
			setProgressOpen(true);
			return;
		}

		setSending(true);
		try {
			await sendSessionMessage(projectId, sessionId, text);
		} finally {
			setSending(false);
			chatRef.current?.focus();
		}
	}

	async function handleStartupComplete(success: boolean) {
		setProgressOpen(false);
		refetchProject();
		const text = pendingMessageRef.current;
		pendingMessageRef.current = null;
		if (!success || !text || !projectId || !sessionId) return;
		setSending(true);
		try {
			await sendSessionMessage(projectId, sessionId, text);
		} finally {
			setSending(false);
			chatRef.current?.focus();
		}
	}

	if (error && !session) {
		return (
			<div className="flex flex-col items-center justify-center min-h-[60vh] gap-3">
				<p className="text-sm text-red-600">{error.message}</p>
				<p className="text-xs text-muted-foreground">
					Could not load this session. It may not exist, or the project database is unavailable.
				</p>
				<Link
					to={`/projects/${projectId}`}
					className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
				>
					<ArrowLeft className="h-4 w-4" />
					Back to project
				</Link>
			</div>
		);
	}

	if (!session) {
		return <div className="flex items-center justify-center min-h-[60vh] text-sm text-muted-foreground">Loading...</div>;
	}

	const isActive = session.status === "running" || session.status === "paused" || session.status === "compacting";

	// Estimate system prompt + tool definition tokens from the first message that
	// reads the cache: its cacheReadTokens is the constant system prompt + tool
	// definitions that get replayed (as cache reads) on every subsequent turn.
	const firstCacheRead = messages.find((m) => (m.role === "assistant" || m.role === "system") && (m.cacheReadTokens ?? 0) > 0);
	const systemPromptTokens = firstCacheRead?.cacheReadTokens ?? 0;

	return (
		<div className="h-full flex flex-col  overflow-x-hidden">
			{/* Top bar */}
			<div className="border-b shrink-0 py-4 h-[72px]">
				<div className={containerClassName}>
					<div className="flex items-center gap-4">
						<div className="flex-1 min-w-0">
							{session.name && <p className="text-lg font-semibold truncate mb-1">{session.name}</p>}
						</div>
						<Badge className={cn("capitalize shrink-0", statusBg(session.status))}>{session.status}</Badge>
						{(session.status === "error" || session.status === "aborted") && (
							<Button variant="outline" size="sm" onClick={handleRestart} disabled={restarting}>
								<RotateCcw className="h-3 w-3" />
								{restarting ? "Restarting..." : "Restart"}
							</Button>
						)}
						{planMode && (
							<Badge className="shrink-0 bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">📋 Plan Mode</Badge>
						)}
						{tokenWarning && tokenWarning.state !== "normal" && (
							<Badge
								className={cn(
									"shrink-0",
									tokenWarning.state === "warning" && "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
									tokenWarning.state === "error" && "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
									tokenWarning.state === "blocking" && "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
								)}
							>
								{tokenWarning.state === "warning" && "⚠️"}
								{tokenWarning.state === "error" && "🔴"}
								{tokenWarning.state === "blocking" && "🛑"}{" "}
								{Math.round((tokenWarning.estimatedTokens / tokenWarning.contextWindow) * 100)}% context
							</Badge>
						)}
						<Button variant="secondary" size="icon" onClick={refreshAll} title="Refresh">
							<RefreshCw className="h-4 w-4" />
						</Button>
						{isActive && (
							<Button
								variant="outline"
								size="sm"
								onClick={handlePause}
								disabled={pausing || stopping}
								title="Stop the agent after it finishes its current message"
							>
								<Pause className="h-3 w-3" />
								{pausing ? "Pausing..." : "Pause"}
							</Button>
						)}
						{isActive && (
							<Button variant="destructive" size="sm" onClick={handleStop} disabled={stopping}>
								<Square className="h-3 w-3" />
								{stopping ? "Stopping..." : "Stop"}
							</Button>
						)}
					</div>
				</div>
			</div>

			{/* Main layout */}
			<div className={cn("flex h-[calc(100vh-72px)]", containerClassName)}>
				{/* Left: message feed + chat input */}
				<div className="flex-1 flex flex-col overflow-hidden border-r">
					{tasks.length > 0 && (
						<div className="shrink-0 border-b bg-background px-4 py-2 max-h-[30vh] overflow-y-auto">
							<TaskTree tasks={tasks} />
						</div>
					)}
					<ScrollArea className="flex-1" ref={scrollAreaRef}>
						<MessageFeed
							messages={messages}
							toolCalls={toolCalls}
							sessionStatus={session.status}
							pendingToolCalls={toolCalls.filter((tc) => tc.status === "pending").length}
							streamingText={streamingText}
							streamingThinking={streamingThinking}
							streamingToolcall={streamingToolcall}
							autoScroll={isAtBottom}
						/>
					</ScrollArea>
					{/* Chat input — always visible: interrupt while active, resume when idle,
					    or start the project when stopped */}
					<div className="border-t p-3 shrink-0 relative flex gap-2 items-end">
						{!isAtBottom && (
							<Button
								variant="secondary"
								size="icon"
								onClick={scrollToBottom}
								title="Scroll to bottom"
								className="absolute -top-12 right-6 shadow-md"
							>
								<ArrowDownToLine className="h-4 w-4" />
							</Button>
						)}
						<textarea
							ref={chatRef}
							className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring min-h-[38px] max-h-[120px]"
							rows={1}
							placeholder={
								!running
									? "Project is stopped — sending a message will start it… (⌘↵ to send)"
									: session.status === "running" || session.status === "paused" || session.status === "compacting"
										? "Interrupt agent… (⌘↵ to send)"
										: "Resume session with a message… (⌘↵ to send)"
							}
							value={chatInput}
							onChange={(e) => setChatInput(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
									e.preventDefault();
									handleSendMessage();
								}
							}}
							disabled={sending}
						/>
						<Button size="sm" onClick={handleSendMessage} disabled={!chatInput.trim() || sending} className="shrink-0 self-end">
							<Send className="h-3 w-3" />
						</Button>
					</div>
				</div>

				{/* Right: sidebar */}
				<div className="w-[448px] shrink-0 flex flex-col overflow-hidden">
					<Tabs defaultValue="summary" className="flex flex-col flex-1 overflow-hidden">
						<TabsList className="m-3 shrink-0">
							<TabsTrigger value="summary" className="flex-1">
								Summary
							</TabsTrigger>
							<TabsTrigger value="tools" className="flex-1">
								Tools
								{toolCalls.filter((tc) => tc.status === "pending").length > 0 && (
									<span className="ml-1.5 h-4 w-4 rounded-full bg-yellow-500 text-white text-[10px] flex items-center justify-center">
										{toolCalls.filter((tc) => tc.status === "pending").length}
									</span>
								)}
							</TabsTrigger>
							<TabsTrigger value="checkins" className="flex-1">
								Check-ins
							</TabsTrigger>
							<TabsTrigger value="compactions" className="flex-1">
								Compactions
								{compactions.length > 0 && (
									<span className="ml-1.5 h-4 min-w-4 px-1 rounded-full bg-purple-500 text-white text-[10px] flex items-center justify-center">
										{compactions.length}
									</span>
								)}
							</TabsTrigger>
						</TabsList>

						<TabsContent value="summary" className="flex-1 overflow-auto p-3 mt-0">
							<div className="space-y-4">
								<Card>
									<CardContent className="pt-4 pb-3 space-y-3 text-sm">
										<div>
											<p className="text-xs text-muted-foreground mb-0.5">Session ID</p>
											<p className="font-mono text-xs break-all">{sessionId}</p>
										</div>
										<div>
											<p className="text-xs text-muted-foreground mb-0.5">Task</p>
											<p>{session.task}</p>
										</div>
										<div className="flex justify-between">
											<span className="text-muted-foreground">Messages</span>
											<span>{messages.length}</span>
										</div>
									</CardContent>
								</Card>
								<div className="grid grid-cols-2 gap-3">
									<Card>
										<CardContent className="pt-4 pb-3">
											<p className="text-xs text-muted-foreground">Input tokens</p>
											<p className="text-xl font-bold text-indigo-500">{formatTokens(session.totalInputTokens)}</p>
										</CardContent>
									</Card>
									<Card>
										<CardContent className="pt-4 pb-3">
											<p className="text-xs text-muted-foreground">Output tokens</p>
											<p className="text-xl font-bold text-green-500">{formatTokens(session.totalOutputTokens)}</p>
										</CardContent>
									</Card>
									<Card>
										<CardContent className="pt-4 pb-3">
											<p className="text-xs text-muted-foreground">Cache read tokens</p>
											<p className="text-xl font-bold text-amber-500">{formatTokens(session.totalCacheReadTokens)}</p>
										</CardContent>
									</Card>
									<Card>
										<CardContent className="pt-4 pb-3">
											<p className="text-xs text-muted-foreground">Cache write tokens</p>
											<p className="text-xl font-bold text-sky-500">{formatTokens(session.totalCacheWriteTokens)}</p>
										</CardContent>
									</Card>
									{systemPromptTokens > 0 && (
										<Card className="col-span-2">
											<CardContent className="pt-4 pb-3">
												<p className="text-xs text-muted-foreground">System prompt + tools</p>
												<p className="text-xl font-bold text-orange-500">{formatTokens(systemPromptTokens)}</p>
												<p className="text-[10px] text-muted-foreground mt-1">
													Replayed as cache read every turn · {formatTokens(systemPromptTokens)} of each turn's cache read is this
													constant overhead
												</p>
											</CardContent>
										</Card>
									)}
								</div>
								<Card>
									<CardHeader className="pb-2 pt-4">
										<CardTitle className="text-sm">Token usage over time</CardTitle>
									</CardHeader>
									<CardContent className="pb-4">
										<TokenChart messages={messages} />
									</CardContent>
								</Card>
								<Card>
									<CardContent className="pt-4 pb-3 space-y-1 text-sm">
										<div className="flex justify-between">
											<span className="text-muted-foreground">Report interval</span>
											<span>{session.reportIntervalMins}m</span>
										</div>
										<div className="flex justify-between">
											<span className="text-muted-foreground">Total timeout</span>
											<span>{session.stopThresholdMins}m</span>
										</div>
										<div className="flex justify-between">
											<span className="text-muted-foreground">Freeze reports</span>
											<span className="capitalize">{session.freezeReportMode}</span>
										</div>
										<div className="flex justify-between">
											<span className="text-muted-foreground">Ask mode</span>
											<span className="capitalize">{session.freezeAskMode}</span>
										</div>
										<div className="flex justify-between">
											<span className="text-muted-foreground">Always improve</span>
											<span className="capitalize">{session.alwaysImproveMode}</span>
										</div>
										<div className="flex justify-between">
											<span className="text-muted-foreground">Compact at</span>
											<span>
												{session.compactThresholdTokens === 0
													? "off"
													: `${(session.compactThresholdTokens / 1000).toFixed(0)}k tok`}
											</span>
										</div>
										<div className="flex justify-between">
											<span className="text-muted-foreground">Stop at</span>
											<span>
												{session.stopThresholdTokens === 0 ? "off" : `${(session.stopThresholdTokens / 1000).toFixed(0)}k tok`}
											</span>
										</div>
										<div className="flex justify-between">
											<span className="text-muted-foreground">Tool calls</span>
											<span>{toolCalls.length}</span>
										</div>
										<div className="flex justify-between">
											<span className="text-muted-foreground">Check-ins</span>
											<span>{checkins.length}</span>
										</div>
										<div className="flex justify-between">
											<span className="text-muted-foreground">Compactions</span>
											<span>{compactions.length}</span>
										</div>
									</CardContent>
								</Card>
							</div>
						</TabsContent>

						<TabsContent value="tools" className="flex-1 overflow-auto px-3 pb-3 mt-0">
							<div className="space-y-2">
								{toolCalls.length === 0 ? (
									<p className="text-sm text-muted-foreground text-center py-8">No tool calls yet</p>
								) : (
									[...toolCalls].reverse().map((tc) => <ToolCallCard key={tc.id} tc={tc} />)
								)}
							</div>
						</TabsContent>

						<TabsContent value="checkins" className="flex-1 overflow-auto px-3 pb-3 mt-0">
							<CheckinTimeline checkins={checkins} questions={questions} />
						</TabsContent>

						<TabsContent value="compactions" className="flex-1 overflow-auto px-3 pb-3 mt-0">
							<CompactionTimeline compactions={compactions} />
						</TabsContent>
					</Tabs>
				</div>
			</div>

			{projectId && (
				<StartupProgressModal
					open={progressOpen}
					onOpenChange={setProgressOpen}
					projectId={projectId}
					action="start"
					onComplete={handleStartupComplete}
				/>
			)}
		</div>
	);
}
