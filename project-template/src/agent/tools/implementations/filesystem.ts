import { join } from "node:path";
import { env } from "../../../env";
import { executeBash } from "./commands";

const WORKSPACE = env.WORKSPACE_PATH;

/** Resolve a path to an absolute path within the workspace sandbox */
function sandboxPath(path: string): string {
	if (path.startsWith("/")) {
		if (!path.startsWith(WORKSPACE)) return join(WORKSPACE, path.replace(/^\/+/, ""));
		return path;
	}
	return join(WORKSPACE, path);
}

export async function readFile(path: string): Promise<string> {
	const abs = sandboxPath(path);
	try {
		const text = await Bun.file(abs).text();
		return text.slice(0, 20_000);
	} catch (err) {
		throw new Error(`Cannot read ${path}: ${err}`);
	}
}

export async function writeFile(path: string, content: string): Promise<void> {
	const abs = sandboxPath(path);
	await Bun.write(abs, content);
}

export async function listDirectory(path = ""): Promise<string> {
	const abs = sandboxPath(path || ".");
	const result = await executeBash(`ls -la "${abs}"`);
	return result.stdout || result.stderr;
}

export async function searchFiles(
	pattern: string,
	path = ".",
	filePattern = "*",
	caseSensitive = false,
	maxResults = 100
): Promise<string> {
	const abs = sandboxPath(path);
	const caseFlag = caseSensitive ? "" : "-i";
	const includeFlag = filePattern === "*" ? "" : `--include="${filePattern}"`;

	const cmd = `cd "${abs}" && grep -rn ${caseFlag} ${includeFlag} -E "${pattern.replace(/"/g, '\\"')}" . 2>/dev/null | head -${maxResults}`;
	const result = await executeBash(cmd, 15_000);

	if (result.exitCode !== 0 && !result.stdout) return "No matches found.";
	return result.stdout || "No matches found.";
}

export async function editFile(path: string, oldString: string, newString: string, replaceAll = false): Promise<string> {
	const abs = sandboxPath(path);
	try {
		const content = await Bun.file(abs).text();

		if (!content.includes(oldString)) throw new Error(`String not found in file: ${path}`);

		const occurrences = content.split(oldString).length - 1;
		if (occurrences > 1 && !replaceAll)
			throw new Error(`Found ${occurrences} occurrences. Set replace_all=true to replace all, or make old_string more specific.`);

		const newContent = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString);
		await Bun.write(abs, newContent);
		return `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${path}`;
	} catch (err) {
		throw new Error(`Cannot edit ${path}: ${err}`);
	}
}

export async function moveFile(source: string, destination: string): Promise<string> {
	const absSrc = sandboxPath(source);
	const absDest = sandboxPath(destination);

	const destDir = absDest.substring(0, absDest.lastIndexOf("/"));
	if (destDir) await executeBash(`mkdir -p "${destDir}"`);

	const result = await executeBash(`mv "${absSrc}" "${absDest}"`);
	if (result.exitCode !== 0) throw new Error(`Cannot move ${source} to ${destination}: ${result.stderr}`);
	return `Moved ${source} → ${destination}`;
}

export async function deleteFile(path: string, recursive = false): Promise<string> {
	const abs = sandboxPath(path);

	const statResult = await executeBash(`test -d "${abs}" && echo "dir" || echo "file"`);
	const isDir = statResult.stdout.trim() === "dir";

	if (isDir && !recursive) throw new Error(`${path} is a directory. Set recursive=true to delete directories.`);

	const flag = recursive ? "-rf" : "-f";
	const result = await executeBash(`rm ${flag} "${abs}"`);
	if (result.exitCode !== 0) throw new Error(`Cannot delete ${path}: ${result.stderr}`);
	return `Deleted ${path}`;
}

export async function createDirectory(path: string): Promise<string> {
	const abs = sandboxPath(path);
	const result = await executeBash(`mkdir -p "${abs}"`);
	if (result.exitCode !== 0) throw new Error(`Cannot create directory ${path}: ${result.stderr}`);
	return `Created directory ${path}`;
}

export async function getFileInfo(path: string): Promise<string> {
	const abs = sandboxPath(path);

	const result = await executeBash(
		`stat -f "Size: %z bytes\nModified: %Sm\nType: %HT\nPermissions: %Sp" "${abs}" 2>/dev/null || stat --format="Size: %s bytes\nModified: %y\nType: %F\nPermissions: %A" "${abs}" 2>/dev/null`
	);
	if (result.exitCode !== 0) throw new Error(`Cannot get info for ${path}: file not found`);

	const wcResult = await executeBash(`wc -l "${abs}" 2>/dev/null`);
	const lines = wcResult.exitCode === 0 ? `\nLines: ${wcResult.stdout.trim().split(/\s+/)[0]}` : "";
	return result.stdout + lines;
}

export async function readFileRange(path: string, startLine: number, endLine: number): Promise<string> {
	const abs = sandboxPath(path);

	if (startLine < 1 || endLine < startLine) throw new Error("Invalid line range. start_line must be ≥1 and ≤end_line");

	const result = await executeBash(`sed -n '${startLine},${endLine}p' "${abs}" | head -1000`);
	if (result.exitCode !== 0) throw new Error(`Cannot read ${path}: ${result.stderr}`);
	if (!result.stdout) return `Lines ${startLine}-${endLine} are empty or beyond end of file.`;
	return result.stdout;
}
