import { ArrowDownToLine, ArrowLeft, Pause, RefreshCw, RotateCcw, Send, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { StartupProgressModal } from "@/components/dialog/docker-progress-modal";
import { SessionSettings } from "@/components/session-settings";
import { TaskTree } from "@/components/task-tree";
import { CheckinTimeline } from "@/components/timeline/checkin-timeline";
import { MessageFeed } from "@/components/timeline/message-feed";
import { ToolCallCard } from "@/components/timeline/tool-call-card";
import { TokenChart } from "@/components/token-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Session, Task } from "@/lib/agent-api";
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
import { mutateCache, useQuery } from "@/lib/query-cache";
import { cacheKeys, useProjectStream, useSessionStream, useSessionStreamingState } from "@/lib/stores";
import type { Project } from "@/lib/types";
import { cn, containerClassName, formatDateTime, formatRelativeTime, formatTokens, statusBg } from "@/lib/utils";

export default function SessionPage() {
	const params = useParams<{ id: string; sessionId: string }>();
	const projectId = params.id;
	const sessionId = params.sessionId;

	const [stopping, setStopping] = useState(false);
	const [pausing, setPausing] = useState(false);
	const [restarting, setRestarting] = useState(false);
	const [chatInput, setChatInput] = useState("");
	const [sending, setSending] = useState(false);

	const chatRef = useRef<HTMLTextAreaElement>(null);

	const [viewport, setViewport] = useState<HTMLElement | null>(null);
	const [isAtBottom, setIsAtBottom] = useState(true);
	const [timelineTab, setTimelineTab] = useState("current");

	const scrollAreaRef = useCallback((node: HTMLDivElement | null) => {
		setViewport(node?.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]") ?? null);
	}, []);

	// Auto-resize textarea as user types, up to 5 lines
	// biome-ignore lint/correctness/useExhaustiveDependencies: update height every time text changes
	useEffect(() => {
		const textarea = chatRef.current;
		if (!textarea) return;

		// Reset height to auto to get the correct scrollHeight
		textarea.style.height = "auto";

		// Calculate new height (capped at 120px for ~5 lines)
		const newHeight = Math.min(textarea.scrollHeight, 120);
		textarea.style.height = `${newHeight}px`;
	}, [chatInput]);

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

	// Cache keys — built through the shared `cacheKeys` map so the store folds and
	// these reads can never disagree on a key. Shared across mounts, so navigating
	// away and back reuses what we already fetched instead of re-querying.
	const sKey = projectId && sessionId ? cacheKeys.session(projectId, sessionId) : null;
	const mKey = projectId && sessionId ? cacheKeys.messages(projectId, sessionId) : null;
	const tKey = projectId && sessionId ? cacheKeys.tools(projectId, sessionId) : null;
	const cKey = projectId && sessionId ? cacheKeys.checkins(projectId, sessionId) : null;
	const qKey = projectId && sessionId ? cacheKeys.questions(projectId, sessionId) : null;
	const xKey = projectId && sessionId ? cacheKeys.compactions(projectId, sessionId) : null;
	const tkKey = projectId ? cacheKeys.tasks(projectId) : null;
	const rKey = projectId ? cacheKeys.project(projectId) : null;

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

	// Split the message timeline into one "subsession" per compaction boundary:
	// everything before the first compaction, each stretch between two
	// compactions, and the still-active stretch since the last one. Boundaries
	// are time-based (a message belongs to the segment whose compaction
	// timestamp it precedes) since compactedOut only tells us "before the most
	// recent compaction," not which one.
	const messageSegments = useMemo(() => {
		type Segment = { key: string; label: string; sublabel: string | undefined; messages: typeof messages };
		if (compactions.length === 0) return [{ key: "current", label: "Current", sublabel: undefined, messages } satisfies Segment];
		const sorted = [...compactions].sort((a, b) => a.createdAt - b.createdAt);
		const closed: Segment[] = sorted.map((compaction, i) => ({
			key: `segment-${i}`,
			label: formatDateTime(compaction.createdAt),
			sublabel: formatRelativeTime(compaction.createdAt),
			messages: messages.filter(
				(message) => message.createdAt < compaction.createdAt && (i === 0 || message.createdAt >= sorted[i - 1].createdAt)
			),
		}));
		const current: Segment = {
			key: "current",
			label: "Current",
			sublabel: undefined,
			messages: messages.filter((message) => message.createdAt >= sorted[sorted.length - 1].createdAt),
		};
		// Most-recent-first: "Current" leftmost, then closed segments newest → oldest.
		return [current, ...closed.reverse()];
	}, [messages, compactions]);

	// Auto-switch to the "Current" segment when a new compaction arrives
	const prevCompactionsCountRef = useRef(compactions.length);
	useEffect(() => {
		if (compactions.length > prevCompactionsCountRef.current) {
			setTimelineTab("current");
		}
		prevCompactionsCountRef.current = compactions.length;
	}, [compactions.length]);

	// Reuse the shared project cache populated by the project page. If arriving
	// directly on this URL, fetch it once here; the project page's SSE stream
	// will keep it live if both pages are mounted simultaneously.
	const { data: project, refetch: refetchProject } = useQuery<Project | null>(rKey, () => getProject(projectId));
	const running = project?.dockerStatus?.running ?? false;
	const serverPort = project?.ports?.server;

	// One shared session stream while running — it owns every fold into the
	// per-session caches (messages, tools, check-ins, questions, compactions,
	// the session record) plus the ephemeral live-streaming state, and drives
	// session-scoped toasts. See stores.ts. Ref-counted, so this page and the
	// project page share connections where their keys overlap.
	useSessionStream(projectId, sessionId, running, serverPort);
	// Tasks are project-wide (cross-session), so this page also needs the
	// project stream connected to see updates made from another session or the
	// project's Tasks tab reflected live in the banner above the timeline.
	useProjectStream(projectId, running, serverPort);
	const {
		text: streamingText,
		thinking: streamingThinking,
		toolcall: streamingToolcall,
		planMode,
		tokenWarning,
	} = useSessionStreamingState(sessionId);

	async function handleStop() {
		if (!projectId || !sessionId) {
			toast.info("No session is loaded.");
			return;
		}
		setStopping(true);
		await stopSession(projectId, sessionId);
		// Don't wait on the SSE round-trip for the badge/buttons to reflect this —
		// update locally now; the eventual session_updated event is a no-op merge.
		mutateCache<Session>(cacheKeys.session(projectId, sessionId), (session) =>
			session ? { ...session, status: "aborted" } : session
		);
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
		mutateCache<Session>(cacheKeys.session(projectId, sessionId), (session) =>
			session ? { ...session, status: "running" } : session
		);
		setRestarting(false);
	}

	async function handleSendMessage() {
		if (!projectId || !sessionId) {
			toast.info("No session is loaded.");
			return;
		}

		const text = chatInput.trim();
		if (!text || sending) return;
		if (isCompacting) {
			toast.info("Agent is compacting context — please wait.");
			return;
		}
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
		} catch (err) {
			setChatInput(text);
			toast.error(err instanceof Error ? err.message : "Failed to send message.");
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
		if (!success || !text || !projectId || !sessionId) {
			if (!success && text) {
				setChatInput(text);
				toast.error("Project failed to start — message not sent.");
			}
			return;
		}
		setSending(true);
		try {
			await sendSessionMessage(projectId, sessionId, text);
		} catch (err) {
			setChatInput(text);
			toast.error(err instanceof Error ? err.message : "Failed to send message after startup.");
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
	// Input is blocked while the agent is compacting: a reply mid-compaction
	// would abort the summarization call. The user can send again as soon as
	// the status flips back to "running" (driven over SSE).
	const isCompacting = session.status === "compacting";

	// Estimate system prompt + tool definition tokens from the first message that
	// reads the cache: its cacheReadTokens is the constant system prompt + tool
	// definitions that get replayed (as cache reads) on every subsequent turn.
	const firstCacheRead = messages.find(
		(message) => (message.role === "assistant" || message.role === "system") && (message.cacheReadTokens ?? 0) > 0
	);
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
							<TaskTree tasks={tasks} active={isActive} />
						</div>
					)}
					{messageSegments.length > 1 && (
						<Tabs
							value={timelineTab}
							onValueChange={(value) => setTimelineTab(value)}
							className="shrink-0 border-b bg-background px-3 py-2 overflow-x-auto"
						>
							<TabsList>
								{messageSegments.map((segment) => (
									<TabsTrigger
										key={segment.key}
										value={segment.key}
										title={segment.key === "current" ? "Since the last compaction" : `Compacted ${segment.sublabel}`}
										className="flex-col h-auto gap-0 px-4 py-1.5"
									>
										<span className="leading-none">{segment.label}</span>
										{segment.sublabel && (
											<span className="text-[10px] font-normal leading-none text-muted-foreground">{segment.sublabel}</span>
										)}
									</TabsTrigger>
								))}
							</TabsList>
						</Tabs>
					)}
					<ScrollArea className="flex-1" ref={scrollAreaRef}>
						<MessageFeed
							messages={messageSegments.find((segment) => segment.key === timelineTab)?.messages ?? messages}
							toolCalls={toolCalls}
							sessionStatus={session.status}
							streamingText={streamingText}
							streamingThinking={streamingThinking}
							streamingToolcall={streamingToolcall}
							autoScroll={isAtBottom}
							scrollElement={viewport}
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
							className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring min-h-[38px] max-h-[120px] overflow-y-auto"
							rows={1}
							placeholder={
								!running
									? "Project is stopped — sending a message will start it… (Enter to send, Shift+Enter for newline)"
									: isCompacting
										? "Compacting context — please wait…"
										: session.status === "running" || session.status === "paused"
											? "Interrupt agent… (Enter to send, Shift+Enter for newline)"
											: "Resume session with a message… (Enter to send, Shift+Enter for newline)"
							}
							value={chatInput}
							onChange={(event) => setChatInput(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									handleSendMessage();
								}
							}}
							disabled={sending || isCompacting}
						/>
						<Button
							size="sm"
							onClick={handleSendMessage}
							disabled={!chatInput.trim() || sending || isCompacting}
							className="shrink-0 self-end"
						>
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
								{compactions.length > 0 && (
									<span className="ml-1.5 h-4 min-w-4 px-1 rounded-full bg-purple-500 text-white text-[10px] flex items-center justify-center">
										{compactions.length}
									</span>
								)}
							</TabsTrigger>
							<TabsTrigger value="settings" className="flex-1">
								Settings
							</TabsTrigger>
						</TabsList>

						<TabsContent value="summary" className="flex-1 overflow-auto p-3 mt-0">
							<div className="space-y-4">
								<Card>
									<CardContent className="pt-4 pb-3 space-y-3 text-sm">
										<div>
											<p className="text-sm text-muted-foreground mb-0.5">Session ID</p>
											<p className="font-mono text-sm break-all">{sessionId}</p>
										</div>
										<div>
											<p className="text-sm text-muted-foreground mb-0.5">Task</p>
											<p className="text-sm">{session.task}</p>
										</div>
										<div className="flex justify-between">
											<span className="text-sm text-muted-foreground">Messages</span>
											<span className="text-sm">{messages.length}</span>
										</div>
									</CardContent>
								</Card>
								<Card>
									<CardContent className="pt-4 pb-3">
										<div className="flex items-baseline justify-between">
											<p className="text-sm text-muted-foreground">Context size</p>
											<p className="text-sm font-mono">
												{formatTokens(session.contextTokens)}
												{session.compactThresholdTokens > 0 && <> / {formatTokens(session.compactThresholdTokens)}</>}
											</p>
										</div>
										{session.compactThresholdTokens > 0 && (
											<div className="mt-2 h-1.5 w-full rounded-full bg-muted">
												<div
													className="h-1.5 rounded-full bg-orange-500"
													style={{
														width: `${Math.min(100, (session.contextTokens / session.compactThresholdTokens) * 100)}%`,
													}}
												/>
											</div>
										)}
										<p className="text-[10px] text-muted-foreground mt-1">
											Live context from the last model call — auto-compaction triggers when this reaches the threshold. Input +
											output since the last compaction approximately compose it; cache rows are cumulative API billing.
										</p>
									</CardContent>
								</Card>
								<Card>
									<CardContent className="pt-4 pb-3">
										<table className="w-full text-sm">
											<thead>
												<tr className="border-b">
													<th className="text-left py-2 font-medium text-muted-foreground">Metric</th>
													<th className="text-right py-2 font-medium text-muted-foreground">Since Last Compaction</th>
													<th className="text-right py-2 font-medium text-muted-foreground">Total</th>
												</tr>
											</thead>
											<tbody>
												<tr className="border-b">
													<td className="py-2 text-muted-foreground">Input tokens</td>
													<td className="py-2 text-right font-mono">{formatTokens(session.tokensInputSinceCompaction)}</td>
													<td className="py-2 text-right font-mono">{formatTokens(session.totalInputTokens)}</td>
												</tr>
												<tr className="border-b">
													<td className="py-2 text-muted-foreground">Output tokens</td>
													<td className="py-2 text-right font-mono">{formatTokens(session.tokensOutputSinceCompaction)}</td>
													<td className="py-2 text-right font-mono">{formatTokens(session.totalOutputTokens)}</td>
												</tr>
												<tr className="border-b">
													<td className="py-2 text-muted-foreground">Cache read tokens</td>
													<td className="py-2 text-right font-mono">{formatTokens(session.tokensCacheReadSinceCompaction)}</td>
													<td className="py-2 text-right font-mono">{formatTokens(session.totalCacheReadTokens)}</td>
												</tr>
												<tr>
													<td className="py-2 text-muted-foreground">Cache write tokens</td>
													<td className="py-2 text-right font-mono">{formatTokens(session.tokensCacheWriteSinceCompaction)}</td>
													<td className="py-2 text-right font-mono">{formatTokens(session.totalCacheWriteTokens)}</td>
												</tr>
											</tbody>
										</table>
									</CardContent>
								</Card>
								{systemPromptTokens > 0 && (
									<Card>
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
											<span className="text-muted-foreground">Await reports</span>
											<span className="capitalize">{session.awaitReportMode}</span>
										</div>
										<div className="flex justify-between">
											<span className="text-muted-foreground">Ask mode</span>
											<span className="capitalize">{session.awaitAskMode}</span>
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
							<CheckinTimeline checkins={checkins} questions={questions} compactions={compactions} />
						</TabsContent>

						<TabsContent value="settings" className="flex-1 overflow-auto mt-0">
							{projectId && sessionId && <SessionSettings projectId={projectId} sessionId={sessionId} session={session} />}
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
