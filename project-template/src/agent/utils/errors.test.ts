import { describe, expect, it, spyOn } from "bun:test";

import Anthropic from "@anthropic-ai/sdk";
import { type AgentError, classifyApiError, LLM_CALL_RETRY, SERVER_CRASH_RETRY, withRetry } from "./errors";

// The 5-min crash waits (and the exponential blip backoff) would make these
// tests take minutes. Fire every scheduled timeout immediately so we exercise
// the retry *counting/classification* logic without the wall-clock waits. Each
// test restores its own spy via `timers.mockRestore()`.
function instantTimers() {
	return spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void) => {
		cb();
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout);
}

const SOCKET_MSG = "The socket connection was closed unexpectedly. For more information, pass `verbose: true`";

describe("classifyApiError — server crash", () => {
	it("classifies a raw socket-closed error as retryable server_crash", () => {
		const err = classifyApiError(new Error(SOCKET_MSG));
		expect(err.category).toBe("server_crash");
		expect(err.retryable).toBe(true);
	});

	it("finds the socket marker nested in the .cause chain", () => {
		const wrapped = new Error("Connection error.", { cause: new Error(SOCKET_MSG) });
		const err = classifyApiError(wrapped);
		expect(err.category).toBe("server_crash");
		expect(err.retryable).toBe(true);
	});

	it("still classifies a plain APIConnectionError as network (not server_crash)", () => {
		const err = classifyApiError(new Anthropic.APIConnectionError({ message: "Connection error." }));
		expect(err.category).toBe("network");
		expect(err.retryable).toBe(true);
	});
});

describe("withRetry — server crash budget", () => {
	it("retries a crashing backend exactly SERVER_CRASH_RETRY.maxRetries times, then throws", async () => {
		const timers = instantTimers();
		const attempts: Array<{ attempt: number; category: string; max: number }> = [];
		let calls = 0;

		const run = withRetry(
			() => {
				calls++;
				return Promise.reject(new Error(SOCKET_MSG));
			},
			{
				...LLM_CALL_RETRY,
				onRetry: (err: AgentError, attempt, _delay, maxAttempts) =>
					attempts.push({ attempt, category: err.category, max: maxAttempts }),
			}
		);

		await expect(run).rejects.toMatchObject({ category: "server_crash" });
		// maxRetries retries + the initial call.
		expect(calls).toBe(SERVER_CRASH_RETRY.maxRetries + 1);
		expect(attempts.map((a) => a.attempt)).toEqual([1, 2, 3, 4]);
		expect(attempts.every((a) => a.category === "server_crash" && a.max === SERVER_CRASH_RETRY.maxRetries)).toBe(true);
		timers.mockRestore();
	});

	it("recovers when the backend comes back before the retry ceiling", async () => {
		const timers = instantTimers();
		let calls = 0;

		const result = await withRetry(() => {
			calls++;
			if (calls < 3) return Promise.reject(new Error(SOCKET_MSG));
			return Promise.resolve("ok");
		}, LLM_CALL_RETRY);

		expect(result).toBe("ok");
		expect(calls).toBe(3);
		timers.mockRestore();
	});

	it("keeps the crash budget separate from the ordinary-blip budget", async () => {
		const timers = instantTimers();
		// One crash then persistent network blips: the crash must not consume the
		// exponential LLM_CALL_RETRY budget, and the run still terminates.
		let calls = 0;
		const run = withRetry(() => {
			calls++;
			if (calls === 1) return Promise.reject(new Error(SOCKET_MSG));
			return Promise.reject(new Error("fetch failed"));
		}, LLM_CALL_RETRY);

		await expect(run).rejects.toMatchObject({ category: "network" });
		// 1 crash call + LLM_CALL_RETRY.maxAttempts network calls (initial network
		// attempt is calls #2, then maxAttempts-1 retries) = maxAttempts + 1.
		expect(calls).toBe(LLM_CALL_RETRY.maxAttempts + 1);
		timers.mockRestore();
	});

	it("does not retry a non-retryable error", async () => {
		const timers = instantTimers();
		let calls = 0;
		const run = withRetry(() => {
			calls++;
			const e = Object.assign(new Error("bad request"), { status: 400 });
			return Promise.reject(e);
		}, LLM_CALL_RETRY);

		await expect(run).rejects.toMatchObject({ category: "invalid_request" });
		expect(calls).toBe(1);
		timers.mockRestore();
	});
});
