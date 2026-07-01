// Pure TypeScript interfaces matching the agent server's DB output (camelCase).
// No Bun deps — safe to import in any environment (Next.js, browser, etc.).

export interface ProjectStats {
	sessions: number;
	messages: number;
	lastActivity: string | null;
	reports: number;
}

export interface SessionRecord {
	id: string;
	name: string | null;
	task: string;
	status: "running" | "paused" | "compacting" | "completed" | "aborted" | "error";
	reportIntervalMins: number;
	stopThresholdMins: number;
	awaitReportMode: "always" | "never" | "custom";
	awaitReportCustomRule: string | null;
	awaitAskMode: "always" | "requiredOnly" | "onReportOnly" | "never";
	compactThresholdTokens: number;
	stopThresholdTokens: number;
	alwaysImproveMode: "yes" | "no" | "custom";
	alwaysImproveScope: string | null;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	tokensInputSinceCompaction: number;
	tokensOutputSinceCompaction: number;
	tokensCacheReadSinceCompaction: number;
	tokensCacheWriteSinceCompaction: number;
	discordChannelId: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface MessageRecord {
	id: string;
	sessionId: string;
	role: "user" | "assistant" | "system";
	content: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	error: string | null;
	errorDetails: string | null;
	createdAt: number;
}

export interface ToolCallRecord {
	id: string;
	sessionId: string;
	messageId: string;
	toolName: string;
	toolUseId: string;
	input: string;
	output: string | null;
	status: "pending" | "success" | "error";
	createdAt: number;
	completedAt: number | null;
}

export interface CheckinRecord {
	id: string;
	sessionId: string;
	trigger: "timer" | "urgent" | "manual" | "completion" | "compaction";
	summary: string;
	discordMessageId: string | null;
	status: "pending" | "answered" | "skipped" | "timeout";
	createdAt: number;
	completedAt: number | null;
}

export interface QuestionRecord {
	id: string;
	sessionId: string;
	checkinId: string | null;
	text: string;
	answer: string | null;
	isUrgent: boolean;
	createdAt: number;
	answeredAt: number | null;
}

export interface ReportRecord extends CheckinRecord {
	sessionName: string | null;
	sessionTask: string;
}

export interface CompactionRecord {
	id: string;
	sessionId: string;
	messagesBefore: number;
	messagesAfter: number;
	tokensBefore: number;
	tokensAfter: number;
	thresholdTokens: number;
	summary: string;
	createdAt: number;
}
