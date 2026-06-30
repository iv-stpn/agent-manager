import { EventEmitter } from "node:events";
import type {
	ErrorRecoveredPayload,
	PlanModePayload,
	ThinkingDeltaPayload,
	TokenUpdatePayload,
	TokenWarningPayload,
	ToolcallDeltaPayload,
	ToolcallStartPayload,
	TurnEndPayload,
	TurnStartPayload,
} from "@agent-manager/utils";

export type AgentEvent =
	| { type: "session_created"; data: Record<string, unknown> }
	| { type: "message"; data: Record<string, unknown> }
	| { type: "text_delta"; data: { text: string } }
	| { type: "thinking_delta"; data: ThinkingDeltaPayload }
	| { type: "toolcall_start"; data: ToolcallStartPayload }
	| { type: "toolcall_delta"; data: ToolcallDeltaPayload }
	| { type: "turn_start"; data: TurnStartPayload }
	| { type: "turn_end"; data: TurnEndPayload }
	| { type: "tool_call"; data: Record<string, unknown> }
	| { type: "token_update"; data: TokenUpdatePayload }
	| { type: "checkin_started"; data: Record<string, unknown> }
	| { type: "checkin_completed"; data: Record<string, unknown> }
	| { type: "compaction"; data: Record<string, unknown> }
	| { type: "session_updated"; data: Record<string, unknown> }
	| { type: "error"; data: { message: string } }
	| { type: "plan_mode"; data: PlanModePayload }
	| { type: "token_warning"; data: TokenWarningPayload }
	| { type: "error_recovered"; data: ErrorRecoveredPayload };

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
