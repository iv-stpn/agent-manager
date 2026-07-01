import { Activity, Database, FolderOpen, RefreshCw } from "lucide-react";
import type { Project } from "@/lib/types";
import { StatCard } from "./StatCard";

interface OverviewTabProps {
	project: Project;
}

export function OverviewTab({ project }: OverviewTabProps) {
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
