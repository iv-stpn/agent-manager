import { beforeEach, describe, expect, test } from "bun:test";
import { getCache, setCache, sweepCache } from "./query-cache";

// Each test uses a unique key prefix so the shared module-level store doesn't
// leak state across cases (the store is a singleton by design).
let seq = 0;
function freshKey(): string {
	seq += 1;
	return `test:sweep:${seq}:${Math.random().toString(36).slice(2)}`;
}

describe("sweepCache", () => {
	beforeEach(() => {
		// Reclaim anything left by prior tests so counts are deterministic.
		sweepCache(Number.MAX_SAFE_INTEGER, 0);
	});

	test("evicts an unsubscribed entry older than the TTL", () => {
		const key = freshKey();
		setCache(key, { value: 1 });
		expect(getCache<{ value: number }>(key)).toEqual({ value: 1 });

		// Sweep far enough in the future that the entry is past its TTL.
		const evicted = sweepCache(Date.now() + 10 * 60_000, 5 * 60_000);

		expect(evicted).toBeGreaterThanOrEqual(1);
		expect(getCache(key)).toBeUndefined();
	});

	test("keeps a fresh entry within the TTL", () => {
		const key = freshKey();
		setCache(key, { value: 2 });

		const evicted = sweepCache(Date.now(), 5 * 60_000);

		expect(evicted).toBe(0);
		expect(getCache<{ value: number }>(key)).toEqual({ value: 2 });
	});

	test("a zero TTL evicts every unsubscribed entry", () => {
		const a = freshKey();
		const b = freshKey();
		setCache(a, 1);
		setCache(b, 2);

		const evicted = sweepCache(Date.now(), 0);

		expect(evicted).toBeGreaterThanOrEqual(2);
		expect(getCache(a)).toBeUndefined();
		expect(getCache(b)).toBeUndefined();
	});
});
