import {
	Activity,
	AlertTriangle,
	ArrowLeft,
	CheckCircle2,
	ClipboardList,
	Clock,
	Database,
	FolderOpen,
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
import { NewSessionDialog } from "@/components/new-session-dialog";
import { SessionCard } from "@/components/session-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Report, Session } from "@/lib/agent-api";
import {
	deleteProject as apiDeleteProject,
	restartProject as apiRestartProject,
	startProject as apiStartProject,
	stopProject as apiStopProject,
	createProjectStream,
	getLogs,
	getProject,
	getReports,
	getSessions,
	updateSettings,
} from "@/lib/agent-api";
import { getCache, mutateCache, setCache, useQuery } from "@/lib/query-cache";
import type { Project } from "@/lib/types";
import { cn, formatRelativeTime } from "@/lib/utils";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3100";

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
	const tabParam = searchParams.get("tab") as Tab | null;
	const tab: Tab = tabParam && validTabs.includes(tabParam) ? tabParam : "sessions";

	const setTab = (newTab: Tab) => {
		const urlParams = new URLSearchParams(searchParams.toString());
		urlParams.set("tab", newTab);
		setSearchParams(urlParams, { replace: true });
	};

	const [dialogOpen, setDialogOpen] = useState(false);

	// Project + docker status: one initial fetch, then the project SSE stream
	// (below) keeps it live. No polling.
	const {
		data: project = null,
		loading,
		error,
		refetch: fetchProject,
	} = useQuery<Project | null>(`project:${projectId}`, async () => {
		try {
			return await getProject(projectId, AbortSignal.timeout(8000));
		} catch (err) {
			if (err instanceof DOMException && err.name === "TimeoutError") {
				throw new Error(`Could not reach the API at ${API_URL} (timed out). Is master-api running?`);
			}
			throw new Error(`Failed to fetch project from ${API_URL}. Is master-api running?`);
		}
	});

	const isRunning = project?.dockerStatus.running ?? false;

	// Subscribe to the project-wide stream while the project is running. It feeds
	// the sessions list, reports and live stats caches, and its open/error events
	// drive the running indicator — replacing every interval on this page.
	useEffect(() => {
		const projKey = `project:${projectId}`;
		const sessKey = `sessions:${projectId}`;
		const repKey = `reports:${projectId}`;

		const setRunning = (running: boolean) =>
			mutateCache<Project>(projKey, (p) => ({
				...p,
				dockerStatus: { ...p.dockerStatus, running },
			}));

		if (!isRunning || !project?.ports?.server) return;

		const es = createProjectStream(
			projectId,
			(event) => {
				if (event.type === "sessions") {
					setCache(sessKey, event.data);
				} else if (event.type === "session_created") {
					mutateCache<Session[]>(sessKey, (prev) => (prev.some((x) => x.id === event.data.id) ? prev : [event.data, ...prev]));
					mutateCache<Project>(projKey, (p) => ({
						...p,
						stats: { ...p.stats, sessions: p.stats.sessions + 1 },
					}));
				} else if (event.type === "session_updated" || event.type === "token_update") {
					mutateCache<Session[]>(sessKey, (prev) =>
						prev.map((x) => (x.id === event.data.sessionId ? { ...x, ...event.data } : x))
					);
				} else if (event.type === "message") {
					mutateCache<Project>(projKey, (p) => ({
						...p,
						stats: { ...p.stats, messages: p.stats.messages + 1 },
					}));
				} else if (event.type === "checkin_started" || event.type === "checkin_completed") {
					const d = event.data;
					const session = (getCache<Session[]>(sessKey) ?? []).find((s) => s.id === d.sessionId);
					const confirmed = event.type === "checkin_completed";
					const report: Report = {
						id: d.id,
						sessionId: d.sessionId,
						trigger: d.trigger,
						summary: d.summary ?? "",
						discordMessageId: d.discordMessageId ?? null,
						status: confirmed ? "answered" : "pending",
						createdAt: d.createdAt,
						completedAt: confirmed ? Date.now() : null,
						sessionName: session?.name ?? null,
						sessionTask: session?.task ?? "",
					};
					mutateCache<Report[]>(repKey, (prev) => {
						const next = prev.filter((r) => r.id !== report.id);
						next.push(report);
						return next.sort((a, b) => b.createdAt - a.createdAt);
					});
				}
			},
			project.ports.server
		);

		let opened = false;
		es.onopen = () => {
			opened = true;
			setRunning(true);
		};
		es.onerror = () => {
			if (opened) setRunning(false);
			es.close();
		};

		return () => es.close();
	}, [projectId, isRunning, project?.ports?.server]);

	const startProject = async () => {
		try {
			await apiStartProject(projectId);
			fetchProject();
		} catch (error) {
			console.error("Failed to start project:", error);
		}
	};

	const stopProject = async () => {
		try {
			await apiStopProject(projectId);
			fetchProject();
		} catch (error) {
			console.error("Failed to stop project:", error);
		}
	};

	const restartProject = async () => {
		try {
			await apiRestartProject(projectId);
			fetchProject();
		} catch (error) {
			console.error("Failed to restart project:", error);
		}
	};

	const deleteProject = async () => {
		if (!project) return;
		if (!confirm(`Delete project "${project.name}"? This cannot be undone.`)) return;
		try {
			await apiDeleteProject(projectId);
			navigate("/");
		} catch (error) {
			console.error("Failed to delete project:", error);
		}
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
			<header className="border-b h-[110px]">
				<div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
					<div className="flex items-center gap-3 mb-3">
						<Link to="/" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900">
							<ArrowLeft className="w-4 h-4" />
							Projects
						</Link>
					</div>
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
					<div className="flex gap-1">
						{tabs.map(({ key, label, icon: Icon, count }) => (
							<button
								key={key}
								type="button"
								onClick={() => setTab(key)}
								className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition ${
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
					<div>
						<div className="text-gray-500 mb-1">Discord bot</div>
						<div className="text-gray-900">{project.discord?.token ? "Configured" : "Not set"}</div>
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
	} = useQuery<Session[]>(`sessions:${projectId}`, async () => {
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
	const finished = sessions.filter((s) => s.status === "completed" || s.status === "stopped" || s.status === "error");

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
	} = useQuery<string>(`logs:${projectId}:${service}`, async () => {
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

function SettingsTab({ projectId }: { projectId: string }) {
	const [discordToken, setDiscordToken] = useState("");
	const [discordChannel, setDiscordChannel] = useState("");
	const [anthropicKey, setAnthropicKey] = useState("");
	const [anthropicBaseUrl, setAnthropicBaseUrl] = useState("");
	const [model, setModel] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const p = await getProject(projectId);
			setDiscordToken(p.discord?.token ?? "");
			setDiscordChannel(p.discord?.defaultChannelId ?? "");
			setAnthropicKey(p.agent?.anthropicApiKey ?? "");
			setAnthropicBaseUrl(p.agent?.anthropicBaseUrl ?? "");
			setModel(p.agent?.model ?? "");
		} catch (err) {
			console.error("Failed to load project:", err);
		} finally {
			setLoading(false);
		}
	}, [projectId]);

	useEffect(() => {
		load();
	}, [load]);

	async function save() {
		setSaving(true);
		setMessage(null);
		try {
			await updateSettings(projectId, {
				discord: {
					token: discordToken || undefined,
					defaultChannelId: discordChannel || undefined,
				},
				agent: {
					anthropicApiKey: anthropicKey || undefined,
					anthropicBaseUrl: anthropicBaseUrl || undefined,
					model: model || undefined,
				},
			});
			setMessage("Saved. Restart the project for changes to take effect.");
			load();
		} catch (err) {
			setMessage(err instanceof Error ? err.message : "Failed to save settings.");
		} finally {
			setSaving(false);
		}
	}

	if (loading) {
		return <div className="text-gray-500">Loading settings...</div>;
	}

	return (
		<div className="max-w-3xl space-y-6">
			<p className="text-sm text-gray-500">
				Discord and Anthropic config are stored per-project (in config.json and the project&apos;s .env). Restart the project
				after changing.
			</p>

			<Card>
				<CardHeader>
					<CardTitle>Discord</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="discord-token">Bot token</Label>
						<Input
							id="discord-token"
							type="password"
							placeholder="Bot token for this project"
							value={discordToken}
							onChange={(e) => setDiscordToken(e.target.value)}
						/>
						<p className="text-xs text-muted-foreground">Leave empty to disable the Discord bot for this project.</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor="discord-channel">Default channel ID</Label>
						<Input
							id="discord-channel"
							placeholder="Default channel for check-ins / reports"
							value={discordChannel}
							onChange={(e) => setDiscordChannel(e.target.value)}
						/>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Anthropic</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="anthropic-key">API key</Label>
						<Input
							id="anthropic-key"
							type="password"
							placeholder="sk-ant-..."
							value={anthropicKey}
							onChange={(e) => setAnthropicKey(e.target.value)}
						/>
						<p className="text-xs text-muted-foreground">
							Required for the agent to run. Leave empty to use no key (agent will fail to start).
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor="anthropic-base-url">Base URL (optional)</Label>
						<Input
							id="anthropic-base-url"
							placeholder="https://api.anthropic.com"
							value={anthropicBaseUrl}
							onChange={(e) => setAnthropicBaseUrl(e.target.value)}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="model">Model (optional)</Label>
						<Input id="model" placeholder="e.g. claude-sonnet-4-6" value={model} onChange={(e) => setModel(e.target.value)} />
					</div>
				</CardContent>
			</Card>

			{message && (
				<div
					className={cn(
						"text-sm rounded-lg p-3 border",
						message.startsWith("Saved") ? "text-blue-700 bg-blue-50 border-blue-200" : "text-red-700 bg-red-50 border-red-200"
					)}
				>
					{message}
				</div>
			)}

			<Button type="button" onClick={save} disabled={saving}>
				{saving ? "Saving..." : "Save settings"}
			</Button>
		</div>
	);
}

const reportTriggerIcon = {
	timer: Clock,
	urgent: AlertTriangle,
	manual: PlayCircle,
	completion: CheckCircle2,
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
