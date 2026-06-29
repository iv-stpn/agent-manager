import type { Db } from "../db";
import { ToolName } from "./tools/definitions";
import { glob, grep } from "./tools/implementations/commands";
import {
	createDirectory,
	deleteFile,
	editFile,
	getFileInfo,
	listDirectory,
	moveFile,
	readFile,
	readFileRange,
	searchFiles,
	writeFile,
} from "./tools/implementations/filesystem";
import { deleteMemory, remember, updateMemory } from "./tools/implementations/memory";
import { addTask, getCurrentTask, listTasks, setCurrentTask, updateTask } from "./tools/implementations/task";
import { webFetch, webSearch } from "./tools/implementations/web";
import {
	type QuestionInput,
	type SendGraphInput,
	type SendReportInput,
	validateAddTask,
	validateCreateDirectory,
	validateDeleteFile,
	validateDeleteMemory,
	validateEditFile,
	validateGetFileInfo,
	validateGlob,
	validateGrep,
	validateListDirectory,
	validateListTasks,
	validateMoveFile,
	validateQuestion,
	validateReadFile,
	validateReadFileRange,
	validateRemember,
	validateSearchFiles,
	validateSendGraph,
	validateSendReport,
	validateSetCurrentTask,
	validateUpdateMemory,
	validateUpdateTask,
	validateWebFetch,
	validateWebSearch,
	validateWriteFile,
} from "./tools/validators";

type Input = Record<string, unknown>;

/** Extract the narrowed type from an assertion function. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Asserted<F> = F extends ((i: any) => asserts i is infer T) ? T : Input;

/** A single tool-table entry: validate narrows, execute receives the narrowed type. */
interface ToolEntry<V extends (i: Input) => void> {
	validate: V;
	execute: (i: Asserted<V>) => Promise<string> | string;
}

/** Helper to build a correctly-typed entry (lets TS infer V per call site). */
function tool<V extends (i: Input) => void>(entry: ToolEntry<V>): ToolEntry<V> {
	return entry;
}

/** Handlers backed by runner state that the tool table delegates to. */
export interface ToolHandlers {
	queueQuestion: (input: QuestionInput) => Promise<string>;
	urgentQuestion: (input: QuestionInput) => Promise<string>;
	sendReport: (input: SendReportInput) => Promise<string>;
	sendGraph: (input: SendGraphInput) => Promise<string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolTable = Record<string, { validate: (i: Input) => void; execute: (i: any) => Promise<string> | string }>;

export function buildToolTable(db: Db, sessionId: string, handlers: ToolHandlers): ToolTable {
	return {
		// ── File system ─────────────────────────────────────────────────────────
		[ToolName.Grep]: tool({
			validate: validateGrep,
			execute: (i) => grep(i.pattern, i.path ?? ".", i.include, i.flags ?? ""),
		}),
		[ToolName.Glob]: tool({
			validate: validateGlob,
			execute: (i) => glob(i.pattern, i.path ?? "."),
		}),
		[ToolName.ReadFile]: tool({
			validate: validateReadFile,
			execute: (i) => readFile(i.path),
		}),
		[ToolName.WriteFile]: tool({
			validate: validateWriteFile,
			execute: async (i) => {
				await writeFile(i.path, i.content);
				return `Written to ${i.path}`;
			},
		}),
		[ToolName.ListDirectory]: tool({
			validate: validateListDirectory,
			execute: (i) => listDirectory(i.path ?? ""),
		}),
		[ToolName.SearchFiles]: tool({
			validate: validateSearchFiles,
			execute: (i) =>
				searchFiles(i.pattern, i.path ?? ".", i.file_pattern ?? "*", i.case_sensitive ?? false, i.max_results ?? 100),
		}),
		[ToolName.EditFile]: tool({
			validate: validateEditFile,
			execute: (i) => editFile(i.path, i.old_string, i.new_string, i.replace_all ?? false),
		}),
		[ToolName.MoveFile]: tool({
			validate: validateMoveFile,
			execute: (i) => moveFile(i.source, i.destination),
		}),
		[ToolName.DeleteFile]: tool({
			validate: validateDeleteFile,
			execute: (i) => deleteFile(i.path, i.recursive ?? false),
		}),
		[ToolName.CreateDirectory]: tool({
			validate: validateCreateDirectory,
			execute: (i) => createDirectory(i.path),
		}),
		[ToolName.GetFileInfo]: tool({
			validate: validateGetFileInfo,
			execute: (i) => getFileInfo(i.path),
		}),
		[ToolName.ReadFileRange]: tool({
			validate: validateReadFileRange,
			execute: (i) => readFileRange(i.path, i.start_line, i.end_line),
		}),

		// ── Memory ─────────────────────────────────────────────────────────────
		[ToolName.Remember]: tool({
			validate: validateRemember,
			execute: (i) => remember(i.type, i.title, i.content, i.metadata),
		}),
		[ToolName.UpdateMemory]: tool({
			validate: validateUpdateMemory,
			execute: async (i) => {
				await updateMemory(i.id, {
					...(i.title !== undefined && { title: i.title }),
					...(i.content !== undefined && { content: i.content }),
					...(i.type !== undefined && { type: i.type }),
					...(i.metadata !== undefined && { metadata: i.metadata }),
				});
				return "Memory updated.";
			},
		}),
		[ToolName.DeleteMemory]: tool({
			validate: validateDeleteMemory,
			execute: async (i) => {
				await deleteMemory(i.id);
				return "Memory deleted.";
			},
		}),

		// ── Questions ──────────────────────────────────────────────────────────
		[ToolName.QueueQuestion]: tool({
			validate: validateQuestion,
			execute: (i) => handlers.queueQuestion(i),
		}),
		[ToolName.UrgentQuestion]: tool({
			validate: validateQuestion,
			execute: (i) => handlers.urgentQuestion(i),
		}),

		// ── Reports ────────────────────────────────────────────────────────────
		[ToolName.SendReport]: tool({
			validate: validateSendReport,
			execute: (i) => handlers.sendReport(i),
		}),
		[ToolName.SendGraph]: tool({
			validate: validateSendGraph,
			execute: (i) => handlers.sendGraph(i),
		}),

		// ── Task management ────────────────────────────────────────────────────
		[ToolName.AddTask]: tool({
			validate: validateAddTask,
			execute: (i) => addTask(db, sessionId, i.text, i.status, i.dependsOn),
		}),
		[ToolName.ListTasks]: tool({
			validate: validateListTasks,
			execute: (i) => listTasks(db, i.filter ?? "all"),
		}),
		[ToolName.UpdateTask]: tool({
			validate: validateUpdateTask,
			execute: (i) => updateTask(db, sessionId, i.id, i.status, i.text, i.dependsOn),
		}),
		[ToolName.SetCurrentTask]: tool({
			validate: validateSetCurrentTask,
			execute: (i) => setCurrentTask(db, sessionId, i.id),
		}),
		[ToolName.GetCurrentTask]: tool({
			validate: () => {},
			execute: () => getCurrentTask(db),
		}),

		// ── Web ────────────────────────────────────────────────────────────────
		[ToolName.WebSearch]: tool({
			validate: validateWebSearch,
			execute: (i) => webSearch(i.query, i.limit ?? 8),
		}),
		[ToolName.WebFetch]: tool({
			validate: validateWebFetch,
			execute: (i) => webFetch(i.url, i.max_chars ?? 20_000),
		}),
	};
}
