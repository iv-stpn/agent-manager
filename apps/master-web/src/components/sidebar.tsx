import { BarChart2, Home, LayoutTemplate, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { EnrichedProject } from "@/lib/agent-api";
import { createProject as apiCreateProject, createMasterStream, getProjects } from "@/lib/agent-api";
import { mutateCache, setCache, useQuery } from "@/lib/query-cache";
import { cn } from "@/lib/utils";

export function Sidebar() {
	const { pathname } = useLocation();
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("");

	const { data: projects = [] } = useQuery<EnrichedProject[]>("projects", () => getProjects());

	useEffect(() => {
		const es = createMasterStream(
			(type, { projectId, data }) => {
				if (type === "project_status") {
					const running = Boolean((data as { running?: boolean }).running);
					mutateCache<EnrichedProject[]>("projects", (list) =>
						list.map((p) => (p.id === projectId ? { ...p, dockerStatus: { ...p.dockerStatus, running } } : p))
					);
				} else if (type === "session_created") {
					mutateCache<EnrichedProject[]>("projects", (list) =>
						list.map((p) => (p.id === projectId ? { ...p, stats: { ...p.stats, sessions: p.stats.sessions + 1 } } : p))
					);
				}
			},
			(snapshot) => setCache("projects", snapshot as EnrichedProject[])
		);
		return () => es.close();
	}, []);

	const activeProjectId = pathname.match(/\/projects\/([^/]+)/)?.[1];

	async function createProject() {
		if (!name.trim()) return;
		try {
			await apiCreateProject({ name: name.trim() });
			setName("");
			setCreating(false);
		} catch (err) {
			console.error("Failed to create project:", err);
		}
	}

	const bottomLinks = [
		{ href: "/statistics", icon: BarChart2, label: "Statistics" },
		{ href: "/templates", icon: LayoutTemplate, label: "Templates" },
	];

	return (
		<>
			<aside className="fixed left-0 top-0 h-screen w-16 bg-gray-950 flex flex-col items-center py-3 z-30 border-r border-gray-800">
				{/* Logo */}
				<Link
					to="/"
					title="Agent Manager"
					className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white mb-4 shrink-0 hover:bg-blue-500 transition-colors"
				>
					<Home className="h-5 w-5" />
				</Link>

				{/* Projects list */}
				<div className="flex-1 flex flex-col items-center gap-2 overflow-y-auto w-full px-3 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
					{projects.map((project) => {
						const active = project.id === activeProjectId;
						return (
							<Link
								key={project.id}
								to={`/projects/${project.id}`}
								title={project.name}
								className={cn(
									"relative w-10 h-10 rounded-xl flex items-center justify-center text-sm font-semibold shrink-0 transition-all",
									active ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
								)}
							>
								{project.name.charAt(0).toUpperCase()}
								<span
									className={cn(
										"absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-gray-950",
										project.dockerStatus.running ? "bg-green-400" : "bg-gray-600"
									)}
								/>
							</Link>
						);
					})}

					{/* New project button */}
					<button
						type="button"
						onClick={() => setCreating(true)}
						title="New project"
						className="w-10 h-10 rounded-xl border-2 border-dashed border-gray-700 flex items-center justify-center text-gray-600 hover:border-gray-500 hover:text-gray-400 transition-all shrink-0"
					>
						<Plus className="w-4 h-4" />
					</button>
				</div>

				{/* Bottom nav */}
				<div className="flex flex-col items-center gap-1 border-t border-gray-800 pt-3 w-full px-3">
					{bottomLinks.map(({ href, icon: Icon, label }) => (
						<Link
							key={href}
							to={href}
							title={label}
							className={cn(
								"w-10 h-10 rounded-xl flex items-center justify-center transition-all",
								pathname === href ? "bg-blue-600 text-white" : "text-gray-500 hover:text-gray-300 hover:bg-gray-800"
							)}
						>
							<Icon className="w-5 h-5" />
						</Link>
					))}
				</div>
			</aside>

			{/* Create project dialog */}
			{creating && (
				<div
					className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
					onClick={() => setCreating(false)}
					onKeyDown={(e) => e.key === "Escape" && setCreating(false)}
					role="dialog"
					aria-modal="true"
					aria-label="Create new project"
				>
					<div className="bg-white rounded-xl p-6 w-80 shadow-2xl" onClick={(e) => e.stopPropagation()}>
						<div className="flex items-center justify-between mb-4">
							<h2 className="text-base font-semibold text-gray-900">New Project</h2>
							<button type="button" onClick={() => setCreating(false)} className="text-gray-400 hover:text-gray-600">
								<X className="w-4 h-4" />
							</button>
						</div>
						<input
							// biome-ignore lint/a11y/noAutofocus: intentional focus for modal
							autoFocus
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && createProject()}
							className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
							placeholder="Project name"
						/>
						<div className="flex gap-2">
							<button
								type="button"
								onClick={createProject}
								disabled={!name.trim()}
								className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
							>
								Create
							</button>
							<button
								type="button"
								onClick={() => setCreating(false)}
								className="flex-1 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200"
							>
								Cancel
							</button>
						</div>
					</div>
				</div>
			)}
		</>
	);
}
