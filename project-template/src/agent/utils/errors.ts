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

export class ApiRateLimitError extends AgentError {
	readonly retryAfterMs: number;

	constructor(message: string, retryAfterMs = 5000) {
		super(message, "rate_limit", true);
		this.name = "ApiRateLimitError";
		this.retryAfterMs = retryAfterMs;
	}
}

export class ApiOverloadError extends AgentError {
	constructor(message = "API overloaded") {
		super(message, "overload", true);
		this.name = "ApiOverloadError";
	}
}

export class ApiAuthError extends AgentError {
	constructor(message = "Authentication failed") {
		super(message, "auth", false);
		this.name = "ApiAuthError";
	}
}

export class ApiInvalidRequestError extends AgentError {
	constructor(message: string) {
		super(message, "invalid_request", false);
		this.name = "ApiInvalidRequestError";
	}
}

export class ToolExecutionError extends AgentError {
	readonly toolName: string;

	constructor(toolName: string, message: string) {
		super(message, "tool_execution", false);
		this.name = "ToolExecutionError";
		this.toolName = toolName;
	}
}

export class CompactionError extends AgentError {
	constructor(message = "Context compaction failed") {
		super(message, "compaction", true);
		this.name = "CompactionError";
	}
}

export class NetworkError extends AgentError {
	constructor(message = "Network error") {
		super(message, "network", true);
		this.name = "NetworkError";
	}
}

// ── Error Classification ─────────────────────────────────────────────────────

export function classifyApiError(err: unknown): AgentError {
	if (err instanceof AgentError) return err;

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
	onRetry?: (error: AgentError, attempt: number, nextDelayMs: number) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
	const { maxAttempts, baseDelayMs, maxDelayMs, signal, onRetry } = opts;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (rawErr) {
			// If aborted, rethrow immediately
			if (signal?.aborted) throw rawErr;

			const err = classifyApiError(rawErr);

			// Non-retryable or last attempt — throw
			if (!err.retryable || attempt >= maxAttempts) {
				throw err;
			}

			// Calculate delay with exponential backoff + jitter
			let delay: number;
			if (err instanceof ApiRateLimitError && err.retryAfterMs > 0) {
				delay = err.retryAfterMs;
			} else {
				delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
				// Add jitter (±25%)
				delay = delay * (0.75 + Math.random() * 0.5);
			}

			onRetry?.(err, attempt, delay);

			// Wait, respecting abort signal. Reject with a real AbortError (matching
			// what AbortController/fetch throw natively) so the caller's
			// `err.name === "AbortError"` check recognizes a stop/interject during
			// the backoff wait the same way it recognizes one during the live
			// request — otherwise it falls through to the fatal-error path and a
			// clean Stop gets reported as a crash.
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => {
					clearTimeout(timeout);
					reject(new DOMException("Aborted", "AbortError"));
				};
				const timeout = setTimeout(() => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				}, delay);
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		}
	}

	// Should be unreachable
	throw new AgentError("Retry loop exhausted", "unknown", false);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
