import type { AgentRunner } from "./agent/runner";

/** Shared map of active session runners — keyed by session ID. */
export const runners = new Map<string, AgentRunner>();
