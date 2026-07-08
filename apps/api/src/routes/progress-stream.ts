import type { SSEStreamingApi } from "hono/streaming";

export type ProgressStatus = "running" | "done" | "error";

/**
 * Serialized SSE progress emitter shared by every project-lifecycle stream
 * (create / delete / start / stop / restart / build). Each write is chained
 * onto a single promise so frames reach the client in the order they were
 * produced — even when a caller fire-and-forgets a write. createProject's
 * onStep/onLine fire synchronously from sequential awaits and from child-process
 * stdout/stderr 'data' events, neither of which wait for the write to flush;
 * chaining every write onto one queue serializes them without the manager layer
 * having to await anything.
 *
 * `send`/`delta`/`complete` return the queue tail, so awaiting any of them (or
 * `drain()`) waits for every prior write to flush — the terminal `complete`
 * frame is itself enqueued, so it can never overtake buffered progress.
 */
export function createProgressEmitter(stream: SSEStreamingApi) {
	let queue: Promise<void> = Promise.resolve();
	const enqueue = (write: () => Promise<void>): Promise<void> => {
		queue = queue.then(write, write);
		return queue;
	};

	const send = (step: string, status: ProgressStatus, log?: string) =>
		enqueue(async () => {
			await stream.writeSSE({ event: "progress", data: JSON.stringify({ step, status, log }) });
			await stream.sleep(0);
		});

	const delta = (step: string, line: string) =>
		enqueue(async () => {
			await stream.writeSSE({ event: "delta", data: JSON.stringify({ step, line }) });
			await stream.sleep(0);
		});

	const complete = (payload: Record<string, unknown>) =>
		enqueue(() => stream.writeSSE({ event: "complete", data: JSON.stringify(payload) }));

	/** Await every enqueued write. */
	const drain = () => queue;

	return { send, delta, complete, drain };
}
