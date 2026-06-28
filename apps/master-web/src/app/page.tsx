import { Activity, Database, ExternalLink, FolderOpen, Play, Plus, RefreshCw, Square, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { containerClassName } from "@/lib/classes";
import { cn } from "@/lib/utils";
import {
	createProject as apiCreateProject,
	deleteProject as apiDeleteProject,
	startProject as apiStartProject,
	stopProject as apiStopProject,
	createMasterStream,
	getProjects,
} from "../lib/agent-api";
import { mutateCache, setCache, useQuery } from "../lib/query-cache";
import type { EnrichedProject as Project } from "../lib/types";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3100";

export default function Home() {
	const [creating, setCreating] = useState(false);
	const [newProject, setNewProject] = useState({
		name: "",
		description: "",
		workspacePath: "",
		discordToken: "",
		discordChannel: "",
		anthropicKey: "",
		anthropicBaseUrl: "",
		model: "",
	});

	const {
		data: projects = [],
		loading,
		error,
		refetch: fetchProjects,
	} = useQuery<Project[]>("projects", async () => {
		try {
			return await getProjects(AbortSignal.timeout(8000));
		} catch (err) {
			if (err instanceof DOMException && err.name === "TimeoutError") {
				throw new Error(`Could not reach the API at ${API_URL} (timed out). Is master-api running?`);
			}
			throw new Error(`Failed to fetch projects from ${API_URL}. Is master-api running?`);
		}
	});

	useEffect(() => {
		const patch = (projectId: string, fn: (p: Project) => Project) =>
			mutateCache<Project[]>("projects", (list) => list.map((p) => (p.id === projectId ? fn(p) : p)));

		const es = createMasterStream(
			(type, { projectId, data }) => {
				if (type === "project_status") {
					const running = Boolean((data as { running?: boolean }).running);
					patch(projectId, (p) => ({ ...p, dockerStatus: { ...p.dockerStatus, running } }));
				} else if (type === "session_created") {
					patch(projectId, (p) => ({
						...p,
						stats: { ...p.stats, sessions: p.stats.sessions + 1 },
					}));
				} else if (type === "message") {
					patch(projectId, (p) => ({
						...p,
						stats: { ...p.stats, messages: p.stats.messages + 1 },
					}));
				}
			},
			(snapshot) => setCache("projects", snapshot as Project[])
		);
		return () => es.close();
	}, []);

	const createProject = async () => {
		if (!newProject.name) return;
		try {
			await apiCreateProject({
				name: newProject.name,
				description: newProject.description || undefined,
				workspacePath: newProject.workspacePath || undefined,
				discord: {
					token: newProject.discordToken || undefined,
					defaultChannelId: newProject.discordChannel || undefined,
				},
				agent: {
					anthropicApiKey: newProject.anthropicKey || undefined,
					anthropicBaseUrl: newProject.anthropicBaseUrl || undefined,
					model: newProject.model || undefined,
				},
			});
			setNewProject({
				name: "",
				description: "",
				workspacePath: "",
				discordToken: "",
				discordChannel: "",
				anthropicKey: "",
				anthropicBaseUrl: "",
				model: "",
			});
			setCreating(false);
			fetchProjects();
		} catch (error) {
			console.error("Failed to create project:", error);
		}
	};

	const startProject = async (projectId: string) => {
		try {
			await apiStartProject(projectId);
			fetchProjects();
		} catch (error) {
			console.error("Failed to start project:", error);
		}
	};

	const stopProject = async (projectId: string) => {
		try {
			await apiStopProject(projectId);
			fetchProjects();
		} catch (error) {
			console.error("Failed to stop project:", error);
		}
	};

	const deleteProject = async (projectId: string) => {
		if (!confirm(`Delete project "${projectId}"? This cannot be undone.`)) return;
		try {
			await apiDeleteProject(projectId);
			fetchProjects();
		} catch (error) {
			console.error("Failed to delete project:", error);
		}
	};

	if (loading) {
		return (
			<div className="min-h-screen bg-gray-50 flex items-center justify-center">
				<div className="text-gray-500">Loading projects...</div>
			</div>
		);
	}

	if (error && projects.length === 0) {
		return (
			<div className="min-h-screen bg-gray-50 flex items-center justify-center">
				<div className="text-center max-w-md">
					<div className="text-red-600 mb-4">{error.message}</div>
					<button
						type="button"
						onClick={() => fetchProjects()}
						className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
					>
						<RefreshCw className="w-4 h-4" />
						Retry
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-gray-50">
			{/* Header */}
			<header className="border-b">
				<div className={cn(containerClassName, "py-4")}>
					<div className="flex items-center justify-between">
						<h1 className="text-2xl font-bold text-gray-900">Agent Projects</h1>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={() => fetchProjects()}
								className="flex items-center gap-2 px-3 py-2 bg-gray-50 text-gray-600 rounded-lg hover:bg-gray-100"
								title="Refresh"
							>
								<RefreshCw className="w-4 h-4" />
							</button>
							<button
								type="button"
								onClick={() => setCreating(true)}
								className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
							>
								<Plus className="w-4 h-4" />
								New Project
							</button>
						</div>
					</div>
				</div>
			</header>

			{/* Create Project Modal */}
			{creating && (
				<div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
					<div className="bg-white rounded-lg p-6 max-w-md w-full max-h-[90vh] overflow-y-auto">
						<h2 className="text-xl font-bold mb-4">Create New Project</h2>
						<div className="space-y-4">
							<div>
								<label className="block text-sm font-medium text-gray-700 mb-1">
									Project Name *
									<input
										type="text"
										value={newProject.name}
										onChange={(e) => setNewProject({ ...newProject, name: e.target.value })}
										className="w-full px-3 py-2 border border-gray-300 rounded-lg"
										placeholder="My Project"
									/>
								</label>
							</div>
							<div>
								<label className="block text-sm font-medium text-gray-700 mb-1">
									Description
									<input
										type="text"
										value={newProject.description}
										onChange={(e) => setNewProject({ ...newProject, description: e.target.value })}
										className="w-full px-3 py-2 border border-gray-300 rounded-lg"
										placeholder="Optional description"
									/>
								</label>
							</div>
							<div>
								<label className="block text-sm font-medium text-gray-700 mb-1">
									Workspace Path (optional)
									<input
										type="text"
										value={newProject.workspacePath}
										onChange={(e) => setNewProject({ ...newProject, workspacePath: e.target.value })}
										className="w-full px-3 py-2 border border-gray-300 rounded-lg"
										placeholder="/path/to/repo (leave empty for internal)"
									/>
								</label>
							</div>

							<div className="border-t border-gray-200 pt-4">
								<p className="text-sm font-semibold text-gray-700 mb-2">Discord</p>
								<div className="space-y-3">
									<input
										type="password"
										value={newProject.discordToken}
										onChange={(e) => setNewProject({ ...newProject, discordToken: e.target.value })}
										className="w-full px-3 py-2 border border-gray-300 rounded-lg"
										placeholder="Discord bot token (optional)"
									/>
									<input
										type="text"
										value={newProject.discordChannel}
										onChange={(e) => setNewProject({ ...newProject, discordChannel: e.target.value })}
										className="w-full px-3 py-2 border border-gray-300 rounded-lg"
										placeholder="Default Discord channel ID (optional)"
									/>
								</div>
							</div>

							<div className="border-t border-gray-200 pt-4">
								<p className="text-sm font-semibold text-gray-700 mb-2">Anthropic</p>
								<div className="space-y-3">
									<input
										type="password"
										value={newProject.anthropicKey}
										onChange={(e) => setNewProject({ ...newProject, anthropicKey: e.target.value })}
										className="w-full px-3 py-2 border border-gray-300 rounded-lg"
										placeholder="ANTHROPIC_API_KEY (sk-ant-...)"
									/>
									<input
										type="text"
										value={newProject.anthropicBaseUrl}
										onChange={(e) => setNewProject({ ...newProject, anthropicBaseUrl: e.target.value })}
										className="w-full px-3 py-2 border border-gray-300 rounded-lg"
										placeholder="Base URL (optional, e.g. https://api.anthropic.com)"
									/>
									<input
										type="text"
										value={newProject.model}
										onChange={(e) => setNewProject({ ...newProject, model: e.target.value })}
										className="w-full px-3 py-2 border border-gray-300 rounded-lg"
										placeholder="Model (optional, e.g. claude-sonnet-4-6)"
									/>
								</div>
							</div>
						</div>
						<div className="flex gap-2 mt-6">
							<button
								type="button"
								onClick={createProject}
								className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
							>
								Create
							</button>
							<button
								type="button"
								onClick={() => setCreating(false)}
								className="flex-1 px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300"
							>
								Cancel
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Projects Grid */}
			<main className={cn(containerClassName, "py-8")}>
				{projects.length === 0 ? (
					<div className="text-center py-12">
						<div className="text-gray-400 mb-4">No projects yet</div>
						<button type="button" onClick={() => setCreating(true)} className="text-blue-600 hover:text-blue-700">
							Create your first project
						</button>
					</div>
				) : (
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
						{projects.map((project) => (
							<div key={project.id} className="bg-white rounded-lg border border-gray-200 p-6 flex flex-col">
								{/* Status Indicator */}
								<div className="flex items-center justify-between mb-4">
									<Link
										to={`/projects/${project.id}`}
										className="text-lg font-semibold text-gray-900 hover:text-blue-600 hover:underline"
									>
										{project.name}
									</Link>
									<div className={`w-3 h-3 rounded-full ${project.dockerStatus.running ? "bg-green-500" : "bg-gray-300"}`} />
								</div>

								{project.description && <p className="text-sm text-gray-600 mb-4">{project.description}</p>}

								{/* Stats */}
								<div className="grid grid-cols-2 gap-4 mb-4">
									<div className="flex items-center gap-2 text-sm">
										<Database className="w-4 h-4 text-gray-400" />
										<span className="text-gray-600">{project.stats.sessions} sessions</span>
									</div>
									<div className="flex items-center gap-2 text-sm">
										<Activity className="w-4 h-4 text-gray-400" />
										<span className="text-gray-600">{project.stats.messages} messages</span>
									</div>
								</div>

								{/* Ports */}
								<div className="text-sm text-gray-600 mb-4">
									Server:{" "}
									<a
										href={`http://localhost:${project.ports.server}`}
										target="_blank"
										rel="noreferrer"
										className="text-blue-600 hover:underline"
									>
										:{project.ports.server}
									</a>
								</div>

								{/* Workspace */}
								<div className="flex items-center gap-2 text-sm text-gray-600 mb-4">
									<FolderOpen className="w-4 h-4" />
									<span className="truncate">{project.workspace.type}</span>
								</div>

								{/* Actions */}
								<div className="flex gap-2 mt-auto">
									{project.dockerStatus.running ? (
										<button
											type="button"
											onClick={() => stopProject(project.id)}
											className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-red-50 text-red-600 rounded-lg hover:bg-red-100"
										>
											<Square className="w-4 h-4" />
											Stop
										</button>
									) : (
										<button
											type="button"
											onClick={() => startProject(project.id)}
											className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-green-50 text-green-600 rounded-lg hover:bg-green-100"
										>
											<Play className="w-4 h-4" />
											Start
										</button>
									)}
									<Link
										to={`/projects/${project.id}`}
										className="flex items-center justify-center gap-2 px-3 py-2 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100"
										title="Open project details"
									>
										<ExternalLink className="w-4 h-4" />
									</Link>
									<button
										type="button"
										onClick={() => fetchProjects()}
										className="px-3 py-2 bg-gray-50 text-gray-600 rounded-lg hover:bg-gray-100"
									>
										<RefreshCw className="w-4 h-4" />
									</button>
									<button
										type="button"
										onClick={() => deleteProject(project.id)}
										className="px-3 py-2 bg-gray-50 text-red-600 rounded-lg hover:bg-red-50"
									>
										<Trash2 className="w-4 h-4" />
									</button>
								</div>
							</div>
						))}
					</div>
				)}
			</main>
		</div>
	);
}
