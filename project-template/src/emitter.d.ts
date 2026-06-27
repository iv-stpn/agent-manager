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
export type AgentEvent = {
    type: "session_created";
    data: Record<string, unknown>;
} | {
    type: "message";
    data: Record<string, unknown>;
} | {
    type: "tool_call";
    data: Record<string, unknown>;
} | {
    type: "token_update";
    data: TokenStatistics;
} | {
    type: "checkin_started";
    data: Record<string, unknown>;
} | {
    type: "checkin_completed";
    data: Record<string, unknown>;
} | {
    type: "compaction";
    data: Record<string, unknown>;
} | {
    type: "session_updated";
    data: Record<string, unknown>;
} | {
    type: "error";
    data: {
        message: string;
    };
};
export type GlobalAgentEvent = AgentEvent & {
    sessionId: string;
};
declare class SessionEmitter extends EventEmitter {
    emit(sessionId: string, event: AgentEvent): boolean;
    on(sessionId: string, listener: (event: AgentEvent) => void): this;
    off(sessionId: string, listener: (event: AgentEvent) => void): this;
    onGlobal(listener: (event: GlobalAgentEvent) => void): this;
    offGlobal(listener: (event: GlobalAgentEvent) => void): this;
}
export declare const sessionEmitter: SessionEmitter;
export {};
