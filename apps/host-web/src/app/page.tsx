import { Activity, Database, ExternalLink, FolderOpen, Play, Plus, RefreshCw, Square, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { NewProjectDialog } from "@/components/new-project-dialog";
import { API_URL } from "@/constants";
import { containerClassName } from "@/lib/classes";
import { createHostStream } from "@/lib/host-stream";
import { cn } from "@/lib/utils";
import {
	deleteProject as apiDeleteProject,
	startProject as apiStartProject,
	stopProject as apiStopProject,
	getProjects,
} from "../lib/agent-api";
import { mutateCache, setCache, useQuery } from "../lib/query-cache";
import type { EnrichedProject as Project } from "../lib/types";

export default function Home() {
	const [creating, setCreating] = useState(false);

	const {
		data: projects = [],
		loading,
		error,
		refetch: fetchProjects,
	} = useQuery("projects", async () => {
		try {
			return await getProjects(AbortSignal.timeout(8000));
		} catch (err) {
			if (err instanceof DOMException && err.name === "TimeoutError") {
				throw new Error(`Could not reach the API at ${API_URL} (timed out). Is host-api running?`);
			}
			throw new Error(`Failed to fetch projects from ${API_URL}. Is host-api running?`);
		}
	});

	useEffect(() => {
		const patch = (projectId: string, fn: (p: Project) => Project) =>
			mutateCache<Project[]>("projects", (list) => list.map((p) => (p.id === projectId ? fn(p) : p)));

		const es = createHostStream<Project>(
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
			(snapshot) => setCache("projects", snapshot)
		);
		return () => es.close();
	}, []);

	const startProject = async (projectId: string) => {
		try {
			await apiStartProject(projectId);
			fetchProjects();
			toast.success("Project started");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to start project");
		}
	};

	const stopProject = async (projectId: string) => {
		try {
			await apiStopProject(projectId);
			fetchProjects();
			toast.success("Project stopped");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to stop project");
		}
	};

	const deleteProject = async (projectId: string) => {
		if (!confirm(`Delete project "${projectId}"? This cannot be undone.`)) return;
		try {
			await apiDeleteProject(projectId);
			fetchProjects();
			toast.success("Project deleted");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to delete project");
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

			<NewProjectDialog open={creating} onOpenChange={setCreating} />

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
