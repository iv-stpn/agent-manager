import { isAbsolute, join, relative, resolve } from "node:path";
import { env } from "../../../env";

const WORKSPACE = env.WORKSPACE_PATH;

export function isWithinWorkspace(abs: string): boolean {
	const rel = relative(WORKSPACE, abs);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve a path to an absolute path within the workspace sandbox.
 * Absolute paths outside the workspace are re-rooted into it; `..` segments
 * that would escape the workspace after resolution are rejected.
 *
 * Shared by every tool that touches the filesystem (read/write/edit as well as
 * grep/glob search roots) so the sandbox boundary is enforced in exactly one
 * place — a search tool taking an absolute `/etc/passwd` must be re-rooted the
 * same way a read is.
 */
export function sandboxPath(path: string): string {
	const candidate = isAbsolute(path)
		? isWithinWorkspace(resolve(path))
			? resolve(path)
			: join(WORKSPACE, path.replace(/^\/+/, ""))
		: join(WORKSPACE, path);
	const abs = resolve(candidate);
	if (!isWithinWorkspace(abs)) throw new Error(`Path escapes the workspace sandbox: ${path}`);
	return abs;
}
