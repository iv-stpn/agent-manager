/**
 * Groups an array of items by a key extracted from each item.
 *
 * @param items - The array to group
 * @param keyFn - Function that extracts the grouping key from each item
 * @returns A Map where keys are the grouping values and values are arrays of items
 *
 * @example
 * ```ts
 * const items = [{id: 1, type: 'a'}, {id: 2, type: 'b'}, {id: 3, type: 'a'}];
 * const grouped = groupBy(items, item => item.type);
 * // Map { 'a' => [{id: 1, type: 'a'}, {id: 3, type: 'a'}], 'b' => [{id: 2, type: 'b'}] }
 * ```
 */
export function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
	const grouped = new Map<K, T[]>();
	for (const item of items) {
		const key = keyFn(item);
		const arr = grouped.get(key) ?? [];
		arr.push(item);
		grouped.set(key, arr);
	}
	return grouped;
}

/**
 * Toggles the presence of a value in an array: removes it if present, appends it otherwise.
 * Returns a new array; the input is not mutated.
 *
 * @param items - The source array
 * @param value - The value to toggle
 * @returns A new array with the value added or removed
 *
 * @example
 * ```ts
 * toggleItem([1, 2, 3], 2); // [1, 3]
 * toggleItem([1, 3], 2);    // [1, 3, 2]
 * ```
 */
export function toggleItem<T>(items: T[], value: T): T[] {
	return items.includes(value) ? items.filter((item) => item !== value) : [...items, value];
}

// Insert `item` into `list`, or shallow-merge it into the existing entry that
// shares the same `id`. Returns a new array; never mutates the input.
export function upsertById<T extends { id: string }>(list: readonly T[], item: T): T[] {
	const idx = list.findIndex((entry) => entry.id === item.id);
	if (idx < 0) return [...list, item];
	const next = [...list];
	next[idx] = { ...next[idx], ...item };
	return next;
}

// Replace the existing entry that shares the same `id` with `item`, or prepend
// `item` to the front of the list when no match exists. Unlike `upsertById`,
// this fully replaces the matched entry (no merge) and adds new items at the
// front. Returns a new array; never mutates the input.
export function replaceOrPrependById<T extends { id: string }>(list: readonly T[], item: T): T[] {
	return list.some((entry) => entry.id === item.id)
		? list.map((entry) => (entry.id === item.id ? item : entry))
		: [item, ...list];
}

// Apply `update` to the entry matching `id`, or append `create()` when no entry
// matches. Use when the transform for an existing entry differs from how a fresh
// entry is built (e.g. a new entry carries extra defaults). Returns a new array;
// never mutates the input.
export function updateOrAppendById<T extends { id: I }, I = string>(
	list: readonly T[],
	id: I,
	update: (existing: T) => T,
	create: () => T
): T[] {
	const idx = list.findIndex((entry) => entry.id === id);
	if (idx < 0) return [...list, create()];
	const next = [...list];
	next[idx] = update(next[idx]);
	return next;
}
