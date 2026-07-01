/**
 * Fine-grained token budget management.
 * Inspired by easy-agent step12: multi-tier warning states, circuit breaker,
 * tool result truncation, and output token tiers.
 */

import { env } from "../env";

// ── Context Window ──────────────────────────────────────────────────────────

export const MODEL_CONTEXT_WINDOW = env.AGENT_MAX_CONTEXT_TOKENS
	? Math.max(Number.parseInt(env.AGENT_MAX_CONTEXT_TOKENS, 10), 50_000)
	: 200_000;

const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;

/**
 * Effective window = context window minus space reserved for summary output.
 * For small windows (<100K) use 20% instead of a fixed 20K.
 */
export function getEffectiveContextWindow(): number {
	const reserved = Math.min(MAX_OUTPUT_TOKENS_FOR_SUMMARY, Math.floor(MODEL_CONTEXT_WINDOW * 0.2));
	return MODEL_CONTEXT_WINDOW - reserved;
}

// ── Adaptive Buffer Scaling ──────────────────────────────────────────────────

const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;

const BLOCKING_BUFFER_TOKENS = 3_000;
const REFERENCE_WINDOW = 180_000;

function scaleBuffer(buffer: number, effectiveWindow: number): number {
	if (effectiveWindow >= REFERENCE_WINDOW) return buffer;
	return Math.round(buffer * (effectiveWindow / REFERENCE_WINDOW));
}

export function getAutoCompactThreshold(): number {
	const effective = getEffectiveContextWindow();
	return Math.max(0, effective - scaleBuffer(AUTOCOMPACT_BUFFER_TOKENS, effective));
}

export function getWarningThreshold(): number {
	const effective = getEffectiveContextWindow();
	return Math.max(0, effective - scaleBuffer(WARNING_THRESHOLD_BUFFER_TOKENS, effective));
}

export function getBlockingLimit(): number {
	const effective = getEffectiveContextWindow();
	return Math.max(0, effective - scaleBuffer(BLOCKING_BUFFER_TOKENS, effective));
}

// ── Four-State Warning System ────────────────────────────────────────────────

export type TokenWarningState = "normal" | "warning" | "error" | "blocking";

export interface TokenWarningInfo {
	state: TokenWarningState;
	estimatedTokens: number;
	warningThreshold: number;
	autoCompactThreshold: number;
	blockingLimit: number;
}

export function calculateTokenWarningState(estimatedTokens: number): TokenWarningInfo {
	const blockingLimit = getBlockingLimit();
	const autoCompactThreshold = getAutoCompactThreshold();
	const warningThreshold = getWarningThreshold();

	let state: TokenWarningState = "normal";
	if (estimatedTokens >= blockingLimit) {
		state = "blocking";
	} else if (estimatedTokens >= autoCompactThreshold) {
		state = "error";
	} else if (estimatedTokens >= warningThreshold) {
		state = "warning";
	}

	return { state, estimatedTokens, warningThreshold, autoCompactThreshold, blockingLimit };
}

// ── Circuit Breaker ──────────────────────────────────────────────────────────

const MAX_CONSECUTIVE_FAILURES = 3;

export class CompactionCircuitBreaker {
	private consecutiveFailures = 0;

	/**
	 * Decide whether to auto-compact. `configuredThreshold` is the per-session
	 * `compactThresholdTokens` the user set (and that's shown in the system
	 * prompt). It drives the decision, but is clamped to the window-safe ceiling
	 * (`getAutoCompactThreshold()`) so a too-high configured value can never push
	 * compaction past the point where the request would overflow the context window.
	 */
	shouldAutoCompact(estimatedTokens: number, configuredThreshold?: number, isCompactionCall = false): boolean {
		// Escape condition: don't compact during a compaction call
		if (isCompactionCall) return false;
		// Circuit open
		if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return false;
		const ceiling = getAutoCompactThreshold();
		const threshold = configuredThreshold && configuredThreshold > 0 ? Math.min(configuredThreshold, ceiling) : ceiling;
		return estimatedTokens >= threshold;
	}

	recordSuccess(): void {
		this.consecutiveFailures = 0;
	}

	recordFailure(): void {
		this.consecutiveFailures++;
	}

	reset(): void {
		this.consecutiveFailures = 0;
	}

	get isOpen(): boolean {
		return this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
	}

	get failures(): number {
		return this.consecutiveFailures;
	}
}

// ── Tool Result Truncation ───────────────────────────────────────────────────

const DEFAULT_MAX_RESULT_CHARS = 100_000;

export function truncateToolResult(content: string, maxChars = DEFAULT_MAX_RESULT_CHARS): string {
	if (content.length <= maxChars) return content;
	const truncated = content.slice(0, maxChars);
	return `${truncated}\n\n[Output truncated: ${content.length.toLocaleString()} chars total, showing first ${maxChars.toLocaleString()}]`;
}

// ── Output Token Tiers ───────────────────────────────────────────────────────

export const BASE_MAX_TOKENS = 8192;
export const ESCALATED_MAX_TOKENS = 16384;
