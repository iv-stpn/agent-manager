/**
 * Shared event stream utilities — both browser (EventSource) and server-side
 * (raw SSE frame parsing for upstream connections).
 */

import type { ProjectStreamEvent, SessionStreamEvent } from "./sse";
import { PROJECT_STREAM_EVENTS, SESSION_STREAM_EVENTS } from "./sse";

// ── Generic typed EventSource factory ────────────────────────────────────────

const apiUrl = (port: number, path: string) => `http://localhost:${port}/api/${path}`;

/**
 * Opens an EventSource to `url`, attaches one listener per event type, and
 * calls `onEvent` with a typed discriminated-union payload.
 */
export function createEventStream<E extends { type: string; data: unknown }>(
	url: string,
	events: ReadonlyArray<E["type"]>,
	onEvent: (event: E) => void,
	logPrefix: string
): EventSource {
	const es = new EventSource(url);
	for (const type of events) {
		es.addEventListener(type, (raw: MessageEvent) => {
			const text = raw.data;
			let data: unknown;
			try {
				data = JSON.parse(text);
			} catch {
				data = text;
			}
			console.log(`[SSE:${logPrefix}] ${type}`, data);
			const event = { type, data } satisfies { type: E["type"]; data: unknown };
			onEvent(event as E);
		});
	}
	return es;
}

// ── Concrete stream factories (browser) ──────────────────────────────────────

export function createSessionStream(id: string, onEvent: (event: SessionStreamEvent) => void, port: number): EventSource {
	return createEventStream<SessionStreamEvent>(apiUrl(port, `sessions/${id}/stream`), SESSION_STREAM_EVENTS, onEvent, "session");
}

export function createProjectStream(onEvent: (event: ProjectStreamEvent) => void, port: number): EventSource {
	return createEventStream<ProjectStreamEvent>(apiUrl(port, "stream"), PROJECT_STREAM_EVENTS, onEvent, "project");
}

// ── Progress stream (start/stop/restart modals) ──────────────────────────────

export type ProgressStepStatus = "pending" | "running" | "done" | "error";

export interface ProgressStep {
	id: string;
	label: string;
	status: ProgressStepStatus;
	log?: string;
}

export type ProgressStreamAction = "start" | "restart" | "stop";

export const PROGRESS_STEP_LABELS: Record<string, string> = {
	stop: "Stopping containers",
	start: "Starting containers",
	health: "Health check",
	logs: "Container logs",
};

export interface ProgressStreamCallbacks {
	onProgress: (step: string, status: ProgressStepStatus, log?: string) => void;
	onDelta: (step: string, line: string) => void;
	onComplete: (success: boolean) => void;
	onError: () => void;
}

/**
 * Connect to a project action SSE stream (start/stop/restart) and dispatch
 * events to the provided callbacks. Returns a cleanup function.
 */
export function createProgressStream(
	baseUrl: string,
	projectId: string,
	action: ProgressStreamAction,
	callbacks: ProgressStreamCallbacks
): () => void {
	const endpoint = `${baseUrl}/api/projects/${projectId}/${action}-stream`;
	const es = new EventSource(endpoint);

	es.addEventListener("progress", (event: MessageEvent) => {
		const data = JSON.parse(event.data);
		console.log(`[${action}] SSE progress:`, data);
		callbacks.onProgress(data.step, data.status, data.log);
	});

	es.addEventListener("delta", (event: MessageEvent) => {
		const data = JSON.parse(event.data);
		console.log(`[${action}] SSE delta:`, data);
		callbacks.onDelta(data.step, data.line);
	});

	es.addEventListener("complete", (event: MessageEvent) => {
		const data = JSON.parse(event.data);
		console.log(`[${action}] SSE complete:`, data);
		callbacks.onComplete(data.success);
		es.close();
	});

	es.onerror = () => {
		callbacks.onError();
		es.close();
	};

	return () => es.close();
}

// ── Server-side SSE frame parsing ────────────────────────────────────────────

/**
 * Parse a raw SSE frame (text between blank-line separators) into event + data.
 */
export function parseSSEFrame(frame: string): { event: string; data: string } | null {
	let event = "message";
	const dataLines: string[] = [];
	for (const line of frame.split("\n")) {
		if (line.startsWith("event:")) event = line.slice(6).trim();
		else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
	}
	if (dataLines.length === 0) return null;
	return { event, data: dataLines.join("\n") };
}

/**
 * Read an SSE body stream, parsing frames and calling `onFrame` for each.
 * Used server-side to consume upstream SSE connections.
 */
export async function readSSEBody(
	body: ReadableStream<Uint8Array>,
	onFrame: (event: string, data: unknown) => void,
	signal?: AbortSignal
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (!signal?.aborted) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let sep = buffer.indexOf("\n\n");
		while (sep >= 0) {
			const frame = buffer.slice(0, sep);
			buffer = buffer.slice(sep + 2);
			sep = buffer.indexOf("\n\n");
			const parsed = parseSSEFrame(frame);
			if (!parsed || parsed.event === "ping") continue;
			let data: unknown = parsed.data;
			try {
				data = JSON.parse(parsed.data);
			} catch {
				// leave as string
			}
			onFrame(parsed.event, data);
		}
	}
}
