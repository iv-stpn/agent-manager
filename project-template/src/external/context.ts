/**
 * Fetch resolved project context (tech stacks, guidelines, instructions) from api.
 * Called once at startup and cached for the lifetime of the process.
 */

import { env } from "../env";

const ORCHESTRATOR_API_URL = env.ORCHESTRATOR_API_URL;
const PROJECT_ID = env.PROJECT_ID;

export interface StackLibrary {
	name: string;
	version?: string;
}

export interface StackEntry {
	label: string;
	libraries: StackLibrary[];
	usagePatterns: string[];
}

export interface TechStack {
	id: string;
	language: string;
	name: string;
	description: string;
	stack: StackEntry[];
}

export interface Guideline {
	id: string;
	name: string;
	description: string;
	categoryId: string | null;
	category: string | null;
	language: string | null;
	content: string;
}

export interface TemplateRef {
	type: "local" | "github";
	source: string;
	subdirectory?: string;
}

export interface ResolvedProjectContext {
	techStacks: TechStack[];
	guidelines: Guideline[];
	instructions: string;
	templates: TemplateRef[];
}

const EMPTY_CONTEXT: ResolvedProjectContext = { techStacks: [], guidelines: [], instructions: "", templates: [] };

let cached: ResolvedProjectContext | null = null;

/** Fetch resolved project context from api. Caches after first successful call. */
export async function fetchProjectContext(): Promise<ResolvedProjectContext> {
	if (cached) return cached;
	if (!PROJECT_ID) return EMPTY_CONTEXT;

	try {
		const res = await fetch(`${ORCHESTRATOR_API_URL}/api/projects/${PROJECT_ID}/context/resolved`);
		if (!res.ok) return EMPTY_CONTEXT;
		const data = (await res.json()) as ResolvedProjectContext;
		cached = data;
		return data;
	} catch {
		return EMPTY_CONTEXT;
	}
}

/** Invalidate the cached context (e.g. after a context update). */
export function invalidateContextCache(): void {
	cached = null;
}
