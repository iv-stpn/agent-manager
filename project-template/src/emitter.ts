import { EventEmitter } from "node:events";

export type TokenStatistics = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
};

export type AgentEvent =
	| { type: "session_created"; data: Record<string, unknown> }
	| { type: "message"; data: Record<string, unknown> }
	| { type: "tool_call"; data: Record<string, unknown> }
	| { type: "token_update"; data: TokenStatistics }
	| { type: "checkin_started"; data: Record<string, unknown> }
	| { type: "checkin_completed"; data: Record<string, unknown> }
	| { type: "compaction"; data: Record<string, unknown> }
	| { type: "session_updated"; data: Record<string, unknown> }
	| { type: "error"; data: { message: string } };

// A global event carries the same payload plus the originating session id, so a
// project-wide stream can fan in events from every session.
export type GlobalAgentEvent = AgentEvent & { sessionId: string };

// Channel every event is mirrored onto, in addition to its per-session channel.
const GLOBAL_CHANNEL = "__all__";

class SessionEmitter extends EventEmitter {
	emit(sessionId: string, event: AgentEvent): boolean {
		super.emit(GLOBAL_CHANNEL, { ...event, sessionId } as GlobalAgentEvent);
		return super.emit(sessionId, event);
	}

	on(sessionId: string, listener: (event: AgentEvent) => void): this {
		return super.on(sessionId, listener);
	}

	off(sessionId: string, listener: (event: AgentEvent) => void): this {
		return super.off(sessionId, listener);
	}

	// Subscribe to events from every session at once (project-wide stream).
	onGlobal(listener: (event: GlobalAgentEvent) => void): this {
		return super.on(GLOBAL_CHANNEL, listener);
	}

	offGlobal(listener: (event: GlobalAgentEvent) => void): this {
		return super.off(GLOBAL_CHANNEL, listener);
	}
}

export const sessionEmitter = new SessionEmitter();
// Per-session listeners + every project-wide listener share this emitter; lift
// the cap so a busy project with many open streams doesn't warn.
sessionEmitter.setMaxListeners(0);
