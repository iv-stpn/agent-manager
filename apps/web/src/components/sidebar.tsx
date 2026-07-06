import { BarChart2, BookOpen, Home, Key, Layers, Plus, Tags } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { NewProjectDialog } from "@/components/dialog/new-project-dialog";
import { getProjects } from "@/lib/agent-api";
import { useQuery } from "@/lib/query-cache";
import { useOrchestratorSSE } from "@/lib/stores";
import { byNewestFirst, cn } from "@/lib/utils";

export function Sidebar() {
	const { pathname } = useLocation();
	const [creating, setCreating] = useState(false);

	const { data: projects = [] } = useQuery("projects", () => getProjects());

	// Shared orchestrator stream — ref-counted, so mounting it here and on the home page
	// opens exactly one connection and folds each event into "projects" once.
	useOrchestratorSSE();

	const activeProjectId = pathname.match(/\/projects\/([^/]+)/)?.[1];

	const bottomLinks = [
		{ href: "/statistics", icon: BarChart2, label: "Statistics" },
		{ href: "/llm-clients", icon: Key, label: "LLM Clients" },
		{ href: "/tech-stacks", icon: Layers, label: "Tech Stacks" },
		{ href: "/guidelines", icon: BookOpen, label: "Guidelines" },
		{ href: "/guideline-categories", icon: Tags, label: "Guideline Categories" },
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
					{[...projects].sort(byNewestFirst).map((project) => {
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

			<NewProjectDialog open={creating} onOpenChange={setCreating} />
		</>
	);
}
