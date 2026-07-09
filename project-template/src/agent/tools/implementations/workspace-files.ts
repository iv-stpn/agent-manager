import { stat } from "node:fs/promises";
import { env } from "../../../env";
import { sandboxPath } from "./sandbox";

const WORKSPACE = env.WORKSPACE_PATH;

// Hard caps for the live file browser/editor (distinct from the agent's own
// read tool). The tree cap keeps a huge workspace from flooding the UI in one
// payload; the byte cap keeps the editor from loading a file the browser can't
// handle interactively. Both surface as flags the web client renders as
// notices rather than silent truncation.
export const MAX_TREE_ENTRIES = 5000;
const EDITOR_MAX_BYTES = 1_000_000;

// Number of leading bytes scanned for a NUL when deciding "is this binary?".
// A NUL byte effectively never appears in UTF-8 text, so its presence in the
// head of the file is a reliable, cheap binary signal.
const BINARY_SCAN_BYTES = 8000;

/** True if a workspace-relative path already exists (file or directory). */
export async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(sandboxPath(path));
		return true;
	} catch {
		return false;
	}
}

export interface WorkspaceTreeResult {
	paths: string[];
	truncated: boolean;
}

export interface WorkspaceFileResult {
	path: string;
	/** File text, or null when the file is binary or too large to edit. */
	content: string | null;
	binary: boolean;
	tooLarge: boolean;
	size: number;
}

/** Drop entries the browser must never surface, regardless of how they were listed. */
export function isHiddenFromTree(path: string): boolean {
	return (
		path === ".git" ||
		path.startsWith(".git/") ||
		path === "node_modules" ||
		path.startsWith("node_modules/") ||
		path.includes("/node_modules/")
	);
}

/**
 * Turn a raw path list (from git or the find fallback) into the tree payload:
 * drop hidden entries, sort stably, and cap the count. Pure — the network/disk
 * side (spawning git) lives in listWorkspaceTree, so this can be unit-tested.
 */
export function finalizeTreePaths(rawPaths: string[]): WorkspaceTreeResult {
	const filtered = rawPaths.filter(Boolean).filter((path) => !isHiddenFromTree(path));
	filtered.sort((a, b) => a.localeCompare(b));
	const truncated = filtered.length > MAX_TREE_ENTRIES;
	return { paths: truncated ? filtered.slice(0, MAX_TREE_ENTRIES) : filtered, truncated };
}

/**
 * A NUL byte in the file head is a reliable, cheap "this is binary" signal — it
 * effectively never appears in UTF-8 text. Pure so the scan is unit-tested apart
 * from the disk read in readWorkspaceFile.
 */
export function looksBinary(bytes: Uint8Array): boolean {
	const scanLen = Math.min(bytes.length, BINARY_SCAN_BYTES);
	for (let i = 0; i < scanLen; i++) {
		if (bytes[i] === 0) return true;
	}
	return false;
}

/**
 * Fallback lister for a workspace that isn't a git repo. Uses `find` and strips
 * the leading `./` in JS (busybox `find` lacks `-printf`). Best-effort — the
 * workspace is git-initialised at bootstrap, so this path is rarely taken.
 */
async function findWalk(): Promise<string[]> {
	const proc = Bun.spawn(["bash", "-c", "find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null"], {
		cwd: WORKSPACE,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return out
		.split("\n")
		.map((line) => line.replace(/^\.\//, ""))
		.filter(Boolean);
}

/**
 * Flat list of every editable path in the workspace, for `@pierre/trees` (which
 * infers the directory structure from path segments). Uses
 * `git ls-files --cached --others --exclude-standard` so the listing honours
 * `.gitignore` exactly like the agent's own view — no `node_modules`, `dist`,
 * etc. — and includes untracked-but-not-ignored files the agent just created.
 */
export async function listWorkspaceTree(): Promise<WorkspaceTreeResult> {
	const proc = Bun.spawn(["git", "-C", WORKSPACE, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, , exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

	// `-z` gives NUL-delimited output so paths with newlines/spaces survive intact.
	const rawPaths = exitCode === 0 ? out.split("\0") : await findWalk();
	return finalizeTreePaths(rawPaths);
}

/**
 * Read a file for the editor: full content (no 20k truncation like the agent's
 * read tool), but with binary detection and a byte cap so the client can refuse
 * to open something it can't safely edit rather than corrupting it on save.
 */
export async function readWorkspaceFile(path: string): Promise<WorkspaceFileResult> {
	const abs = sandboxPath(path);

	const info = await stat(abs);
	if (info.isDirectory()) throw new Error(`${path} is a directory, not a file`);
	const size = info.size;

	if (size > EDITOR_MAX_BYTES) {
		return { path, content: null, binary: false, tooLarge: true, size };
	}

	const bytes = new Uint8Array(await Bun.file(abs).arrayBuffer());
	if (looksBinary(bytes)) return { path, content: null, binary: true, tooLarge: false, size };

	return { path, content: new TextDecoder("utf-8").decode(bytes), binary: false, tooLarge: false, size };
}
