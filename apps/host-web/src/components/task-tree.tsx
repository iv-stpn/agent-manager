import { CheckCircle2, ChevronDown, ChevronRight, Circle, Loader2, XCircle } from "lucide-react";
import { useState } from "react";
import type { Task } from "@/lib/agent-api";
import { cn } from "@/lib/utils";

const statusIcon = {
	pending: Circle,
	in_progress: Loader2,
	done: CheckCircle2,
	cancelled: XCircle,
};

const statusStyle = {
	pending: "text-gray-400",
	in_progress: "text-blue-500 animate-spin",
	done: "text-green-500",
	cancelled: "text-red-400",
};

interface TaskNodeProps {
	task: Task;
	children: Task[];
	allTasks: Task[];
	defaultOpen?: boolean;
}

function TaskNode({ task, children, allTasks, defaultOpen = false }: TaskNodeProps) {
	const [open, setOpen] = useState(defaultOpen);
	const Icon = statusIcon[task.status] ?? Circle;
	const hasChildren = children.length > 0;

	return (
		<li className="list-none">
			<div className="flex items-center gap-1.5 py-1 text-sm">
				{hasChildren ? (
					<button type="button" onClick={() => setOpen(!open)} className="p-0.5 hover:bg-muted rounded">
						{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
					</button>
				) : (
					<span className="w-4" />
				)}
				<Icon className={cn("h-3.5 w-3.5 shrink-0", statusStyle[task.status])} />
				<span className={cn("truncate", task.status === "done" && "line-through text-muted-foreground")}>{task.text}</span>
				<span className="ml-auto text-[10px] text-muted-foreground capitalize shrink-0">{task.status.replace("_", " ")}</span>
			</div>
			{hasChildren && open && (
				<ul className="ml-4 border-l border-border pl-2">
					{children.map((child) => (
						<TaskNode key={child.id} task={child} allTasks={allTasks} defaultOpen={child.status === "in_progress"}>
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
}

export function TaskTree({ tasks }: Props) {
	const [collapsed, setCollapsed] = useState(false);

	if (tasks.length === 0) {
		return <p className="text-sm text-muted-foreground text-center py-4">No tasks yet</p>;
	}

	const active = tasks.filter((t) => t.status === "pending" || t.status === "in_progress");
	const completed = tasks.filter((t) => t.status === "done" || t.status === "cancelled");
	const roots = getRootTasks(tasks);

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
					({active.length} active, {completed.length} completed)
				</span>
			</button>
			{!collapsed && (
				<ul className="space-y-0.5">
					{roots.map((task) => (
						<TaskNode key={task.id} task={task} allTasks={tasks} defaultOpen={task.status === "in_progress"}>
							{getChildren(task.id, tasks)}
						</TaskNode>
					))}
				</ul>
			)}
		</div>
	);
}
