/**
 * Categorized error types and retry utility for the agent runner.
 */

import Anthropic from "@anthropic-ai/sdk";

// ── Error Classes ────────────────────────────────────────────────────────────

export class AgentError extends Error {
	readonly retryable: boolean;
	readonly category: string;

	constructor(message: string, category: string, retryable: boolean) {
		super(message);
		this.name = "AgentError";
		this.category = category;
		this.retryable = retryable;
	}
}

class ApiRateLimitError extends AgentError {
	readonly retryAfterMs: number;

	constructor(message: string, retryAfterMs = 5000) {
		super(message, "rate_limit", true);
		this.name = "ApiRateLimitError";
		this.retryAfterMs = retryAfterMs;
	}
}

class ApiOverloadError extends AgentError {
	constructor(message = "API overloaded") {
		super(message, "overload", true);
		this.name = "ApiOverloadError";
	}
}

class ApiAuthError extends AgentError {
	constructor(message = "Authentication failed") {
		super(message, "auth", false);
		this.name = "ApiAuthError";
	}
}

class ApiInvalidRequestError extends AgentError {
	constructor(message: string) {
		super(message, "invalid_request", false);
		this.name = "ApiInvalidRequestError";
	}
}

class NetworkError extends AgentError {
	constructor(message = "Network error") {
		super(message, "network", true);
		this.name = "NetworkError";
	}
}

/**
 * The backend process died mid-request — Bun's fetch drops the TCP socket with
 * no HTTP response and throws the literal message below. Against a self-hosted
 * backend (ANTHROPIC_BASE_URL) that means the LLM server crashed and is
 * (re)booting, which takes far longer than a network blip. Retried on the slow
 * SERVER_CRASH_RETRY budget (3-min waits) rather than the fast exponential one.
 */
class ServerCrashError extends AgentError {
	constructor(message = "LLM server crashed") {
		super(message, "server_crash", true);
		this.name = "ServerCrashError";
	}
}

// Bun raises this exact phrasing when a socket closes before any response is
// received. It appears either as the top-level error message or nested in the
// `.cause` chain when the SDK wraps it, so we scan both.
const SOCKET_CLOSED_MARKER = "socket connection was closed unexpectedly";

function messageChainIncludes(err: unknown, needle: string, depth = 0): boolean {
	if (depth > 5 || !(err instanceof Error)) return false;
	if ((err.message ?? "").toLowerCase().includes(needle)) return true;
	return messageChainIncludes((err as { cause?: unknown }).cause, needle, depth + 1);
}

// ── Error Classification ─────────────────────────────────────────────────────

export function classifyApiError(err: unknown): AgentError {
	if (err instanceof AgentError) return err;

	// Server crash (socket dropped with no response) — checked before the
	// APIConnectionError branch below because the SDK sometimes wraps this Bun
	// error as an APIConnectionError whose own message is the generic
	// "Connection error.", hiding the socket marker unless we walk `.cause`.
	// A crashed backend needs the multi-minute reboot budget, not the ~2-min
	// exponential one, so it must be classified as its own category.
	if (messageChainIncludes(err, SOCKET_CLOSED_MARKER)) {
		return new ServerCrashError(err instanceof Error ? err.message : String(err));
	}

	// The SDK's APIConnectionError/APIConnectionTimeoutError (thrown on DNS/TLS/reset/timeout
	// failures at the fetch layer) always carries the literal message "Connection error." or
	// "Request timed out." — neither contains "network" or any of the ECONN*/ETIMEDOUT substrings
	// below, and none of the SDK's APIError subclasses override `.name` (it stays "Error" for all
	// of them), so this needs an explicit instanceof check rather than string matching. Without it,
	// a transient blip falls through to the non-retryable "unknown" category and kills the session
	// instead of getting the exponential-backoff retry it's supposed to get.
	if (err instanceof Anthropic.APIConnectionError) {
		return new NetworkError(err.message);
	}

	if (err instanceof Error) {
		const msg = err.message ?? "";
		const anyErr = err as unknown as Record<string, unknown>;
		const status = (anyErr.status as number) ?? (anyErr.statusCode as number) ?? 0;

		// Rate limit (429)
		if (status === 429 || msg.includes("rate_limit") || msg.includes("Rate limit")) {
			const retryAfter = parseRetryAfter(anyErr);
			return new ApiRateLimitError(msg, retryAfter);
		}

		// Overload (529)
		if (status === 529 || msg.includes("overloaded")) {
			return new ApiOverloadError(msg);
		}

		// Auth (401, 403)
		if (status === 401 || status === 403 || msg.includes("authentication") || msg.includes("unauthorized")) {
			return new ApiAuthError(msg);
		}

		// Invalid request (400)
		if (status === 400 || msg.includes("invalid_request")) {
			return new ApiInvalidRequestError(msg);
		}

		// Network errors
		if (
			msg.includes("ECONNREFUSED") ||
			msg.includes("ECONNRESET") ||
			msg.includes("ETIMEDOUT") ||
			msg.includes("fetch failed") ||
			msg.includes("network")
		) {
			return new NetworkError(msg);
		}

		// Server errors (500, 502, 503) — retryable
		if (status >= 500 && status < 600) {
			return new AgentError(msg, "server_error", true);
		}
	}

	// Unknown error — not retryable by default
	const message = err instanceof Error ? err.message : String(err);
	return new AgentError(message, "unknown", false);
}

// ── Retry Utility ────────────────────────────────────────────────────────────

export interface RetryOptions {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
	signal?: AbortSignal;
	onRetry?: (error: AgentError, attempt: number, nextDelayMs: number, maxAttempts: number) => void;
}

/**
 * Retry budget for a crashed backend (ServerCrashError). A crashed LLM server
 * takes far longer to come back than a transient blip, so this waits a fixed
 * 5 minutes between attempts (no exponential ramp — the wait is dominated by
 * the reboot, not by backing off a busy server) and gives up after 4 retries
 * (≈20 min total) rather than the ~2-min exponential budget of LLM_CALL_RETRY.
 * Tracked on a counter separate from the normal-retry counter in withRetry so
 * a crash never eats the ordinary-blip budget and vice versa.
 */
export const SERVER_CRASH_RETRY = {
	maxRetries: 4,
	delayMs: 300_000,
} as const;

/**
 * Shared retry budget for every LLM call. Worst case ≈ 2 minutes of backoff
 * (2s, 4s, 8s, 16s, 32s, 60s) before a retryable failure is declared fatal.
 * Sized for self-hosted/proxied backends (ANTHROPIC_BASE_URL), which can be
 * unreachable or return 503 "Loading model" for tens of seconds at a time —
 * the previous ~3s budget (3 attempts, 1s base, 10s cap) made sessions die
 * exactly at the compaction boundary, where requests are heaviest and a local
 * backend is most likely to stall.
 */
export const LLM_CALL_RETRY = {
	maxAttempts: 7,
	baseDelayMs: 2000,
	maxDelayMs: 60_000,
} satisfies Pick<RetryOptions, "maxAttempts" | "baseDelayMs" | "maxDelayMs">;

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
	const { maxAttempts, baseDelayMs, maxDelayMs, signal, onRetry } = opts;

	// A crashed backend and an ordinary transient blip are counted separately: a
	// server reboot (ServerCrashError) burns the slow 3-min SERVER_CRASH_RETRY
	// budget while everything else keeps the fast exponential LLM_CALL_RETRY one.
	// Keeping the counters apart means a mid-session crash can't silently eat the
	// ordinary-retry budget (and vice versa), and each still terminates on its own
	// ceiling.
	let normalRetries = 0;
	let crashRetries = 0;

	while (true) {
		try {
			return await fn();
		} catch (rawErr) {
			// If aborted, rethrow immediately
			if (signal?.aborted) throw rawErr;

			const err = classifyApiError(rawErr);

			if (!err.retryable) throw err;

			// Server crash: fixed multi-minute wait, its own attempt ceiling.
			if (err instanceof ServerCrashError) {
				if (crashRetries >= SERVER_CRASH_RETRY.maxRetries) throw err;
				crashRetries++;
				const delay = SERVER_CRASH_RETRY.delayMs;
				onRetry?.(err, crashRetries, delay, SERVER_CRASH_RETRY.maxRetries);
				await sleepWithAbort(delay, signal);
				continue;
			}

			// Ordinary transient error: exponential backoff, shared budget.
			// maxAttempts total tries ⇒ maxAttempts - 1 retries.
			if (normalRetries >= maxAttempts - 1) throw err;
			normalRetries++;

			// Calculate delay with exponential backoff + jitter
			let delay: number;
			if (err instanceof ApiRateLimitError && err.retryAfterMs > 0) {
				delay = err.retryAfterMs;
			} else {
				delay = Math.min(baseDelayMs * 2 ** (normalRetries - 1), maxDelayMs);
				// Add jitter (±25%)
				delay = delay * (0.75 + Math.random() * 0.5);
			}

			onRetry?.(err, normalRetries, delay, maxAttempts);

			await sleepWithAbort(delay, signal);
		}
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sleep for `ms`, resolving early-and-rejecting if the signal aborts. Rejects
 * with a real AbortError (matching what AbortController/fetch throw natively) so
 * the caller's `err.name === "AbortError"` check recognizes a stop/interject
 * during the backoff wait the same way it recognizes one during the live
 * request — otherwise it falls through to the fatal-error path and a clean Stop
 * gets reported as a crash.
 */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new DOMException("Aborted", "AbortError"));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function parseRetryAfter(err: Record<string, unknown>): number {
	// Try to extract retry-after from headers or error body
	const headers = err.headers as Record<string, string> | undefined;
	const retryAfter = headers?.["retry-after"];
	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		if (!Number.isNaN(seconds)) return seconds * 1000;
	}
	return 5000; // Default 5s
}
