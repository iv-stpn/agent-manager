import { FileTree, useFileTree, useFileTreeSelection } from "@pierre/trees/react";
import { FilePlus, FolderPlus, Loader2, RefreshCw, Save } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CodeEditor } from "@/components/code-editor";
import { Button } from "@/components/ui/button";
import {
	createWorkspaceEntry,
	deleteWorkspaceEntry,
	getWorkspaceFile,
	getWorkspaceTree,
	moveWorkspaceEntry,
	saveWorkspaceFile,
	type WorkspaceFile,
} from "@/lib/agent-api";
import { useQuery } from "@/lib/query-cache";

interface FilesTabProps {
	projectId: string;
	running: boolean;
}

function treeKey(projectId: string) {
	return `files-tree:${projectId}`;
}

/** Parent directory of a workspace-relative path ("" for a top-level entry). */
function parentDir(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "" : path.slice(0, idx);
}

/** Join a directory (possibly "") with a leaf name into a workspace path. */
function joinPath(dir: string, name: string): string {
	const clean = name.replace(/^\/+|\/+$/g, "");
	return dir ? `${dir}/${clean}` : clean;
}

export function FilesTab({ projectId, running }: FilesTabProps) {
	// One tree model for the tab's lifetime; paths are pushed via resetPaths once
	// the fetch resolves. The rename handler is held in a ref so the once-built
	// tree options always reach the latest closure (see the effect below).
	const onRenameRef = useRef<(from: string, to: string) => void>(() => {});
	const treeOptions = useMemo(
		() => ({
			paths: [] as string[],
			initialExpansion: 1,
			search: true,
			// `renaming` enables the library's inline rename; onRename fires when the
			// user commits it, which we forward through the move API. It's nested here
			// (not top-level) — that's the only place the library reads it.
			renaming: {
				onRename: (event: { sourcePath: string; destinationPath: string }) =>
					onRenameRef.current(event.sourcePath, event.destinationPath),
			},
			composition: { contextMenu: { enabled: true, triggerMode: "both" as const } },
		}),
		[]
	);
	const { model } = useFileTree(treeOptions);
	const selection = useFileTreeSelection(model);

	// Editor state: what's open, the last-saved baseline, and the live draft.
	const [openFile, setOpenFile] = useState<string | null>(null);
	const [meta, setMeta] = useState<WorkspaceFile | null>(null);
	const [baseline, setBaseline] = useState("");
	const [draft, setDraft] = useState("");
	const [loadingFile, setLoadingFile] = useState(false);
	const [saving, setSaving] = useState(false);
	const dirty = openFile != null && meta?.content != null && draft !== baseline;

	// openFile/dirty are read through refs inside the selection effect below so
	// they aren't effect deps — the effect must fire only when the selected path
	// changes, never on unrelated re-renders.
	const openFileRef = useRef(openFile);
	openFileRef.current = openFile;
	const dirtyRef = useRef(dirty);
	dirtyRef.current = dirty;
	// The primitive path of the current selection. `useFileTreeSelection` hands
	// back a NEW array reference on every render, so depending on the array itself
	// re-runs effects on every render; the string value is stable across them.
	const selectedPath = selection.length > 0 ? selection[selection.length - 1] : null;

	const {
		data: tree,
		loading,
		error,
		refetch,
	} = useQuery(running ? treeKey(projectId) : null, () => getWorkspaceTree(projectId), { staleMs: 10_000 });

	// Feed fetched paths into the tree model. resetPaths keeps expansion/selection
	// where possible, so a refetch after an edit doesn't collapse the whole tree.
	useEffect(() => {
		if (tree) model.resetPaths(tree.paths);
	}, [tree, model]);

	const refresh = useCallback(() => refetch(), [refetch]);

	// Load a file's content into the editor. Each call aborts the previous in-flight
	// request so a fast series of selections can't let a slow earlier load overwrite
	// a later one (and superseded requests are cancelled, not left racing).
	const loadAbortRef = useRef<AbortController | null>(null);
	const loadFile = useCallback(
		async (path: string) => {
			loadAbortRef.current?.abort();
			const controller = new AbortController();
			loadAbortRef.current = controller;
			setLoadingFile(true);
			try {
				const file = await getWorkspaceFile(projectId, path, controller.signal);
				if (controller.signal.aborted) return;
				setOpenFile(path);
				setMeta(file);
				setBaseline(file.content ?? "");
				setDraft(file.content ?? "");
			} catch (err) {
				// An abort is an expected supersede, not a failure — stay silent.
				if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
				toast.error(err instanceof Error ? err.message : "Could not open file");
			} finally {
				if (loadAbortRef.current === controller) {
					loadAbortRef.current = null;
					setLoadingFile(false);
				}
			}
		},
		[projectId]
	);

	// React to tree selection: open the newly selected file (files only —
	// directory rows just expand/collapse). Confirm before dropping unsaved edits.
	// Depends on the primitive `selectedPath`, never the selection array (a fresh
	// reference each render) — so it fires only when the chosen path actually
	// changes, not on every re-render. openFile/dirty are read via refs for the
	// same reason.
	useEffect(() => {
		if (!selectedPath || selectedPath === openFileRef.current) return;
		if (model.getItem(selectedPath)?.isDirectory()) return;
		if (dirtyRef.current && !confirm("Discard unsaved changes to the current file?")) return;
		void loadFile(selectedPath);
	}, [selectedPath, model, loadFile]);

	// Save the draft back to the container, then rebase the baseline so the tab
	// leaves the "dirty" state.
	const save = useCallback(async () => {
		if (!openFile || meta?.content == null) return;
		setSaving(true);
		try {
			await saveWorkspaceFile(projectId, openFile, draft);
			setBaseline(draft);
			toast.success(`Saved ${openFile}`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Could not save file");
		} finally {
			setSaving(false);
		}
	}, [projectId, openFile, draft, meta]);

	// The directory a new entry should land in: the selected directory, the
	// selected file's parent, or the workspace root when nothing is selected.
	const targetDir = useCallback((): string => {
		if (!selectedPath) return "";
		return model.getItem(selectedPath)?.isDirectory() ? selectedPath : parentDir(selectedPath);
	}, [selectedPath, model]);

	const createEntry = useCallback(
		async (type: "file" | "directory") => {
			const name = window.prompt(type === "file" ? "New file name" : "New folder name");
			if (!name?.trim()) return;
			const path = joinPath(targetDir(), name.trim());
			try {
				await createWorkspaceEntry(projectId, path, type);
				await refetch();
				if (type === "file") void loadFile(path);
			} catch (err) {
				toast.error(err instanceof Error ? err.message : `Could not create ${path}`);
			}
		},
		[projectId, targetDir, refetch, loadFile]
	);

	const removeEntry = useCallback(
		async (path: string) => {
			if (!window.confirm(`Delete "${path}"? This cannot be undone.`)) return;
			try {
				await deleteWorkspaceEntry(projectId, path);
				await refetch();
				// Clear the editor if the open file (or a directory containing it) is gone.
				if (openFile && (openFile === path || openFile.startsWith(`${path}/`))) {
					setOpenFile(null);
					setMeta(null);
					setBaseline("");
					setDraft("");
				}
			} catch (err) {
				toast.error(err instanceof Error ? err.message : `Could not delete ${path}`);
			}
		},
		[projectId, openFile, refetch]
	);

	// Commit an inline rename (fired by the tree's F2 / context-menu rename) through
	// the move API. Kept in a ref so the once-built tree options always call the
	// latest closure (projectId/openFile capture).
	useEffect(() => {
		onRenameRef.current = (from: string, to: string) => {
			moveWorkspaceEntry(projectId, from, to)
				.then(() => refetch())
				.then(() => {
					if (openFile === from) setOpenFile(to);
				})
				.catch((err) => {
					toast.error(err instanceof Error ? err.message : `Could not rename ${from}`);
					// Roll the visual rename back — the on-disk move didn't happen.
					void refetch();
				});
		};
	}, [projectId, openFile, refetch]);

	const renderContextMenu = useCallback(
		(item: { path: string; kind: "file" | "directory" }, ctx: { close: () => void }): ReactNode => {
			const act = (fn: () => void) => () => {
				ctx.close();
				fn();
			};
			return (
				<div style={CONTEXT_MENU_STYLE}>
					<button type="button" style={MENU_ITEM_STYLE} onClick={act(() => createEntry("file"))}>
						New file
					</button>
					<button type="button" style={MENU_ITEM_STYLE} onClick={act(() => createEntry("directory"))}>
						New folder
					</button>
					<button type="button" style={MENU_ITEM_STYLE} onClick={act(() => model.getItem(item.path)?.focus())}>
						Rename (F2)
					</button>
					<button type="button" style={{ ...MENU_ITEM_STYLE, color: "#dc2626" }} onClick={act(() => void removeEntry(item.path))}>
						Delete
					</button>
				</div>
			);
		},
		[createEntry, removeEntry, model]
	);

	if (!running) {
		return (
			<div className="text-sm text-gray-600 bg-amber-50 border border-amber-200 rounded-lg p-3">
				Project is not running. Start the project to browse and edit workspace files — the file browser reads and writes the live
				container filesystem.
			</div>
		);
	}

	if (error && !tree) {
		return (
			<div className="text-center py-12">
				<div className="text-red-600 mb-4">{error.message}</div>
				<Button variant="secondary" size="sm" onClick={refresh}>
					<RefreshCw className="w-4 h-4" />
					Retry
				</Button>
			</div>
		);
	}

	return (
		<div className="space-y-3">
			{tree?.truncated && (
				<div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
					This workspace has more files than the browser shows — the list is capped. Use search to find a specific file.
				</div>
			)}
			<div className="flex gap-4 h-[70vh] min-h-[420px]">
				{/* Tree pane */}
				<div className="w-72 shrink-0 flex flex-col border rounded-lg overflow-hidden">
					<div className="flex items-center gap-1 border-b bg-gray-50 px-2 py-1.5">
						<span className="text-xs font-medium text-gray-500 mr-auto">Workspace</span>
						<Button variant="ghost" size="icon" onClick={() => void createEntry("file")} title="New file" aria-label="New file">
							<FilePlus className="w-4 h-4" />
						</Button>
						<Button
							variant="ghost"
							size="icon"
							onClick={() => void createEntry("directory")}
							title="New folder"
							aria-label="New folder"
						>
							<FolderPlus className="w-4 h-4" />
						</Button>
						<Button variant="ghost" size="icon" onClick={refresh} title="Refresh tree" aria-label="Refresh tree">
							{loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
						</Button>
					</div>
					<FileTree model={model} renderContextMenu={renderContextMenu} style={{ flex: 1, minHeight: 0 }} />
				</div>

				{/* Editor pane */}
				<div className="flex-1 min-w-0 flex flex-col border rounded-lg overflow-hidden">
					<div className="flex items-center gap-2 border-b bg-gray-50 px-3 py-1.5">
						<span className="text-sm font-mono text-gray-700 truncate mr-auto">{openFile ?? "No file open"}</span>
						{dirty && <span className="text-xs text-amber-600">● unsaved</span>}
						<Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
							{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
							Save
						</Button>
					</div>
					<div className="flex-1 min-h-0">
						{openFile == null ? (
							<div className="h-full flex items-center justify-center text-gray-400 text-sm">
								{loadingFile ? "Opening…" : "Select a file to view and edit it."}
							</div>
						) : meta?.tooLarge ? (
							<div className="h-full flex items-center justify-center text-gray-500 text-sm px-6 text-center">
								{openFile} is too large to edit in the browser ({(meta.size / 1_000_000).toFixed(1)} MB).
							</div>
						) : meta?.binary ? (
							<div className="h-full flex items-center justify-center text-gray-500 text-sm px-6 text-center">
								{openFile} looks like a binary file and can't be edited as text.
							</div>
						) : (
							<CodeEditor path={openFile} value={draft} readOnly={!running} onChange={setDraft} onSave={() => void save()} />
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

// Inline styles: the context menu renders inside the tree's shadow root, where
// the app's Tailwind classes don't reach — so it's styled with plain style props.
const CONTEXT_MENU_STYLE: React.CSSProperties = {
	display: "flex",
	flexDirection: "column",
	minWidth: 160,
	padding: 4,
	background: "#fff",
	border: "1px solid #e5e7eb",
	borderRadius: 8,
	boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
	fontSize: 13,
};

const MENU_ITEM_STYLE: React.CSSProperties = {
	textAlign: "left",
	padding: "6px 10px",
	border: "none",
	background: "transparent",
	borderRadius: 4,
	cursor: "pointer",
	color: "#111827",
};
