import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runGrep } from "./commands";
import { sandboxPath } from "./sandbox";

const READ_FILE_MAX_CHARS = 20_000;

export async function readFile(path: string): Promise<string> {
	const abs = sandboxPath(path);
	try {
		const text = await Bun.file(abs).text();
		if (text.length <= READ_FILE_MAX_CHARS) return text;
		return `${text.slice(0, READ_FILE_MAX_CHARS)}\n\n[Truncated: ${text.length.toLocaleString()} chars total, showing first ${READ_FILE_MAX_CHARS.toLocaleString()}. Use read_file_range for the rest.]`;
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
	try {
		const entries = await readdir(abs, { withFileTypes: true });
		const lines = await Promise.all(
			entries
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(async (entry) => {
					const kind = entry.isDirectory() ? "dir " : entry.isSymbolicLink() ? "link" : "file";
					let size = "";
					if (entry.isFile()) {
						try {
							size = String((await stat(join(abs, entry.name))).size);
						} catch {
							size = "?";
						}
					}
					return `${kind}\t${size}\t${entry.name}${entry.isDirectory() ? "/" : ""}`;
				})
		);
		return lines.length ? lines.join("\n") : "(empty directory)";
	} catch (err) {
		throw new Error(`Cannot list ${path}: ${err}`);
	}
}

export async function searchFiles(
	pattern: string,
	path = ".",
	filePattern = "*",
	caseSensitive = false,
	maxResults = 100
): Promise<string> {
	const abs = sandboxPath(path);
	return runGrep(pattern, {
		path: abs,
		caseSensitive,
		maxResults,
		...(filePattern !== "*" && { include: filePattern }),
	});
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

	const destDir = dirname(absDest);
	try {
		await mkdir(destDir, { recursive: true });
		await rename(absSrc, absDest);
	} catch (err) {
		throw new Error(`Cannot move ${source} to ${destination}: ${err}`);
	}
	return `Moved ${source} → ${destination}`;
}

export async function deleteFile(path: string, recursive = false): Promise<string> {
	const abs = sandboxPath(path);

	let isDir = false;
	try {
		isDir = (await stat(abs)).isDirectory();
	} catch (err) {
		throw new Error(`Cannot delete ${path}: ${err}`);
	}

	if (isDir && !recursive) throw new Error(`${path} is a directory. Set recursive=true to delete directories.`);

	try {
		await rm(abs, { recursive, force: true });
	} catch (err) {
		throw new Error(`Cannot delete ${path}: ${err}`);
	}
	return `Deleted ${path}`;
}

export async function createDirectory(path: string): Promise<string> {
	const abs = sandboxPath(path);
	try {
		await mkdir(abs, { recursive: true });
	} catch (err) {
		throw new Error(`Cannot create directory ${path}: ${err}`);
	}
	return `Created directory ${path}`;
}

export async function readFileRange(path: string, startLine: number, endLine: number): Promise<string> {
	const abs = sandboxPath(path);

	if (startLine < 1 || endLine < startLine) throw new Error("Invalid line range. start_line must be ≥1 and ≤end_line");

	let text: string;
	try {
		text = await Bun.file(abs).text();
	} catch (err) {
		throw new Error(`Cannot read ${path}: ${err}`);
	}
	// Slice the requested 1-indexed line range, capped at 1000 lines like the
	// previous `head -1000`.
	const lines = text
		.split("\n")
		.slice(startLine - 1, endLine)
		.slice(0, 1000);
	if (lines.length === 0) return `Lines ${startLine}-${endLine} are empty or beyond end of file.`;
	return lines.join("\n");
}
