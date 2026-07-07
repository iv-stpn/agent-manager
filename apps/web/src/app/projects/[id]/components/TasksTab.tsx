import { Archive, ArchiveRestore, Loader2, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ViewToggle } from "@/components/ui/view-toggle";
import type { Task } from "@/lib/agent-api";
import { archiveFinishedTasks, archiveTask, deleteTask, getTasks, updateTask } from "@/lib/agent-api";
import { mutateCache, useQuery } from "@/lib/query-cache";
import { cn, formatRelativeTime } from "@/lib/utils";

interface TasksTabProps {
	projectId: string;
	running: boolean;
}

const selectClass =
	"px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring bg-background";

const statusStyle: Record<Task["status"], string> = {
	pending: "text-gray-500 bg-gray-100",
	in_progress: "text-blue-600 bg-blue-50",
	done: "text-green-600 bg-green-50",
	cancelled: "text-red-500 bg-red-50",
};

const statusLabel: Record<Task["status"], string> = {
	pending: "Pending",
	in_progress: "In progress",
	done: "Done",
	cancelled: "Cancelled",
};

function tasksKey(projectId: string) {
	return `tasks:${projectId}`;
}

interface TaskRowProps {
	projectId: string;
	task: Task;
	editable: boolean;
}

function TaskRow({ projectId, task, editable }: TaskRowProps) {
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState(task.text);
	const [status, setStatus] = useState<Task["status"]>(task.status);
	const [saving, setSaving] = useState(false);

	const startEdit = () => {
		setText(task.text);
		setStatus(task.status);
		setEditing(true);
	};

	const save = async () => {
		const trimmed = text.trim();
		if (!trimmed) {
			toast.error("Task text can't be empty");
			return;
		}
		setSaving(true);
		try {
			const updated = await updateTask(projectId, task.id, { text: trimmed, status });
			mutateCache<Task[]>(tasksKey(projectId), (prev) => prev.map((t) => (t.id === task.id ? updated : t)));
			setEditing(false);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to update task");
		} finally {
			setSaving(false);
		}
	};

	const toggleArchive = async () => {
		try {
			await archiveTask(projectId, task.id, !task.archived);
			mutateCache<Task[]>(tasksKey(projectId), (prev) =>
				prev.map((t) => (t.id === task.id ? { ...t, archived: !task.archived } : t))
			);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to archive task");
		}
	};

	const remove = async () => {
		if (!confirm(`Delete task "${task.text}"? This cannot be undone.`)) return;
		try {
			await deleteTask(projectId, task.id);
			mutateCache<Task[]>(tasksKey(projectId), (prev) => prev.filter((t) => t.id !== task.id));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to delete task");
		}
	};

	if (editing) {
		return (
			<li className="rounded-lg border border-blue-300 bg-blue-50/30 p-3 space-y-2">
				<Input value={text} onChange={(event) => setText(event.target.value)} disabled={saving} autoFocus />
				<div className="flex items-center justify-between gap-2">
					<select
						className={selectClass}
						value={status}
						onChange={(event) => setStatus(event.target.value as Task["status"])}
						disabled={saving}
					>
						{(Object.keys(statusLabel) as Task["status"][]).map((key) => (
							<option key={key} value={key}>
								{statusLabel[key]}
							</option>
						))}
					</select>
					<div className="flex gap-2">
						<Button variant="secondary" size="sm" onClick={() => setEditing(false)} disabled={saving}>
							<X className="w-4 h-4" />
							Cancel
						</Button>
						<Button size="sm" onClick={save} disabled={saving}>
							{saving && <Loader2 className="w-4 h-4 animate-spin" />}
							Save
						</Button>
					</div>
				</div>
			</li>
		);
	}

	return (
		<li className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
			<div className="min-w-0 flex items-center gap-3">
				<span className={cn("shrink-0 px-2 py-0.5 rounded-full text-xs font-medium", statusStyle[task.status])}>
					{statusLabel[task.status]}
				</span>
				<span className={cn("truncate", task.status === "done" && "line-through text-muted-foreground")}>{task.text}</span>
			</div>
			<div className="flex items-center gap-3 shrink-0">
				<span className="text-xs text-gray-400">{formatRelativeTime(task.updatedAt)}</span>
				{!task.archived && (
					<Button variant="ghost" size="icon" onClick={startEdit} title="Edit task" aria-label="Edit task" disabled={!editable}>
						<Pencil className="w-4 h-4" />
					</Button>
				)}
				<Button
					variant="ghost"
					size="icon"
					onClick={toggleArchive}
					title={task.archived ? "Restore task" : "Archive task"}
					aria-label={task.archived ? "Restore task" : "Archive task"}
				>
					{task.archived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
				</Button>
				<Button
					variant="ghost"
					size="icon"
					onClick={remove}
					title="Delete task"
					aria-label="Delete task"
					disabled={!editable}
					className="text-red-600 hover:text-red-700"
				>
					<Trash2 className="w-4 h-4" />
				</Button>
			</div>
		</li>
	);
}

export function TasksTab({ projectId, running }: TasksTabProps) {
	const [view, setView] = useState<"active" | "archived">("active");
	const [archivingAll, setArchivingAll] = useState(false);
	const {
		data: tasks = [],
		loading,
		error,
		refetch: fetchTasks,
	} = useQuery<Task[]>(tasksKey(projectId), () => getTasks(projectId));

	const archiveAllFinished = async () => {
		setArchivingAll(true);
		try {
			const count = await archiveFinishedTasks(projectId);
			fetchTasks();
			toast.success(count > 0 ? `Archived ${count} finished task${count === 1 ? "" : "s"}` : "No finished tasks to archive");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to archive finished tasks");
		} finally {
			setArchivingAll(false);
		}
	};

	if (loading && tasks.length === 0) {
		return <div className="text-gray-500">Loading tasks...</div>;
	}

	if (error && tasks.length === 0) {
		return (
			<div className="text-center py-12">
				<div className="text-red-600 mb-4">{error.message}</div>
				<button
					type="button"
					onClick={fetchTasks}
					className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
				>
					<RefreshCw className="w-4 h-4" />
					Retry
				</button>
			</div>
		);
	}

	const sorted = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
	const notArchived = sorted.filter((task) => !task.archived);
	const archived = sorted.filter((task) => task.archived);
	const shown = view === "archived" ? archived : notArchived;
	const active = shown.filter((task) => task.status === "pending" || task.status === "in_progress");
	const finished = shown.filter((task) => task.status === "done" || task.status === "cancelled");

	return (
		<div className="space-y-6">
			{!running && (
				<div className="text-sm text-gray-600 bg-amber-50 border border-amber-200 rounded-lg p-3">
					Project is not running — showing tasks from the database (read-only). Start the project to edit or delete tasks.
				</div>
			)}
			<div className="flex items-center justify-between gap-3">
				<ViewToggle
					value={view}
					onChange={setView}
					options={[
						{ value: "active", label: "Active", count: notArchived.length },
						{ value: "archived", label: "Archived", count: archived.length },
					]}
				/>
				<div className="flex items-center gap-2">
					{view === "active" && finished.length > 0 && (
						<Button variant="secondary" size="sm" onClick={archiveAllFinished} disabled={archivingAll}>
							{archivingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />}
							Archive finished
						</Button>
					)}
					<Button variant="secondary" size="icon" onClick={fetchTasks} title="Refresh tasks" aria-label="Refresh tasks">
						<RefreshCw className="w-4 h-4" />
					</Button>
				</div>
			</div>

			{shown.length === 0 ? (
				<div className="text-center py-12 space-y-2">
					<p className="text-gray-400">{view === "archived" ? "No archived tasks" : "No tasks yet"}</p>
					{view === "active" && (
						<p className="text-sm text-gray-500">Tasks appear here as the agent plans and works through its to-do list.</p>
					)}
				</div>
			) : (
				<>
					{active.length > 0 && (
						<section>
							<h2 className="text-sm font-medium text-gray-500 mb-3 uppercase tracking-wide">Active</h2>
							<ul className="space-y-2">
								{active.map((task) => (
									<TaskRow key={task.id} projectId={projectId} task={task} editable={running} />
								))}
							</ul>
						</section>
					)}
					{finished.length > 0 && (
						<section>
							<h2 className="text-sm font-medium text-gray-500 mb-3 uppercase tracking-wide">Finished</h2>
							<ul className="space-y-2">
								{finished.map((task) => (
									<TaskRow key={task.id} projectId={projectId} task={task} editable={running} />
								))}
							</ul>
						</section>
					)}
				</>
			)}
		</div>
	);
}
