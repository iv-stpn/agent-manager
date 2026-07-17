import { Archive, ArchiveRestore, Brain, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ViewToggle } from "@/components/ui/view-toggle";
import {
	createMemoryEntry,
	deleteMemoryEntry,
	getMemoryEntries,
	MEMORY_TYPES,
	type MemoryEntry,
	type MemoryType,
	searchMemory,
	updateMemoryEntry,
} from "@/lib/agent-api";
import { mutateCache, useQuery } from "@/lib/query-cache";
import { cn, formatRelativeTime } from "@/lib/utils";

interface MemoryTabProps {
	projectId: string;
}

const selectClass =
	"px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring bg-background";

// Distinct badge colours per entry type so the list scans quickly.
const typeStyle: Record<MemoryType, string> = {
	decision: "text-purple-700 bg-purple-100",
	todo: "text-blue-700 bg-blue-100",
	plan: "text-indigo-700 bg-indigo-100",
	question: "text-amber-700 bg-amber-100",
	memory: "text-green-700 bg-green-100",
	report: "text-sky-700 bg-sky-100",
	context: "text-gray-700 bg-gray-100",
};

function memoryKey(projectId: string) {
	return `memory:${projectId}`;
}

/** Parse the JSON `metadata` column, tolerating malformed/empty values. */
function parseMetadata(raw: string | undefined): Record<string, unknown> {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function isArchived(entry: MemoryEntry): boolean {
	return parseMetadata(entry.metadata).archived === true;
}

interface MemoryDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	// The entry being edited, or null when creating a new one.
	entry: MemoryEntry | null;
	onSaved: () => void;
	projectId: string;
}

function MemoryDialog({ open, onOpenChange, entry, onSaved, projectId }: MemoryDialogProps) {
	const [type, setType] = useState<MemoryType>(entry?.type ?? "memory");
	const [title, setTitle] = useState(entry?.title ?? "");
	const [content, setContent] = useState(entry?.content ?? "");
	const [saving, setSaving] = useState(false);

	// Re-seed the form each time the dialog opens for a (possibly different) entry.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the target entry or open state flips
	useMemo(() => {
		if (open) {
			setType(entry?.type ?? "memory");
			setTitle(entry?.title ?? "");
			setContent(entry?.content ?? "");
		}
	}, [open, entry?.id]);

	const save = async () => {
		const trimmedTitle = title.trim();
		const trimmedContent = content.trim();
		if (!trimmedTitle || !trimmedContent) {
			toast.error("Title and content are both required");
			return;
		}
		setSaving(true);
		try {
			if (entry) {
				// Preserve any existing metadata (e.g. the archived flag) — only title/content/type change here.
				await updateMemoryEntry(projectId, entry.id, { title: trimmedTitle, content: trimmedContent, type });
			} else {
				await createMemoryEntry(projectId, { type, title: trimmedTitle, content: trimmedContent });
			}
			onOpenChange(false);
			onSaved();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to save memory entry");
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>{entry ? "Edit memory entry" : "New memory entry"}</DialogTitle>
				</DialogHeader>
				<div className="space-y-3">
					<div className="flex gap-3">
						<label className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">Type</span>
							<select
								className={selectClass}
								value={type}
								onChange={(event) => setType(event.target.value as MemoryType)}
								disabled={saving}
							>
								{MEMORY_TYPES.map((key) => (
									<option key={key} value={key}>
										{key}
									</option>
								))}
							</select>
						</label>
						<label htmlFor="memory-title" className="flex flex-1 flex-col gap-1 text-sm">
							<span className="text-muted-foreground">Title</span>
							<Input
								id="memory-title"
								value={title}
								onChange={(event) => setTitle(event.target.value)}
								disabled={saving}
								autoFocus
							/>
						</label>
					</div>
					<label htmlFor="memory-content" className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">Content (markdown)</span>
						<Textarea
							id="memory-content"
							value={content}
							onChange={(event) => setContent(event.target.value)}
							disabled={saving}
							rows={12}
							className="font-mono text-xs"
						/>
					</label>
					<p className="text-xs text-muted-foreground">
						Editing content re-embeds the entry, so semantic recall stays in sync with your changes.
					</p>
				</div>
				<DialogFooter>
					<Button variant="secondary" onClick={() => onOpenChange(false)} disabled={saving}>
						Cancel
					</Button>
					<Button onClick={save} disabled={saving}>
						{saving && <Loader2 className="w-4 h-4 animate-spin" />}
						{entry ? "Save changes" : "Create entry"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

interface MemoryCardProps {
	entry: MemoryEntry;
	score: number | undefined;
	onEdit: (entry: MemoryEntry) => void;
	onArchive: (entry: MemoryEntry) => void;
	onDelete: (entry: MemoryEntry) => void;
}

function MemoryCard({ entry, score, onEdit, onArchive, onDelete }: MemoryCardProps) {
	const archived = isArchived(entry);
	// LanceDB stamps updatedAt on every write; fall back to createdAt for entries
	// written before the update route started setting it.
	const ts = entry.updatedAt ?? entry.createdAt;

	return (
		<li className="rounded-lg border p-3 space-y-2">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2 flex-wrap">
						<span className={cn("shrink-0 px-2 py-0.5 rounded-full text-xs font-medium capitalize", typeStyle[entry.type])}>
							{entry.type}
						</span>
						<span className="font-medium text-sm truncate">{entry.title}</span>
						{typeof score === "number" && (
							<span className="shrink-0 text-[10px] text-muted-foreground" title="Semantic distance — lower is a closer match">
								{score.toFixed(3)}
							</span>
						)}
					</div>
					<p className="mt-0.5 font-mono text-[10px] text-muted-foreground break-all">{entry.id}</p>
				</div>
				<div className="flex items-center gap-1 shrink-0">
					<Button variant="ghost" size="icon" onClick={() => onEdit(entry)} title="Edit entry" aria-label="Edit entry">
						<Pencil className="w-4 h-4" />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						onClick={() => onArchive(entry)}
						title={archived ? "Restore entry" : "Archive entry"}
						aria-label={archived ? "Restore entry" : "Archive entry"}
					>
						{archived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
					</Button>
					<Button
						variant="ghost"
						size="icon"
						onClick={() => onDelete(entry)}
						title="Delete entry"
						aria-label="Delete entry"
						className="text-red-600 hover:text-red-700"
					>
						<Trash2 className="w-4 h-4" />
					</Button>
				</div>
			</div>
			<div className="max-h-64 overflow-auto rounded-md bg-muted/40 px-3 py-2 text-sm">
				<Markdown>{entry.content}</Markdown>
			</div>
			{ts != null && <p className="text-xs text-gray-400">Updated {formatRelativeTime(ts)}</p>}
		</li>
	);
}

export function MemoryTab({ projectId }: MemoryTabProps) {
	const [view, setView] = useState<"active" | "archived">("active");
	const [typeFilter, setTypeFilter] = useState<MemoryType | "all">("all");
	const [searchInput, setSearchInput] = useState("");
	// Non-null while a semantic search is active: the query it ran for, plus its
	// results. Cleared (null) to fall back to the full browsable list.
	const [search, setSearch] = useState<{ query: string; results: MemoryEntry[] } | null>(null);
	const [searching, setSearching] = useState(false);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [editing, setEditing] = useState<MemoryEntry | null>(null);

	// Fetch everything (including archived) once, then filter client-side — the
	// set is small and this keeps the view/type toggles instant. Memory lives in
	// LanceDB (not the project container), so this loads whether or not it's running.
	const {
		data: entries = [],
		loading,
		error,
		refetch,
	} = useQuery<MemoryEntry[]>(memoryKey(projectId), () => getMemoryEntries(projectId, { includeArchived: true }));

	const notArchived = useMemo(() => entries.filter((entry) => !isArchived(entry)), [entries]);
	const archived = useMemo(() => entries.filter((entry) => isArchived(entry)), [entries]);

	const runSearch = async (query: string) => {
		const trimmed = query.trim();
		if (!trimmed) {
			setSearch(null);
			return;
		}
		setSearching(true);
		try {
			const results = await searchMemory(projectId, trimmed);
			setSearch({ query: trimmed, results });
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Search failed");
		} finally {
			setSearching(false);
		}
	};

	const clearSearch = () => {
		setSearchInput("");
		setSearch(null);
	};

	// After a create/edit/archive/delete, refresh the base list and, if a search
	// is showing, re-run it so its results reflect the change too.
	const refreshAll = () => {
		refetch();
		if (search) runSearch(search.query);
	};

	const openNew = () => {
		setEditing(null);
		setDialogOpen(true);
	};

	const openEdit = (entry: MemoryEntry) => {
		setEditing(entry);
		setDialogOpen(true);
	};

	const toggleArchive = async (entry: MemoryEntry) => {
		const nowArchived = !isArchived(entry);
		const metadata = { ...parseMetadata(entry.metadata), archived: nowArchived };
		try {
			// Metadata-only update — the backend skips re-embedding when title/content
			// are unchanged, so archiving never disturbs the vector.
			await updateMemoryEntry(projectId, entry.id, { metadata });
			mutateCache<MemoryEntry[]>(memoryKey(projectId), (prev) =>
				prev.map((item) => (item.id === entry.id ? { ...item, metadata: JSON.stringify(metadata) } : item))
			);
			if (search) setSearch((prev) => (prev ? { ...prev, results: prev.results.filter((item) => item.id !== entry.id) } : prev));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to archive entry");
		}
	};

	const remove = async (entry: MemoryEntry) => {
		if (!confirm(`Delete memory entry "${entry.title}"? This directly removes it from LanceDB and cannot be undone.`)) return;
		try {
			await deleteMemoryEntry(projectId, entry.id);
			mutateCache<MemoryEntry[]>(memoryKey(projectId), (prev) => prev.filter((item) => item.id !== entry.id));
			if (search) setSearch((prev) => (prev ? { ...prev, results: prev.results.filter((item) => item.id !== entry.id) } : prev));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to delete entry");
		}
	};

	// The rows to show: search results (when searching) or the view/type-filtered
	// browse list. The type filter applies in both modes.
	const base = search ? search.results : view === "archived" ? archived : notArchived;
	const shown = typeFilter === "all" ? base : base.filter((entry) => entry.type === typeFilter);

	if (loading && entries.length === 0) {
		return <div className="text-gray-500">Loading memory...</div>;
	}

	if (error && entries.length === 0) {
		return (
			<div className="text-center py-12">
				<div className="text-red-600 mb-4">{error.message}</div>
				<p className="text-sm text-gray-500 mb-4">
					The memory store (LanceDB) may be unreachable. Start the shared services with docker compose.
				</p>
				<button
					type="button"
					onClick={refetch}
					className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
				>
					<RefreshCw className="w-4 h-4" />
					Retry
				</button>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div className="text-sm text-gray-600 bg-blue-50 border border-blue-200 rounded-lg p-3">
				This is the project's long-term memory — the same store the agent reads and writes with its <code>remember</code> /{" "}
				<code>recall</code> tools. Edits here write straight to LanceDB and take effect on the agent's next recall.
			</div>

			{/* Search */}
			<form
				onSubmit={(event) => {
					event.preventDefault();
					runSearch(searchInput);
				}}
				className="flex gap-2"
			>
				<div className="relative flex-1">
					<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
					<Input
						value={searchInput}
						onChange={(event) => setSearchInput(event.target.value)}
						placeholder="Semantic search across memory…"
						className="pl-9"
					/>
				</div>
				<Button type="submit" variant="secondary" disabled={searching || !searchInput.trim()}>
					{searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
					Search
				</Button>
				{search && (
					<Button type="button" variant="ghost" onClick={clearSearch}>
						<X className="w-4 h-4" />
						Clear
					</Button>
				)}
			</form>

			{/* Controls */}
			<div className="flex items-center justify-between gap-3 flex-wrap">
				<div className="flex items-center gap-3">
					{!search && (
						<ViewToggle
							value={view}
							onChange={setView}
							options={[
								{ value: "active", label: "Active", count: notArchived.length },
								{ value: "archived", label: "Archived", count: archived.length },
							]}
						/>
					)}
					<select
						className={selectClass}
						value={typeFilter}
						onChange={(event) => setTypeFilter(event.target.value as MemoryType | "all")}
						aria-label="Filter by type"
					>
						<option value="all">All types</option>
						{MEMORY_TYPES.map((key) => (
							<option key={key} value={key}>
								{key}
							</option>
						))}
					</select>
				</div>
				<div className="flex items-center gap-2">
					<Button size="sm" onClick={openNew}>
						<Plus className="w-4 h-4" />
						New entry
					</Button>
					<Button variant="secondary" size="icon" onClick={refreshAll} title="Refresh memory" aria-label="Refresh memory">
						<RefreshCw className="w-4 h-4" />
					</Button>
				</div>
			</div>

			{search && (
				<p className="text-sm text-muted-foreground">
					{shown.length} result{shown.length === 1 ? "" : "s"} for <span className="font-medium">"{search.query}"</span> (archived
					entries excluded)
				</p>
			)}

			{shown.length === 0 ? (
				<div className="text-center py-12 space-y-2">
					<Brain className="w-8 h-8 mx-auto text-gray-300" />
					<p className="text-gray-400">
						{search ? "No matching memory entries" : view === "archived" ? "No archived memory entries" : "No memory entries yet"}
					</p>
					{!search && view === "active" && (
						<p className="text-sm text-gray-500">The agent writes here as it works, or you can add an entry manually.</p>
					)}
				</div>
			) : (
				<ul className="space-y-2">
					{shown.map((entry) => (
						<MemoryCard
							key={entry.id}
							entry={entry}
							score={(entry as MemoryEntry & { _distance?: number })._distance}
							onEdit={openEdit}
							onArchive={toggleArchive}
							onDelete={remove}
						/>
					))}
				</ul>
			)}

			<MemoryDialog open={dialogOpen} onOpenChange={setDialogOpen} entry={editing} onSaved={refreshAll} projectId={projectId} />
		</div>
	);
}
