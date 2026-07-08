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

/**
 * An entry is "archived" when its metadata JSON carries `"archived":true`. We
 * store the flag inside the existing `metadata` string column rather than as a
 * dedicated LanceDB column so no schema migration of the (separately deployed,
 * hard-to-migrate) vector store is needed — a fresh substring never collides
 * with `"archived":false` or any other key. `JSON.stringify` emits no spaces
 * between key and value, so this literal matches what the create/update routes
 * write.
 */
export const ARCHIVED_MARKER = '"archived":true';

/**
 * Build a LanceDB (SQL-like) filter for the list/search routes. Always excludes
 * the sentinel `__init__` row; optionally narrows to a single `type`; and, by
 * default, hides archived entries so the agent's recall/list never surfaces
 * memory a user has archived. `type` must already be validated against the
 * entry-type enum by the caller — it is interpolated verbatim.
 */
export function buildMemoryFilter(type: string | undefined, includeArchived: boolean): string {
	const clauses = ["id != '__init__'"];
	if (type) clauses.push(`type = '${type}'`);
	if (!includeArchived) clauses.push(`metadata NOT LIKE '%${ARCHIVED_MARKER}%'`);
	return clauses.join(" AND ");
}
