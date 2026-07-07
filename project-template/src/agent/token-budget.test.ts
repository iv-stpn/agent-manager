import { describe, expect, it } from "bun:test";

import { CompactionCircuitBreaker } from "./token-budget";

// A high configured threshold forces shouldAutoCompact's decision to hinge on
// the circuit-breaker state rather than the token estimate — every call here
// passes a token count well above any realistic ceiling so "would compact if
// the breaker allowed it" is always true, isolating the breaker logic.
const HUGE = 10_000_000;

describe("CompactionCircuitBreaker — trip + half-open reset", () => {
	it("allows compaction while under the failure threshold", () => {
		const cb = new CompactionCircuitBreaker();
		expect(cb.shouldAutoCompact(HUGE)).toBe(true);
		cb.recordFailure();
		cb.recordFailure();
		// 2 failures < MAX (3): still closed.
		expect(cb.isOpen).toBe(false);
		expect(cb.shouldAutoCompact(HUGE)).toBe(true);
	});

	it("trips open after 3 consecutive failures and pauses compaction", () => {
		const now = 1_000;
		const cb = new CompactionCircuitBreaker(() => now);
		cb.recordFailure();
		cb.recordFailure();
		cb.recordFailure();
		expect(cb.failures).toBe(3);
		expect(cb.isOpen).toBe(true);
		// Same instant → still cooling down → compaction paused.
		expect(cb.shouldAutoCompact(HUGE)).toBe(false);
	});

	it("half-opens after the cooldown so a transient failure can't latch forever", () => {
		let now = 1_000;
		const cb = new CompactionCircuitBreaker(() => now);
		cb.recordFailure();
		cb.recordFailure();
		cb.recordFailure();
		expect(cb.shouldAutoCompact(HUGE)).toBe(false);

		// Still within the 60s cooldown.
		now = 1_000 + 59_000;
		expect(cb.shouldAutoCompact(HUGE)).toBe(false);
		expect(cb.isOpen).toBe(true);

		// Past the cooldown → half-open → one probe attempt is allowed again.
		now = 1_000 + 61_000;
		expect(cb.isOpen).toBe(false);
		expect(cb.shouldAutoCompact(HUGE)).toBe(true);
	});

	it("recordSuccess fully closes the breaker", () => {
		const now = 5_000;
		const cb = new CompactionCircuitBreaker(() => now);
		cb.recordFailure();
		cb.recordFailure();
		cb.recordFailure();
		expect(cb.isOpen).toBe(true);
		cb.recordSuccess();
		expect(cb.failures).toBe(0);
		expect(cb.isOpen).toBe(false);
		expect(cb.shouldAutoCompact(HUGE)).toBe(true);
	});

	it("re-trips if the half-open probe fails again", () => {
		let now = 0;
		const cb = new CompactionCircuitBreaker(() => now);
		cb.recordFailure();
		cb.recordFailure();
		cb.recordFailure();

		now = 61_000; // half-open
		expect(cb.shouldAutoCompact(HUGE)).toBe(true);
		cb.recordFailure(); // probe failed → lastFailureAt = 61_000, failures = 4
		expect(cb.isOpen).toBe(true);
		expect(cb.shouldAutoCompact(HUGE)).toBe(false);

		// Cooldown restarts from the probe failure, not the original trip.
		now = 61_000 + 61_000;
		expect(cb.shouldAutoCompact(HUGE)).toBe(true);
	});

	it("never compacts during a compaction call, even when closed", () => {
		const cb = new CompactionCircuitBreaker();
		expect(cb.shouldAutoCompact(HUGE, undefined, true)).toBe(false);
	});
});

describe("CompactionCircuitBreaker — mustCompact (blocking-limit enforcement)", () => {
	it("forces compaction at the blocking limit regardless of the breaker/cooldown", () => {
		const now = 0;
		const cb = new CompactionCircuitBreaker(() => now);
		cb.recordFailure();
		cb.recordFailure();
		cb.recordFailure();
		// Breaker is open and cooling down: the normal path declines...
		expect(cb.shouldAutoCompact(HUGE)).toBe(false);
		// ...but a token estimate above the blocking limit must still force it,
		// because the next API call would otherwise overflow the context window.
		expect(cb.mustCompact(HUGE)).toBe(true);
	});

	it("does not force compaction for a tiny estimate", () => {
		const cb = new CompactionCircuitBreaker();
		expect(cb.mustCompact(0)).toBe(false);
	});
});
