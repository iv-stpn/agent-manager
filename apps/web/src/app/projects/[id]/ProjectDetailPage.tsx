import type { ProgressStreamAction } from "@agent-manager/utils";
import {
	ArrowLeft,
	Brain,
	CheckSquare,
	ClipboardList,
	FolderTree,
	Hammer,
	LayoutGrid,
	List,
	Play,
	Power,
	RefreshCw,
	Settings as SettingsIcon,
	Square,
	Terminal,
	Trash2,
} from "lucide-react";
import { Suspense, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { StartupProgressModal } from "@/components/dialog/docker-progress-modal";
import { Button } from "@/components/ui/button";
import { API_URL } from "@/constants";
import { getProject } from "@/lib/agent-api";
import { useQuery } from "@/lib/query-cache";
import { useProjectStream } from "@/lib/stores";
import { FilesTab } from "./components/FilesTab";
import { LogsTab } from "./components/LogsTab";
import { MemoryTab } from "./components/MemoryTab";
import { OverviewTab } from "./components/OverviewTab";
import { ReportsTab } from "./components/ReportsTab";
import { SessionsTab } from "./components/SessionsTab";
import { SettingsTab } from "./components/SettingsTab";
import { TasksTab } from "./components/TasksTab";

type Tab = "overview" | "sessions" | "tasks" | "files" | "logs" | "reports" | "memory" | "settings";

export default function ProjectDetailPage() {
	return (
		<Suspense
			fallback={
				<div className="min-h-screen bg-gray-50 flex items-center justify-center">
					<div className="text-gray-500">Loading project...</div>
				</div>
			}
		>
			<ProjectDetailContent />
		</Suspense>
	);
}

function ProjectDetailContent() {
	const params = useParams<{ id: string }>();
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();
	const projectId = params.id;

	const validTabs: Tab[] = ["overview", "sessions", "tasks", "files", "logs", "reports", "memory", "settings"];

	const rawTab = searchParams.get("tab");
	const tab: Tab = validTabs.find((tab) => tab === rawTab) ?? "sessions";

	const setTab = (newTab: Tab) => {
		const urlParams = new URLSearchParams(searchParams.toString());
		urlParams.set("tab", newTab);
		setSearchParams(urlParams, { replace: true });
	};

	const [dialogOpen, setDialogOpen] = useState(false);
	const [progressOpen, setProgressOpen] = useState(false);
	const [progressAction, setProgressAction] = useState<ProgressStreamAction>("start");

	// Project + docker status: one initial fetch, then the project SSE stream
	// (below) keeps it live. No polling.
	const {
		data: project = null,
		loading,
		error,
		refetch: fetchProject,
	} = useQuery(`project:${projectId}`, async () => {
		try {
			if (!projectId) return null;
			return await getProject(projectId, AbortSignal.timeout(8000));
		} catch (err) {
			if (err instanceof DOMException && err.name === "TimeoutError") {
				throw new Error(`Could not reach the API at ${API_URL} (timed out). Is orchestrator API running?`);
			}
			throw new Error(`Failed to fetch project from ${API_URL}. Is orchestrator API running?`);
		}
	});

	const isRunning = project?.dockerStatus.running ?? false;

	// One shared project stream while running — it owns every fold into the
	// sessions/reports/stats caches and drives the running indicator (see
	// stores.ts). Ref-counted, so this page and the session page share one
	// connection when both are mounted.
	useProjectStream(projectId, isRunning, project?.ports?.server);

	const startProject = () => {
		setProgressAction("start");
		setProgressOpen(true);
	};

	const stopProject = () => {
		setProgressAction("stop");
		setProgressOpen(true);
	};

	const restartProject = () => {
		setProgressAction("restart");
		setProgressOpen(true);
	};

	const rebuildProject = () => {
		if (!confirm(`Rebuild "${project?.name}"'s Docker image from current source (no cache)? This may take a minute or two.`))
			return;
		setProgressAction("build");
		setProgressOpen(true);
	};

	const deleteProject = () => {
		if (!project || !projectId) return;
		if (!confirm(`Delete project "${project.name}"? This cannot be undone.`)) return;
		setProgressAction("delete");
		setProgressOpen(true);
	};

	if (loading) {
		return (
			<div className="min-h-screen bg-gray-50 flex items-center justify-center">
				<div className="text-gray-500">Loading project...</div>
			</div>
		);
	}

	if (error && !project) {
		return (
			<div className="min-h-screen bg-gray-50 flex items-center justify-center">
				<div className="text-center max-w-md">
					<div className="text-red-600 mb-4">{error.message}</div>
					<div className="flex gap-2 justify-center">
						<button
							type="button"
							onClick={() => fetchProject()}
							className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
						>
							<RefreshCw className="w-4 h-4" />
							Retry
						</button>
						<Link
							to="/"
							className="inline-flex items-center gap-2 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
						>
							<ArrowLeft className="w-4 h-4" />
							Back
						</Link>
					</div>
				</div>
			</div>
		);
	}

	if (!project) {
		return (
			<div className="min-h-screen bg-gray-50 flex items-center justify-center">
				<div className="text-gray-500">Project not found.</div>
			</div>
		);
	}

	const running = project.dockerStatus.running;
	const sessionCount = project.stats.sessions;
	const reportCount = project.stats.reports;
	const logCount = project.logLines;

	const tabs: Array<{ key: Tab; label: string; icon: typeof List; count?: number | null }> = [
		{ key: "sessions", label: "Sessions", icon: List, count: sessionCount },
		{ key: "overview", label: "Overview", icon: LayoutGrid },
		{ key: "tasks", label: "Tasks", icon: CheckSquare },
		{ key: "files", label: "Files", icon: FolderTree },
		{ key: "logs", label: "Logs", icon: Terminal, count: logCount },
		{ key: "reports", label: "Reports", icon: ClipboardList, count: reportCount },
		{ key: "memory", label: "Memory", icon: Brain },
		{ key: "settings", label: "Settings", icon: SettingsIcon },
	];

	return (
		<div className="h-screen flex flex-col">
			{/* Header */}
			<header className="border-b">
				<div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-3">
							<h1 className="text-2xl font-bold text-gray-900">{project.name}</h1>
							<div className={`w-3 h-3 rounded-full ${running ? "bg-green-500" : "bg-gray-300"}`} />
							<span className="text-sm text-gray-500">{running ? "Running" : "Stopped"}</span>
						</div>
						<div className="flex gap-2">
							{running ? (
								<button
									type="button"
									onClick={stopProject}
									className="flex items-center gap-2 px-3 py-2 bg-red-50 text-red-600 rounded-lg hover:bg-red-100"
								>
									<Square className="w-4 h-4" />
									Stop
								</button>
							) : (
								<button
									type="button"
									onClick={startProject}
									className="flex items-center gap-2 px-3 py-2 bg-green-50 text-green-600 rounded-lg hover:bg-green-100"
								>
									<Play className="w-4 h-4" />
									Start
								</button>
							)}
							<button
								type="button"
								onClick={restartProject}
								className="flex items-center gap-2 px-3 py-2 bg-gray-50 text-gray-600 rounded-lg hover:bg-gray-100"
							>
								<Power className="w-4 h-4" />
								Restart
							</button>
							<button
								type="button"
								onClick={rebuildProject}
								title="Rebuild the Docker image from current source (no cache) and restart"
								className="flex items-center gap-2 px-3 py-2 bg-gray-50 text-gray-600 rounded-lg hover:bg-gray-100"
							>
								<Hammer className="w-4 h-4" />
								Rebuild
							</button>
							<Button variant="secondary" size="icon" onClick={fetchProject} title="Refresh" aria-label="Refresh project">
								<RefreshCw className="w-4 h-4" />
							</Button>
							<Button
								variant="secondary"
								size="icon"
								onClick={deleteProject}
								title="Delete project"
								aria-label="Delete project"
								className="text-red-600 hover:text-red-700 hover:bg-red-50"
							>
								<Trash2 className="w-4 h-4" />
							</Button>
						</div>
					</div>
				</div>
			</header>

			{/* Tabs */}
			<div className="bg-white border-b border-gray-200">
				<div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
					<div className="flex gap-5">
						{tabs.map(({ key, label, icon: Icon, count }) => (
							<button
								key={key}
								type="button"
								onClick={() => setTab(key)}
								className={`flex items-center gap-2 pr-1 py-3 text-sm font-medium border-b-2 transition ${
									tab === key ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-900"
								}`}
							>
								<Icon className="w-4 h-4" />
								{label}
								{count != null && count > 0 && (
									<span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-gray-200 text-gray-600 text-[10px] font-semibold">
										{count}
									</span>
								)}
							</button>
						))}
					</div>
				</div>
			</div>

			{/* Tab content */}
			<main className="flex-1 min-h-0 overflow-y-auto">
				<div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
					{tab === "overview" && <OverviewTab project={project} />}
					{tab === "sessions" && (
						<SessionsTab projectId={project.id} running={running} dialogOpen={dialogOpen} setDialogOpen={setDialogOpen} />
					)}
					{tab === "tasks" && <TasksTab projectId={project.id} running={running} />}
					{tab === "files" && <FilesTab projectId={project.id} running={running} />}
					{tab === "logs" && <LogsTab projectId={project.id} running={running} />}
					{tab === "reports" && <ReportsTab projectId={project.id} />}
					{tab === "memory" && <MemoryTab projectId={project.id} />}
					{tab === "settings" && <SettingsTab projectId={project.id} />}
				</div>
			</main>

			{projectId && (
				<StartupProgressModal
					open={progressOpen}
					onOpenChange={setProgressOpen}
					projectId={projectId}
					action={progressAction}
					onComplete={(success) => {
						if (!success) return;
						if (progressAction === "delete") navigate("/");
						else fetchProject();
					}}
				/>
			)}
		</div>
	);
}
