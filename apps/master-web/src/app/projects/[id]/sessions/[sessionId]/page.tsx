"use client";

import { CheckinTimeline } from "@/components/checkin-timeline";
import { CompactionTimeline } from "@/components/compaction-timeline";
import { MessageFeed } from "@/components/message-feed";
import { TokenChart } from "@/components/token-chart";
import { ToolCallCard } from "@/components/tool-call-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	createSessionStream,
	getCheckins,
	getCompactions,
	getMessages,
	getProject,
	getQuestions,
	getSession,
	getToolCalls,
	sendSessionMessage,
	stopSession,
} from "@/lib/agent-api";
import type { Checkin, Compaction, Message, Question, Session, ToolCall } from "@/lib/agent-api";
import { getCache, mutateCache, setCache, useQuery } from "@/lib/query-cache";
import type { Project } from "@/lib/types";
import { cn, formatTokens, statusBg } from "@/lib/utils";
import { BackLink } from "@/components/back-link";
import { ArrowLeft, RefreshCw, Send, Square } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { containerClassName } from "@/lib/classes";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3100";

export default function SessionPage() {
	const params = useParams<{ id: string; sessionId: string }>();
	const router = useRouter();
	const projectId = params.id;
	const sessionId = params.sessionId;

	const [stopping, setStopping] = useState(false);
	const [chatInput, setChatInput] = useState("");
	const [sending, setSending] = useState(false);
	const chatRef = useRef<HTMLTextAreaElement>(null);

	// Cache keys — shared across mounts so navigating away and back reuses what
	// we already fetched instead of re-querying.
	const sKey = `session:${projectId}:${sessionId}`;
	const mKey = `messages:${projectId}:${sessionId}`;
	const tKey = `tools:${projectId}:${sessionId}`;
	const cKey = `checkins:${projectId}:${sessionId}`;
	const qKey = `questions:${projectId}:${sessionId}`;
	const xKey = `compactions:${projectId}:${sessionId}`;
	const rKey = `project:${projectId}`;

	// Initial loads only. Every subsequent update arrives over the SSE stream and
	// is folded into the cache below — these endpoints are never re-queried,
	// except on an explicit manual refresh (the button in the top bar).
	const { data: session, error, refetch: refetchSession } = useQuery<Session>(sKey, () => getSession(projectId, sessionId));
	const { data: messages = [], refetch: refetchMessages } = useQuery<Message[]>(mKey, () => getMessages(projectId, sessionId));
	const { data: toolCalls = [], refetch: refetchTools } = useQuery<ToolCall[]>(tKey, () => getToolCalls(projectId, sessionId));
	const { data: checkins = [], refetch: refetchCheckins } = useQuery<Checkin[]>(cKey, () => getCheckins(projectId, sessionId));
	const { data: questions = [], refetch: refetchQuestions } = useQuery<Question[]>(qKey, () =>
		getQuestions(projectId, sessionId)
	);
	const { data: compactions = [], refetch: refetchCompactions } = useQuery<Compaction[]>(xKey, () =>
		getCompactions(projectId, sessionId)
	);

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
	const { data: project } = useQuery<Project | null>(rKey, () => getProject(projectId));
	const running = project?.dockerStatus?.running ?? false;
	const serverPort = project?.ports?.server;

	useEffect(() => {
		// Only open the SSE stream against a running agent server; against a
		// stopped project the stream endpoint returns 502 and EventSource would
		// retry forever.
		if (!running || !serverPort) return;
		const es = createSessionStream(
			projectId,
			sessionId,
			(event) => {
				if (event.type === "session_updated") {
					mutateCache<Session>(sKey, (s) => (s ? { ...s, ...event.data } : s));
				} else if (event.type === "message") {
					mutateCache<Message[]>(mKey, (prev = []) => (prev.some((m) => m.id === event.data.id) ? prev : [...prev, event.data]));
				} else if (event.type === "tool_call") {
					mutateCache<ToolCall[]>(tKey, (prev = []) => {
						const idx = prev.findIndex((t) => t.id === event.data.id);
						if (idx < 0) return [...prev, event.data];
						const next = [...prev];
						next[idx] = event.data;
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
				}
			},
			serverPort
		);

		es.onopen = () => {
			refreshAll();
		};
		es.onerror = () => {
			mutateCache<Project>(rKey, (p) => (p ? { ...p, dockerStatus: { ...p.dockerStatus, running: false } } : p));
			es.close();
		};

		return () => es.close();
	}, [serverPort, projectId, sessionId, running, sKey, mKey, tKey, cKey, qKey, xKey, rKey, refreshAll]);

	async function handleStop() {
		setStopping(true);
		await stopSession(projectId, sessionId);
		setStopping(false);
	}

	async function handleSendMessage() {
		const text = chatInput.trim();
		if (!text || sending) return;
		setSending(true);
		setChatInput("");
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
					href={`/projects/${projectId}`}
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
		<div className="h-full flex flex-col">
			{/* Top bar */}
			<div className="border-b shrink-0 py-4 h-[110px]">
				<div className={containerClassName}>
					<BackLink href={`/projects/${projectId}?tab=sessions`} label="Sessions" />
					<div className="flex items-center gap-4">
						<div className="flex-1 min-w-0">
							{session.name && <p className="text-lg font-semibold truncate mb-1">{session.name}</p>}
						</div>
						<Badge className={cn("capitalize shrink-0", statusBg(session.status))}>{session.status}</Badge>
						<Button variant="secondary" size="icon" onClick={refreshAll} title="Refresh">
							<RefreshCw className="h-4 w-4" />
						</Button>
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
			<div className={cn("flex h-[calc(100vh-110px)]", containerClassName)}>
				{/* Left: message feed + chat input */}
				<div className="flex-1 flex flex-col overflow-hidden border-r">
					<ScrollArea className="flex-1">
						<MessageFeed
							messages={messages}
							toolCalls={toolCalls}
							sessionStatus={session.status}
							pendingToolCalls={toolCalls.filter((tc) => tc.status === "pending").length}
							streamingMsgId={
								// Only stream the latest message if it's from the assistant and is actually
								// the last message — not when the user has already sent a follow-up.
								session.status === "running" && messages.at(-1)?.role === "assistant"
									? messages.at(-1)!.id
									: null
							}
						/>
					</ScrollArea>
					{/* Chat input — active sessions: interrupt; inactive: resume */}
					{running !== false && (
						<div className="border-t p-3 shrink-0 flex gap-2 items-end">
							<textarea
								ref={chatRef}
								className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring min-h-[38px] max-h-[120px]"
								rows={1}
								placeholder={
									session.status === "running" || session.status === "paused" || session.status === "compacting"
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
					)}
				</div>

				{/* Right: sidebar */}
				<div className="w-[448px] shrink-0 flex flex-col overflow-hidden">
					<Tabs defaultValue="tokens" className="flex flex-col flex-1 overflow-hidden">
						<TabsList className="m-3 shrink-0">
							<TabsTrigger value="summary" className="flex-1">
								Summary
							</TabsTrigger>
							<TabsTrigger value="tokens" className="flex-1">
								Tokens
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
						</TabsContent>

						<TabsContent value="tokens" className="flex-1 overflow-auto p-3 mt-0">
							<div className="space-y-4">
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
											<span>{session.totalTimeoutMins}m</span>
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
		</div>
	);
}
