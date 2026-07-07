/**
 * Input guards for the LanceDB-backed memory routes.
 *
 * LanceDB filter strings are SQL-like and built by string interpolation, so any
 * caller-supplied value that reaches a filter must be quote-safe. These guards
 * are the boundary: `assertSafeId` rejects anything outside a conservative
 * charset rather than trying to escape, `tableName` sanitises the project id
 * into a table name, and `parseLimit` clamps a caller limit to a sane range.
 *
 * Extracted from memory.ts so the injection guards can be unit-tested without
 * standing up the Hono router or a LanceDB backend.
 */

/** Derive a LanceDB table name from a project id (non-alphanumerics → `_`). */
export function tableName(projectId: string): string {
	return `project_${projectId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/**
 * IDs are application-generated (`type_timestamp_random`) or caller-supplied;
 * restrict them to a conservative charset and reject anything else. Prevents a
 * crafted id from breaking out of the interpolated LanceDB filter string.
 */
export function assertSafeId(id: string): string {
	if (!/^[a-zA-Z0-9_.:-]+$/.test(id)) {
		throw new Error("invalid entry id");
	}
	return id;
}

/** Clamp a caller-supplied limit to a sane, positive range (1..1000). */
export function parseLimit(raw: string | undefined, fallback: number): number {
	const n = Number.parseInt(raw ?? "", 10);
	if (Number.isNaN(n) || n <= 0) return fallback;
	return Math.min(n, 1000);
}
