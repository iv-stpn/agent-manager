"use client";

// A tiny client-side query cache. It exists so the app never re-queries data it
// already holds: results are keyed and shared across every component and every
// mount, in-flight requests are de-duplicated, and SSE handlers can patch a
// cached entry in place (see `mutateCache`) so a live event updates the UI
// without triggering a refetch.
//
// Data that has a push source (session messages/tools/tokens/check-ins via the
// SSE stream) is fetched once and thereafter only updated through `mutateCache`.
// Data with no push source (docker status, logs, the project list) can opt into
// a `refetchInterval` — still de-duplicated and cache-backed.

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

export interface Snapshot<T> {
	data: T | undefined;
	error: Error | undefined;
	// True only before the first successful load; lets callers show a spinner on
	// cold start but keep showing cached data during background refetches.
	loading: boolean;
}

interface Entry<T> {
	snapshot: Snapshot<T>;
	promise: Promise<void> | undefined;
	updatedAt: number;
	listeners: Set<() => void>;
}

const store = new Map<string, Entry<unknown>>();

function getEntry<T>(key: string): Entry<T> {
	let entry = store.get(key) as Entry<T> | undefined;
	if (!entry) {
		entry = {
			snapshot: { data: undefined, error: undefined, loading: true },
			promise: undefined,
			updatedAt: 0,
			listeners: new Set(),
		};
		store.set(key, entry as Entry<unknown>);
	}
	return entry;
}

function commit<T>(entry: Entry<T>, snapshot: Snapshot<T>) {
	entry.snapshot = snapshot;
	for (const listener of entry.listeners) listener();
}

/** Read a cached value without subscribing (e.g. inside an event handler). */
export function getCache<T>(key: string): T | undefined {
	return (store.get(key) as Entry<T> | undefined)?.snapshot.data;
}

/** Replace a cached value and notify subscribers. */
export function setCache<T>(key: string, data: T) {
	const entry = getEntry<T>(key);
	entry.updatedAt = Date.now();
	commit(entry, { data, error: undefined, loading: false });
}

/**
 * Patch a cached value in place. Used by SSE handlers to fold a live event into
 * already-fetched data so the UI updates without a network round-trip. A no-op
 * if nothing has been cached for the key yet (the eventual initial fetch wins).
 */
export function mutateCache<T>(key: string, updater: (prev: T) => T) {
	const entry = store.get(key) as Entry<T> | undefined;
	if (!entry || entry.snapshot.loading || entry.snapshot.data === undefined) return;
	entry.updatedAt = Date.now();
	commit(entry, { data: updater(entry.snapshot.data), error: undefined, loading: false });
}

function load<T>(key: string, fetcher: () => Promise<T>, force: boolean): Promise<void> {
	const entry = getEntry<T>(key);
	if (entry.promise && !force) return entry.promise;
	const promise = fetcher().then(
		(data) => {
			entry.promise = undefined;
			entry.updatedAt = Date.now();
			commit(entry, { data, error: undefined, loading: false });
		},
		(err) => {
			entry.promise = undefined;
			const error = err instanceof Error ? err : new Error(String(err));
			// Keep any previously-cached data visible; surface the error alongside.
			commit(entry, { ...entry.snapshot, error, loading: false });
		}
	);
	entry.promise = promise;
	return promise;
}

export interface QueryOptions {
	// When false the query is idle (no fetch, no subscription churn). Use for
	// gated data, e.g. don't fetch a session list until the project id is known.
	enabled?: boolean;
	// Serve cached data without refetching when it's younger than this. Default
	// 30s. The whole point: revisiting a page reuses what we already fetched.
	staleMs?: number;
	// Poll interval for data with no push source (docker status, logs). Default 0
	// (off) — anything backed by the SSE stream must leave this off and rely on
	// mutateCache instead.
	refetchInterval?: number;
}

const emptySnapshot: Snapshot<unknown> = { data: undefined, error: undefined, loading: true };

/**
 * Subscribe to a cached query. Identical keys share one entry, so mounting the
 * same query in two places (or remounting after navigation) issues at most one
 * request and reuses the cache while it's fresh.
 */
export function useQuery<T>(
	key: string | null,
	fetcher: () => Promise<T>,
	opts: QueryOptions = {}
): Snapshot<T> & { refetch: () => void } {
	const { enabled = true, staleMs = 30_000, refetchInterval = 0 } = opts;
	const active = enabled && key != null;

	// Keep the latest fetcher without making it a dependency — fetchers are
	// usually fresh closures each render and must not retrigger loads.
	const fetcherRef = useRef(fetcher);
	fetcherRef.current = fetcher;

	const subscribe = useCallback(
		(cb: () => void) => {
			if (!key) return () => {};
			const entry = getEntry<T>(key);
			entry.listeners.add(cb);
			return () => {
				entry.listeners.delete(cb);
			};
		},
		[key]
	);

	const getSnapshot = useCallback(() => {
		if (!key) return emptySnapshot as Snapshot<T>;
		return getEntry<T>(key).snapshot;
	}, [key]);

	const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

	const refetch = useCallback(() => {
		if (key) load(key, () => fetcherRef.current(), true);
	}, [key]);

	useEffect(() => {
		if (!active || !key) return;
		const entry = getEntry<T>(key);
		const stale = Date.now() - entry.updatedAt >= staleMs;
		if (entry.snapshot.loading || stale) load(key, () => fetcherRef.current(), false);

		if (refetchInterval > 0) {
			const id = setInterval(() => load(key, () => fetcherRef.current(), true), refetchInterval);
			return () => clearInterval(id);
		}
	}, [active, key, staleMs, refetchInterval]);

	return { ...snapshot, refetch };
}
