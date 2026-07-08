import { describe, expect, test } from "bun:test";
import { createProgressEmitter } from "./progress-stream";

// Minimal fake of hono's SSEStreamingApi that records the frames it's asked to
// write, in flush order. writeSSE resolves on a microtask so out-of-order
// scheduling would surface as reordered `writes`.
function fakeStream() {
	const writes: Array<{ event: string; data: unknown }> = [];
	const stream = {
		async writeSSE(msg: { event?: string; data: string }) {
			await Promise.resolve();
			writes.push({ event: msg.event ?? "message", data: JSON.parse(msg.data) });
		},
		async sleep(_ms: number) {
			await Promise.resolve();
		},
	};
	// biome-ignore lint/suspicious/noExplicitAny: test double for SSEStreamingApi
	return { writes, stream: stream as any };
}

describe("createProgressEmitter", () => {
	test("preserves order across fire-and-forget writes ending in complete", async () => {
		const { writes, stream } = fakeStream();
		const p = createProgressEmitter(stream);

		// Mirror create-stream: producers don't await, the terminal frame does.
		void p.send("setup", "running");
		void p.delta("setup", "line-1");
		void p.delta("setup", "line-2");
		void p.send("setup", "done");
		await p.complete({ success: true });

		expect(writes.map((w) => w.event)).toEqual(["progress", "delta", "delta", "progress", "complete"]);
		expect(writes[0].data).toEqual({ step: "setup", status: "running", log: undefined });
		expect(writes[1].data).toEqual({ step: "setup", line: "line-1" });
		expect(writes.at(-1)?.data).toEqual({ success: true });
	});

	test("complete never overtakes a still-queued progress frame", async () => {
		const { writes, stream } = fakeStream();
		const p = createProgressEmitter(stream);

		void p.send("build", "running", "building");
		await p.complete({ success: false, error: "boom" });

		expect(writes.map((w) => w.event)).toEqual(["progress", "complete"]);
		expect(writes[0].data).toEqual({ step: "build", status: "running", log: "building" });
	});

	test("drain resolves after all pending writes flush", async () => {
		const { writes, stream } = fakeStream();
		const p = createProgressEmitter(stream);

		void p.send("a", "running");
		void p.send("b", "running");
		await p.drain();

		expect(writes).toHaveLength(2);
	});
});
