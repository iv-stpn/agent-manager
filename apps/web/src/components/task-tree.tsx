import { CheckCircle2, ChevronDown, ChevronRight, Circle, Loader2, XCircle } from "lucide-react";
import { useState } from "react";
import type { Task } from "@/lib/agent-api";
import { cn } from "@/lib/utils";

// When the session is no longer active (aborted/stopped/error), the task that
// was in progress — the one that would still be showing a spinner — is shown as
// "stopped" (a solid orange dot) instead. Only that single latest in-progress
// task; everything else keeps its real status.
type TaskStatusKey = "pending" | "in_progress" | "done" | "cancelled" | "stopped";

const statusIcon: Record<TaskStatusKey, typeof Circle> = {
	pending: Circle,
	in_progress: Loader2,
	done: CheckCircle2,
	cancelled: XCircle,
	stopped: Circle,
};

const statusStyle: Record<TaskStatusKey, string> = {
	pending: "text-gray-400",
	in_progress: "text-blue-500 animate-spin",
	done: "text-green-500",
	cancelled: "text-red-400",
	stopped: "text-orange-500 fill-orange-500",
};

function resolveStatus(task: Task, active: boolean, stoppedTaskId: string | null): TaskStatusKey {
	if (!active && task.status === "in_progress" && task.id === stoppedTaskId) return "stopped";
	return task.status;
}

interface TaskNodeProps {
	task: Task;
	children: Task[];
	allTasks: Task[];
	active: boolean;
	stoppedTaskId: string | null;
	defaultOpen?: boolean;
}

function TaskNode({ task, children, allTasks, active, stoppedTaskId, defaultOpen = false }: TaskNodeProps) {
	const [open, setOpen] = useState(defaultOpen);
	const status = resolveStatus(task, active, stoppedTaskId);
	const Icon = statusIcon[status] ?? Circle;
	const hasChildren = children.length > 0;

	return (
		<li className="list-none">
			<div className="flex items-center gap-1.5 py-1 text-sm">
				<span className="inline-flex w-4 h-4 items-center justify-center shrink-0">
					{hasChildren ? (
						<button type="button" onClick={() => setOpen(!open)} className="p-0.5 hover:bg-muted rounded">
							{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
						</button>
					) : null}
				</span>
				<Icon className={cn("h-3.5 w-3.5 shrink-0", statusStyle[status])} />
				<span className={cn("truncate", status === "done" && "line-through text-muted-foreground")}>{task.text}</span>
				<span className="ml-auto text-[10px] text-muted-foreground capitalize shrink-0">{status.replace("_", " ")}</span>
			</div>
			{hasChildren && open && (
				<ul className="ml-4 border-l border-border pl-2">
					{children.map((child) => (
						<TaskNode key={child.id} task={child} allTasks={allTasks} active={active} stoppedTaskId={stoppedTaskId} defaultOpen={child.status === "in_progress"}>
							{getChildren(child.id, allTasks)}
						</TaskNode>
					))}
				</ul>
			)}
		</li>
	);
}

function getChildren(taskId: string, allTasks: Task[]): Task[] {
	return allTasks.filter((t) => {
		if (!t.metadata) return false;
		try {
			const meta = JSON.parse(t.metadata);
			return meta.parentId === taskId;
		} catch {
			return false;
		}
	});
}

function getRootTasks(tasks: Task[]): Task[] {
	const childIds = new Set<string>();
	for (const t of tasks) {
		if (!t.metadata) continue;
		try {
			const meta = JSON.parse(t.metadata);
			if (meta.parentId) childIds.add(t.id);
		} catch {
			// ignore
		}
	}
	return tasks.filter((t) => !childIds.has(t.id));
}

interface Props {
	tasks: Task[];
	active?: boolean;
}

export function TaskTree({ tasks, active = true }: Props) {
	const [collapsed, setCollapsed] = useState(false);

	if (tasks.length === 0) {
		return <p className="text-sm text-muted-foreground text-center py-4">No tasks yet</p>;
	}

	const activeCount = tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
	const completedCount = tasks.filter((t) => t.status === "done" || t.status === "cancelled");
	const roots = getRootTasks(tasks);

	// When stopped, only the most recently updated in-progress task is flagged as
	// "stopped" — the one that was showing a spinner and never got to finish.
	let stoppedTaskId: string | null = null;
	if (!active) {
		let stoppedUpdatedAt = -Infinity;
		for (const t of tasks) {
			if (t.status === "in_progress" && t.updatedAt > stoppedUpdatedAt) {
				stoppedTaskId = t.id;
				stoppedUpdatedAt = t.updatedAt;
			}
		}
	}

	return (
		<div className="space-y-2">
			<button
				type="button"
				onClick={() => setCollapsed(!collapsed)}
				className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-foreground/80 w-full"
			>
				{collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
				Tasks
				<span className="text-xs text-muted-foreground font-normal">
					({activeCount.length} active, {completedCount.length} completed)
				</span>
			</button>
			{!collapsed && (
				<ul className="space-y-0.5">
					{roots.map((task) => (
						<TaskNode key={task.id} task={task} allTasks={tasks} active={active} stoppedTaskId={stoppedTaskId} defaultOpen={task.status === "in_progress"}>
							{getChildren(task.id, tasks)}
						</TaskNode>
					))}
				</ul>
			)}
		</div>
	);
}
