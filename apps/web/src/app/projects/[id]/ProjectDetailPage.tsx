import type { ProgressStreamAction } from "@agent-manager/utils";
import {
	Activity,
	AlertTriangle,
	Archive,
	ArrowLeft,
	CheckCircle2,
	ClipboardList,
	Clock,
	Database,
	FolderOpen,
	Hammer,
	LayoutGrid,
	List,
	Play,
	PlayCircle,
	Power,
	RefreshCw,
	Settings as SettingsIcon,
	Square,
	Terminal,
	Trash2,
} from "lucide-react";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { StartupProgressModal } from "@/components/dialog/docker-progress-modal";
import { NewSessionDialog } from "@/components/dialog/new-session-dialog";
import { SessionCard } from "@/components/session-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { API_URL } from "@/constants";
import type { Guideline, GuidelineCategory, LlmClient, Report, TechStack } from "@/lib/agent-api";
import {
	getGuidelineCategories,
	getGuidelines,
	getLlmClients,
	getLogs,
	getProject,
	getProjectContext,
	getReports,
	getSessions,
	getTechStacks,
	updateGuideline,
	updateProjectContext,
	updateSettings,
	updateTechStack,
} from "@/lib/agent-api";
import { mutateCache, useQuery } from "@/lib/query-cache";
import { useProjectStream } from "@/lib/stores";
import type { Project } from "@/lib/types";
import { cn, formatRelativeTime } from "@/lib/utils";

type Tab = "overview" | "sessions" | "logs" | "reports" | "settings";

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

	const validTabs: Tab[] = ["overview", "sessions", "logs", "reports", "settings"];
	const rawTab = searchParams.get("tab");
	const tab: Tab = validTabs.find((t) => t === rawTab) ?? "sessions";

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
		{ key: "logs", label: "Logs", icon: Terminal, count: logCount },
		{ key: "reports", label: "Reports", icon: ClipboardList, count: reportCount },
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
							<Button variant="secondary" size="icon" onClick={fetchProject} title="Refresh">
								<RefreshCw className="w-4 h-4" />
							</Button>
							<Button
								variant="secondary"
								size="icon"
								onClick={deleteProject}
								title="Delete project"
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
					{tab === "logs" && <LogsTab projectId={project.id} running={running} />}
					{tab === "reports" && <ReportsTab projectId={project.id} />}
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

function StatCard({ icon: Icon, label, value }: { icon: typeof Database; label: string; value: string }) {
	return (
		<div className="bg-white rounded-lg border border-gray-200 p-4 flex items-center gap-3">
			<Icon className="w-5 h-5 text-gray-400" />
			<div>
				<div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
				<div className="text-lg font-semibold text-gray-900">{value}</div>
			</div>
		</div>
	);
}

function OverviewTab({ project }: { project: Project }) {
	const created = new Date(project.createdAt).toLocaleString();
	const lastActivity = project.stats.lastActivity ? new Date(project.stats.lastActivity).toLocaleString() : "Not yet started";

	return (
		<div className="space-y-6">
			{project.description && <p className="text-sm text-gray-600">{project.description}</p>}

			<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<StatCard icon={Database} label="Sessions" value={String(project.stats.sessions)} />
				<StatCard icon={Activity} label="Messages" value={String(project.stats.messages)} />
				<StatCard icon={RefreshCw} label="Last Activity" value={lastActivity} />
			</div>

			<div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
				<h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Configuration</h2>
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
					<div>
						<div className="text-gray-500 mb-1">Project ID</div>
						<div className="text-gray-900 font-mono">{project.id}</div>
					</div>
					<div>
						<div className="text-gray-500 mb-1">Created</div>
						<div className="text-gray-900">{created}</div>
					</div>
					{project.binaries && project.binaries.length > 0 && (
						<div>
							<div className="text-gray-500 mb-1">Binaries</div>
							<div className="text-gray-900">{project.binaries.join(", ")}</div>
						</div>
					)}
					<div>
						<div className="text-gray-500 mb-1">Server port</div>
						<a
							href={`http://localhost:${project.ports.server}`}
							target="_blank"
							rel="noreferrer"
							className="text-blue-600 hover:underline"
						>
							:{project.ports.server}
						</a>
					</div>
					<div className="sm:col-span-2">
						<div className="text-gray-500 mb-1 flex items-center gap-1">
							<FolderOpen className="w-4 h-4" />
							Workspace ({project.workspace.type})
						</div>
						<div className="text-gray-900 font-mono text-xs break-all">{project.workspace.path}</div>
					</div>
				</div>
			</div>

			{project.dockerStatus.containers.length > 0 && (
				<div className="bg-white rounded-lg border border-gray-200 p-6">
					<h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mb-4">Containers</h2>
					<div className="space-y-2">
						{project.dockerStatus.containers.map((container) => (
							<div key={container.name} className="flex items-center justify-between text-sm">
								<span className="font-mono text-gray-900">{container.name}</span>
								<span className="text-gray-500">{container.status}</span>
								<span className="text-gray-400 font-mono text-xs">{container.ports}</span>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

function SessionsTab({
	projectId,
	running,
	dialogOpen,
	setDialogOpen,
}: {
	projectId: string;
	running: boolean;
	dialogOpen: boolean;
	setDialogOpen: (open: boolean) => void;
}) {
	// Initial load (and read-only fallback when the project is stopped). While
	// running, the project SSE stream in the parent keeps this cache live.
	const {
		data: sessions = [],
		loading,
		error,
		refetch: fetchSessions,
	} = useQuery(`sessions:${projectId}`, async () => {
		const data = await getSessions(projectId);
		mutateCache<Project>(`project:${projectId}`, (p) => ({ ...p, stats: { ...p.stats, sessions: data.length } }));
		return data;
	});

	if (loading && sessions.length === 0) {
		return <div className="text-gray-500">Loading sessions...</div>;
	}

	if (error && sessions.length === 0) {
		return (
			<div className="text-center py-12">
				<div className="text-red-600 mb-4">{error.message}</div>
				<button
					type="button"
					onClick={fetchSessions}
					className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
				>
					<RefreshCw className="w-4 h-4" />
					Retry
				</button>
			</div>
		);
	}

	const active = sessions.filter((s) => s.status === "running" || s.status === "paused" || s.status === "compacting");
	const finished = sessions.filter((s) => s.status === "completed" || s.status === "aborted" || s.status === "error");

	return (
		<div className="space-y-6">
			{!running && (
				<div className="text-sm text-gray-600 bg-amber-50 border border-amber-200 rounded-lg p-3">
					Project is not running — showing sessions from the database (read-only). Start the project to create sessions or
					interact.
				</div>
			)}
			<div className="flex items-center justify-between">
				<p className="text-sm text-gray-500">
					{sessions.length} total · {active.length} active
				</p>
				<div className="flex gap-2">
					<Button variant="secondary" size="icon" onClick={fetchSessions} title="Refresh sessions">
						<RefreshCw className="w-4 h-4" />
					</Button>
					<button
						type="button"
						onClick={() => setDialogOpen(true)}
						disabled={!running}
						className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
					>
						New Session
					</button>
				</div>
			</div>

			{sessions.length === 0 ? (
				<div className="text-center py-12 space-y-3">
					<p className="text-gray-400">No sessions yet</p>
					{running ? (
						<button type="button" onClick={() => setDialogOpen(true)} className="text-blue-600 hover:text-blue-700">
							Start your first agent
						</button>
					) : (
						<p className="text-sm text-gray-500">Start the project to create a session.</p>
					)}
				</div>
			) : (
				<div className="space-y-6">
					{active.length > 0 && (
						<section>
							<h2 className="text-sm font-medium text-gray-500 mb-3 uppercase tracking-wide">Active</h2>
							<div className="grid gap-3">
								{active.map((s) => (
									<SessionCard key={s.id} session={s} projectId={projectId} />
								))}
							</div>
						</section>
					)}
					{finished.length > 0 && (
						<section>
							<h2 className="text-sm font-medium text-gray-500 mb-3 uppercase tracking-wide">Finished</h2>
							<div className="grid gap-3">
								{finished.map((s) => (
									<SessionCard key={s.id} session={s} projectId={projectId} />
								))}
							</div>
						</section>
					)}
				</div>
			)}

			<NewSessionDialog open={dialogOpen} onOpenChange={setDialogOpen} projectId={projectId} />
		</div>
	);
}

function LogsTab({ projectId, running }: { projectId: string; running: boolean }) {
	const [service, setService] = useState<"agent" | "web">("agent");

	const {
		data: logs = "",
		loading,
		error,
		refetch: fetchLogs,
	} = useQuery(`logs:${projectId}:${service}`, async () => {
		try {
			const text = await getLogs(projectId, service);
			mutateCache<Project>(`project:${projectId}`, (p) => ({
				...p,
				logLines: text.trim() ? text.trim().split("\n").length : 0,
			}));
			return text;
		} catch (err) {
			console.error("Failed to fetch logs:", err);
			throw new Error("Failed to load logs. Is the project running?");
		}
	});

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div className="flex gap-2">
					{(["agent"] as const).map((svc) => (
						<button
							key={svc}
							type="button"
							onClick={() => setService(svc)}
							className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
								service === svc ? "bg-blue-600 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-50"
							}`}
						>
							{svc}
						</button>
					))}
				</div>
				<button
					type="button"
					onClick={fetchLogs}
					className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-50 text-gray-600 rounded-lg hover:bg-gray-100 text-sm"
				>
					<RefreshCw className="w-4 h-4" />
					Refresh
				</button>
			</div>

			{!running && (
				<div className="text-sm text-gray-500 bg-gray-100 rounded-lg p-3">
					Project is not running — logs may be empty or stale.
				</div>
			)}

			{loading ? (
				<div className="text-gray-500">Loading logs...</div>
			) : error ? (
				<div className="text-red-600">{error.message}</div>
			) : (
				<pre className="bg-gray-900 text-gray-100 rounded-lg p-4 text-xs font-mono overflow-auto max-h-[60vh] whitespace-pre-wrap">
					{logs || "(no logs)"}
				</pre>
			)}
		</div>
	);
}

type SettingField = {
	key: string;
	label: string;
	value: string;
	display?: string;
	placeholder?: string;
	description?: string;
	type?: string;
	buildPayload: (value: string) => Parameters<typeof updateSettings>[1];
};

type SettingsSubTab = "general" | "llm" | "context";

function SettingsTab({ projectId }: { projectId: string }) {
	const [settingsTab, setSettingsTab] = useState<SettingsSubTab>("general");
	const [projectName, setProjectName] = useState("");
	const [serverPort, setServerPort] = useState("");
	const [workspacePath, setWorkspacePath] = useState("");
	const [selectedClientId, setSelectedClientId] = useState("");
	const [llmClients, setLlmClients] = useState<LlmClient[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [editing, setEditing] = useState<SettingField | null>(null);
	const [draft, setDraft] = useState("");

	const load = useCallback(async () => {
		try {
			const [p, clients] = await Promise.all([getProject(projectId), getLlmClients()]);
			if (!p) return;
			setProjectName(p.name ?? "");
			setServerPort(String(p.ports?.server ?? ""));
			setWorkspacePath(p.workspace?.path ?? "");
			setSelectedClientId(p.agent?.clientId ?? "");
			setLlmClients(clients);
		} catch (err) {
			console.error("Failed to load project:", err);
		} finally {
			setLoading(false);
		}
	}, [projectId]);

	useEffect(() => {
		load();
	}, [load]);

	function openEdit(field: SettingField) {
		setEditing(field);
		setDraft(field.value);
	}

	async function save() {
		if (!editing) return;
		setSaving(true);
		try {
			await updateSettings(projectId, editing.buildPayload(draft));
			toast.success("Saved. Restart the project for changes to take effect.");
			setEditing(null);
			load();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to save settings.");
		} finally {
			setSaving(false);
		}
	}

	const general: SettingField[] = [
		{
			key: "name",
			label: "Project name",
			value: projectName,
			placeholder: "My Project",
			buildPayload: (v) => ({ name: v || undefined }),
		},
		{
			key: "server-port",
			label: "Server port",
			value: serverPort,
			placeholder: "4000",
			type: "number",
			description: "The port the agent server listens on inside Docker and on the host.",
			buildPayload: (v) => ({ ports: v ? { server: Number(v) } : undefined }),
		},
		{
			key: "workspace-path",
			label: "Workspace path",
			value: workspacePath,
			placeholder: "/path/to/workspace",
			description: "Absolute orchestrator path mounted as /workspace in the container.",
			buildPayload: (v) => ({ workspace: v ? { path: v, type: "external" } : undefined }),
		},
	];

	if (loading) {
		return <div className="text-gray-500">Loading settings...</div>;
	}

	const subTabs: Array<{ key: SettingsSubTab; label: string }> = [
		{ key: "general", label: "General" },
		{ key: "llm", label: "LLM" },
		{ key: "context", label: "Context" },
	];

	const selectedClient = llmClients.find((c) => c.id === selectedClientId);

	async function saveLlmClient(clientId: string) {
		setSaving(true);
		try {
			await updateSettings(projectId, { agent: { clientId: clientId || undefined } });
			toast.success("Saved. Restart the project for changes to take effect.");
			setSelectedClientId(clientId);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to save settings.");
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="max-w-3xl space-y-6">
			{/* Sub-tab bar */}
			<div className="flex gap-1 border-b">
				{subTabs.map(({ key, label }) => (
					<button
						key={key}
						type="button"
						onClick={() => setSettingsTab(key)}
						className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
							settingsTab === key ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-800"
						}`}
					>
						{label}
					</button>
				))}
			</div>

			<p className="text-sm text-gray-500">
				Settings are stored in the project&apos;s .env and docker-compose.yml. Restart the project after changing.
			</p>

			{settingsTab === "general" && (
				<Card>
					<CardHeader>
						<CardTitle>General</CardTitle>
					</CardHeader>
					<CardContent className="divide-y">
						{general.map((f) => (
							<SettingRow key={f.key} field={f} onEdit={() => openEdit(f)} />
						))}
					</CardContent>
				</Card>
			)}

			{settingsTab === "llm" && (
				<Card>
					<CardHeader>
						<CardTitle>LLM</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						<p className="text-sm text-muted-foreground">
							Select an LLM client configured in your library. The client's API key, base URL, and model will be used by this
							project.
						</p>
						<div className="space-y-2">
							<label htmlFor="llm-client-select" className="text-sm font-medium">
								LLM Client
							</label>
							{llmClients.length === 0 ? (
								<div className="text-sm text-muted-foreground">
									No LLM clients configured yet.{" "}
									<Link to="/llm-clients" className="text-blue-600 hover:underline">
										Create one
									</Link>
								</div>
							) : (
								<div className="flex gap-2">
									<select
										id="llm-client-select"
										value={selectedClientId}
										onChange={(e) => saveLlmClient(e.target.value)}
										disabled={saving}
										className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
									>
										<option value="">-- Select a client --</option>
										{llmClients.map((client) => (
											<option key={client.id} value={client.id}>
												{client.name} ({client.provider})
											</option>
										))}
									</select>
									{selectedClientId && (
										<Link
											to={`/llm-clients?edit=${selectedClientId}`}
											className="inline-flex items-center gap-2 px-4 py-2 bg-gray-50 text-gray-600 rounded-lg hover:bg-gray-100 text-sm"
										>
											Edit Client
										</Link>
									)}
								</div>
							)}
							{selectedClient && (
								<div className="mt-3 p-3 bg-gray-50 rounded-lg text-xs space-y-1 text-gray-600">
									<div>
										<strong>Provider:</strong> {selectedClient.provider}
									</div>
									{selectedClient.model && (
										<div>
											<strong>Model:</strong> {selectedClient.model}
										</div>
									)}
									{selectedClient.baseUrl && (
										<div>
											<strong>Base URL:</strong> {selectedClient.baseUrl}
										</div>
									)}
								</div>
							)}
						</div>
					</CardContent>
				</Card>
			)}

			{settingsTab === "context" && <ProjectContextCard projectId={projectId} />}

			<Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Edit {editing?.label}</DialogTitle>
						{editing?.description && <DialogDescription>{editing.description}</DialogDescription>}
					</DialogHeader>
					<Input
						type={editing?.type}
						placeholder={editing?.placeholder}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						autoFocus
						onKeyDown={(e) => {
							if (e.key === "Enter") save();
						}}
					/>
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => setEditing(null)} disabled={saving}>
							Cancel
						</Button>
						<Button type="button" onClick={save} disabled={saving}>
							{saving ? "Saving..." : "Save"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function SettingRow({ field, onEdit }: { field: SettingField; onEdit: () => void }) {
	const shown = field.display ?? field.value;
	return (
		<div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
			<div className="min-w-0 space-y-1">
				<div className="text-sm font-medium">{field.label}</div>
				<div className="truncate text-sm text-muted-foreground">{shown || <span className="italic">Not set</span>}</div>
				{field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
			</div>
			<Button type="button" variant="outline" size="sm" onClick={onEdit}>
				Edit
			</Button>
		</div>
	);
}

type LibraryEdit = { kind: "tech-stack"; item: TechStack } | { kind: "guideline"; item: Guideline };

function ProjectContextCard({ projectId }: { projectId: string }) {
	const [techStacks, setTechStacks] = useState<TechStack[]>([]);
	const [guidelines, setGuidelines] = useState<Guideline[]>([]);
	const [categories, setCategories] = useState<GuidelineCategory[]>([]);
	const [techStackIds, setTechStackIds] = useState<string[]>([]);
	const [guidelineIds, setGuidelineIds] = useState<string[]>([]);
	const [instructions, setInstructions] = useState("");
	const [binaries, setBinaries] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [editing, setEditing] = useState<LibraryEdit | null>(null);
	const [draft, setDraft] = useState("");
	const [savingEntity, setSavingEntity] = useState(false);

	const load = useCallback(async () => {
		try {
			const [stacks, guides, cats, ctx, proj] = await Promise.all([
				getTechStacks(),
				getGuidelines(),
				getGuidelineCategories(),
				getProjectContext(projectId),
				getProject(projectId),
			]);
			setTechStacks(stacks);
			setGuidelines(guides);
			setCategories(cats);
			setTechStackIds(ctx.techStackIds);
			setGuidelineIds(ctx.guidelineIds);
			setInstructions(ctx.instructions);
			setBinaries(proj?.binaries ?? []);
		} catch (err) {
			console.error("Failed to load project context:", err);
		} finally {
			setLoading(false);
		}
	}, [projectId]);

	useEffect(() => {
		load();
	}, [load]);

	function toggle(list: string[], setList: (v: string[]) => void, id: string) {
		setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
	}

	async function save() {
		setSaving(true);
		try {
			await updateProjectContext(projectId, { techStackIds, guidelineIds, instructions });
			toast.success("Context saved. Restart the project for changes to take effect.");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to save context.");
		} finally {
			setSaving(false);
		}
	}

	function openEntityEdit(edit: LibraryEdit) {
		setEditing(edit);
		setDraft(edit.kind === "tech-stack" ? edit.item.description : edit.item.content);
	}

	async function saveEntity() {
		if (!editing) return;
		setSavingEntity(true);
		try {
			if (editing.kind === "tech-stack") {
				await updateTechStack(editing.item.id, { description: draft });
			} else {
				await updateGuideline(editing.item.id, { content: draft });
			}
			toast.success("Library item updated for all projects. Re-save context to apply here.");
			setEditing(null);
			await load();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to update library item.");
		} finally {
			setSavingEntity(false);
		}
	}

	if (loading) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Project context</CardTitle>
				</CardHeader>
				<CardContent className="text-sm text-gray-500">Loading context...</CardContent>
			</Card>
		);
	}

	const selectedStacks = techStacks.filter((t) => techStackIds.includes(t.id));
	const selectedGuidelines = guidelines.filter((g) => guidelineIds.includes(g.id));

	return (
		<>
			<Card>
				<CardHeader>
					<CardTitle>Context Summary</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div>
						<div className="text-sm font-medium mb-2">Selected Tech Stacks ({selectedStacks.length})</div>
						{selectedStacks.length === 0 ? (
							<p className="text-sm text-muted-foreground italic">None selected</p>
						) : (
							<ul className="space-y-1">
								{selectedStacks.map((stack) => (
									<li key={stack.id} className="text-sm text-gray-700">
										• {stack.name} ({stack.language})
									</li>
								))}
							</ul>
						)}
					</div>
					<div>
						<div className="text-sm font-medium mb-2">Selected Guidelines ({selectedGuidelines.length})</div>
						{selectedGuidelines.length === 0 ? (
							<p className="text-sm text-muted-foreground italic">None selected</p>
						) : (
							<ul className="space-y-1">
								{selectedGuidelines.map((guideline) => (
									<li key={guideline.id} className="text-sm text-gray-700">
										• {guideline.name}
									</li>
								))}
							</ul>
						)}
					</div>
					<div>
						<div className="text-sm font-medium mb-2">Project Instructions</div>
						{instructions ? (
							<p className="text-sm text-gray-700 whitespace-pre-wrap">{instructions}</p>
						) : (
							<p className="text-sm text-muted-foreground italic">None set</p>
						)}
					</div>
					<div>
						<div className="text-sm font-medium mb-2">Binaries</div>
						{binaries.length > 0 ? (
							<p className="text-sm text-gray-700">{binaries.join(", ")}</p>
						) : (
							<p className="text-sm text-muted-foreground italic">None configured</p>
						)}
					</div>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>Edit Context</CardTitle>
				</CardHeader>
				<CardContent className="space-y-6">
					<p className="text-sm text-muted-foreground">
						Selected tech stacks, guidelines, and instructions are injected into the agent&apos;s system prompt. Editing a library
						item changes it for every project that uses it.
					</p>

					<ContextSelectList
						title="Tech stacks"
						empty="No tech stacks in the library yet."
						items={techStacks.map((t) => ({ id: t.id, label: `${t.name} (${t.language})`, sub: t.description }))}
						selectedIds={techStackIds}
						onToggle={(id) => toggle(techStackIds, setTechStackIds, id)}
						onEdit={(id) => {
							const item = techStacks.find((t) => t.id === id);
							if (item) openEntityEdit({ kind: "tech-stack", item });
						}}
					/>

					<GuidelineSelectList
						guidelines={guidelines}
						categories={categories}
						selectedIds={guidelineIds}
						onToggle={(id) => toggle(guidelineIds, setGuidelineIds, id)}
						onEdit={(id) => {
							const item = guidelines.find((g) => g.id === id);
							if (item) openEntityEdit({ kind: "guideline", item });
						}}
					/>

					<div className="space-y-2">
						<div className="text-sm font-medium">Project instructions</div>
						<p className="text-xs text-muted-foreground">
							Free-form instructions specific to this project. Layered on top of the selected library items.
						</p>
						<Textarea
							value={instructions}
							onChange={(e) => setInstructions(e.target.value)}
							placeholder="e.g. Always run the full test suite before committing. Prefer functional components."
							rows={5}
						/>
					</div>

					<div className="flex justify-end">
						<Button type="button" onClick={save} disabled={saving}>
							{saving ? "Saving..." : "Save context"}
						</Button>
					</div>
				</CardContent>
			</Card>

			<Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Edit {editing?.kind === "tech-stack" ? "tech stack description" : "guideline content"}</DialogTitle>
						<DialogDescription>
							This edits the shared library item — changes apply to every project that uses it.
						</DialogDescription>
					</DialogHeader>
					<Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={10} autoFocus />
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => setEditing(null)} disabled={savingEntity}>
							Cancel
						</Button>
						<Button type="button" onClick={saveEntity} disabled={savingEntity}>
							{savingEntity ? "Saving..." : "Save library item"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

function ContextSelectList({
	title,
	empty,
	items,
	selectedIds,
	onToggle,
	onEdit,
}: {
	title: string;
	empty: string;
	items: { id: string; label: string; sub?: string }[];
	selectedIds: string[];
	onToggle: (id: string) => void;
	onEdit: (id: string) => void;
}) {
	return (
		<div className="space-y-2">
			<div className="text-sm font-medium">{title}</div>
			{items.length === 0 ? (
				<p className="text-xs italic text-muted-foreground">{empty}</p>
			) : (
				<ul className="divide-y rounded-md border">
					{items.map((item) => {
						const selected = selectedIds.includes(item.id);
						return (
							<li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2">
								<div className="flex min-w-0 items-center gap-3">
									<Checkbox id={`checkbox-${item.id}`} checked={selected} onCheckedChange={() => onToggle(item.id)} />
									<label htmlFor={`checkbox-${item.id}`} className="min-w-0 cursor-pointer">
										<span className="block text-sm">{item.label}</span>
										{item.sub && <span className="block truncate text-xs text-muted-foreground">{item.sub}</span>}
									</label>
								</div>
								<Button type="button" variant="outline" size="sm" onClick={() => onEdit(item.id)}>
									Edit
								</Button>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}

/** Guidelines list grouped by category. */
function GuidelineSelectList({
	guidelines,
	categories,
	selectedIds,
	onToggle,
	onEdit,
}: {
	guidelines: Guideline[];
	categories: GuidelineCategory[];
	selectedIds: string[];
	onToggle: (id: string) => void;
	onEdit: (id: string) => void;
}) {
	if (guidelines.length === 0) {
		return (
			<div className="space-y-2">
				<div className="text-sm font-medium">Guidelines</div>
				<p className="text-xs italic text-muted-foreground">No guidelines in the library yet.</p>
			</div>
		);
	}

	// Group guidelines by category; null → "Uncategorized"
	const grouped = new Map<string | null, Guideline[]>();
	for (const g of guidelines) {
		const key = g.categoryId ?? null;
		const arr = grouped.get(key) ?? [];
		arr.push(g);
		grouped.set(key, arr);
	}

	// Order: categories in their natural order, then uncategorized last
	const orderedKeys: Array<string | null> = [
		...categories.map((c) => c.id).filter((id) => grouped.has(id)),
		...(grouped.has(null) ? [null] : []),
	];

	function GuidelineItem({ g }: { g: Guideline }) {
		const selected = selectedIds.includes(g.id);
		return (
			<li className="flex items-center justify-between gap-3 px-3 py-2">
				<div className="flex min-w-0 items-center gap-3">
					<Checkbox id={`checkbox-${g.id}`} checked={selected} onCheckedChange={() => onToggle(g.id)} />
					<label htmlFor={`checkbox-${g.id}`} className="min-w-0 cursor-pointer">
						<span className="block text-sm">{g.name}</span>
						{g.description && <span className="block truncate text-xs text-muted-foreground">{g.description}</span>}
					</label>
				</div>
				<Button type="button" variant="outline" size="sm" onClick={() => onEdit(g.id)}>
					Edit
				</Button>
			</li>
		);
	}

	return (
		<div className="space-y-2">
			<div className="text-sm font-medium">Guidelines</div>
			<div className="space-y-3">
				{orderedKeys.map((catId) => {
					const cat = catId ? categories.find((c) => c.id === catId) : null;
					const items = grouped.get(catId) ?? [];
					return (
						<div key={catId ?? "__uncategorized"}>
							<div className="flex items-center gap-2 mb-1">
								{cat ? (
									<>
										<span className="w-2 h-2 rounded-full" style={{ backgroundColor: cat.color }} />
										<span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{cat.name}</span>
									</>
								) : (
									<span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Uncategorized</span>
								)}
							</div>
							<ul className="divide-y rounded-md border">
								{items.map((g) => (
									<GuidelineItem key={g.id} g={g} />
								))}
							</ul>
						</div>
					);
				})}
			</div>
		</div>
	);
}

const reportTriggerIcon = {
	timer: Clock,
	urgent: AlertTriangle,
	manual: PlayCircle,
	completion: CheckCircle2,
	compaction: Archive,
};

const reportStatusStyle = {
	pending: "border-yellow-400 bg-yellow-50",
	answered: "border-green-400 bg-green-50",
	skipped: "border-gray-300 bg-gray-50",
	timeout: "border-red-300 bg-red-50",
};

function ReportsTab({ projectId }: { projectId: string }) {
	const {
		data: reports = [],
		loading,
		error,
		refetch: fetchReports,
	} = useQuery<Report[]>(`reports:${projectId}`, async () => {
		const data = await getReports(projectId);
		mutateCache<Project>(`project:${projectId}`, (p) => ({ ...p, stats: { ...p.stats, reports: data.length } }));
		return data;
	});

	if (loading && reports.length === 0) {
		return <div className="text-gray-500">Loading reports...</div>;
	}

	if (error && reports.length === 0) {
		return (
			<div className="text-center py-12">
				<div className="text-red-600 mb-4">{error.message}</div>
				<button
					type="button"
					onClick={fetchReports}
					className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
				>
					<RefreshCw className="w-4 h-4" />
					Retry
				</button>
			</div>
		);
	}

	if (reports.length === 0) {
		return (
			<div className="text-center py-12 space-y-2">
				<p className="text-gray-400">No reports yet</p>
				<p className="text-sm text-gray-500">Reports appear here as the agent checks in across all sessions.</p>
			</div>
		);
	}

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<p className="text-sm text-gray-500">{reports.length} reports across all sessions</p>
				<Button variant="secondary" size="icon" onClick={fetchReports} title="Refresh reports">
					<RefreshCw className="w-4 h-4" />
				</Button>
			</div>
			<ol className="space-y-3">
				{reports.map((r) => {
					const Icon = reportTriggerIcon[r.trigger] ?? Clock;
					return (
						<li key={r.id}>
							<Link to={`/projects/${projectId}/sessions/${r.sessionId}`} className="block hover:border-blue-400 transition">
								<div className={cn("rounded-lg border p-4 text-sm", reportStatusStyle[r.status] ?? "")}>
									<div className="flex items-center justify-between mb-2 gap-3">
										<div className="flex items-center gap-2 min-w-0">
											<Icon className="w-4 h-4 text-gray-400 shrink-0" />
											<span className="font-medium capitalize">{r.trigger} report</span>
											<span className="text-gray-300">·</span>
											<span className="text-gray-500 truncate" title={r.sessionTask}>
												{r.sessionName || r.sessionTask}
											</span>
										</div>
										<div className="flex items-center gap-2 text-xs text-gray-500 shrink-0">
											<span className="capitalize">{r.status}</span>
											<span>{formatRelativeTime(r.createdAt)}</span>
										</div>
									</div>
									<p className="text-gray-600 text-xs line-clamp-4 whitespace-pre-wrap">{r.summary}</p>
								</div>
							</Link>
						</li>
					);
				})}
			</ol>
		</div>
	);
}
