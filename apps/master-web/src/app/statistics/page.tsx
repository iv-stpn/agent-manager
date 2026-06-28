import { Activity, Database, Play } from "lucide-react";
import type { EnrichedProject } from "@/lib/agent-api";
import { getProjects } from "@/lib/agent-api";
import { useQuery } from "@/lib/query-cache";

function StatCard({
	icon: Icon,
	label,
	value,
	sub,
}: {
	icon: typeof Database;
	label: string;
	value: string | number;
	sub?: string;
}) {
	return (
		<div className="bg-white rounded-xl border border-gray-200 p-5 flex items-center gap-4">
			<div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center shrink-0">
				<Icon className="w-5 h-5 text-blue-600" />
			</div>
			<div>
				<div className="text-xs text-gray-500 uppercase tracking-wide font-medium">{label}</div>
				<div className="text-2xl font-bold text-gray-900">{value}</div>
				{sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
			</div>
		</div>
	);
}

export default function StatisticsPage() {
	const { data: projects = [], loading } = useQuery<EnrichedProject[]>("projects", () => getProjects());

	const running = projects.filter((p) => p.dockerStatus.running).length;
	const stopped = projects.length - running;
	const totalSessions = projects.reduce((sum, p) => sum + p.stats.sessions, 0);
	const totalMessages = projects.reduce((sum, p) => sum + p.stats.messages, 0);

	return (
		<div className="min-h-screen bg-gray-50">
			<header className="bg-white border-b px-6 py-4">
				<h1 className="text-xl font-bold text-gray-900">Statistics</h1>
				<p className="text-sm text-gray-500 mt-0.5">Aggregate metrics across all projects</p>
			</header>

			<main className="max-w-4xl mx-auto px-6 py-8 space-y-8">
				{loading && projects.length === 0 ? (
					<div className="text-gray-500 text-center py-16">Loading...</div>
				) : (
					<>
						<section className="grid grid-cols-2 md:grid-cols-4 gap-4">
							<StatCard icon={Database} label="Projects" value={projects.length} />
							<StatCard icon={Play} label="Running" value={running} sub={`${stopped} stopped`} />
							<StatCard icon={Activity} label="Sessions" value={totalSessions} sub="all time" />
							<StatCard icon={Activity} label="Messages" value={totalMessages} sub="all time" />
						</section>

						<section>
							<h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Projects</h2>
							<div className="space-y-2">
								{projects.map((p) => (
									<div key={p.id} className="bg-white rounded-xl border border-gray-200 px-4 py-3 flex items-center gap-3">
										<span
											className={`w-2 h-2 rounded-full shrink-0 ${p.dockerStatus.running ? "bg-green-400" : "bg-gray-300"}`}
										/>
										<span className="font-medium text-gray-900 flex-1 truncate">{p.name}</span>
										<span className="text-sm text-gray-500">{p.stats.sessions} sessions</span>
										<span className="text-sm text-gray-400">{p.stats.messages} msgs</span>
									</div>
								))}
								{projects.length === 0 && <p className="text-gray-400 text-sm py-4 text-center">No projects yet.</p>}
							</div>
						</section>
					</>
				)}
			</main>
		</div>
	);
}
