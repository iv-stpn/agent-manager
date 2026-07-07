import { AlertTriangle, Archive, CheckCircle2, Clock, PlayCircle, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import type { Report } from "@/lib/agent-api";
import { getReports } from "@/lib/agent-api";
import { mutateCache, useQuery } from "@/lib/query-cache";
import type { Project } from "@/lib/types";
import { byNewestFirst, cn, formatRelativeTime } from "@/lib/utils";

interface ReportsTabProps {
	projectId: string;
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

export function ReportsTab({ projectId }: ReportsTabProps) {
	const {
		data: reports = [],
		loading,
		error,
		refetch: fetchReports,
	} = useQuery<Report[]>(`reports:${projectId}`, async () => {
		const data = await getReports(projectId);

		mutateCache<Project>(`project:${projectId}`, (project) => ({
			...project,
			stats: { ...project.stats, reports: data.length },
		}));
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
				{[...reports].sort(byNewestFirst).map((report) => {
					const Icon = reportTriggerIcon[report.trigger] ?? Clock;
					return (
						<li key={report.id}>
							<Link to={`/projects/${projectId}/sessions/${report.sessionId}`} className="block hover:border-blue-400 transition">
								<div className={cn("rounded-lg border p-4 text-sm", reportStatusStyle[report.status] ?? "")}>
									<div className="flex items-center justify-between mb-2 gap-3">
										<div className="flex items-center gap-2 min-w-0">
											<Icon className="w-4 h-4 text-gray-400 shrink-0" />
											<span className="font-medium capitalize">{report.trigger} report</span>
											<span className="text-gray-300">·</span>
											<span className="text-gray-500 truncate" title={report.sessionTask}>
												{report.sessionName || report.sessionTask}
											</span>
										</div>
										<div className="flex items-center gap-2 text-xs text-gray-500 shrink-0">
											<span className="capitalize">{report.status}</span>
											<span>{formatRelativeTime(report.createdAt)}</span>
										</div>
									</div>
									<p className="text-gray-600 text-xs line-clamp-4 whitespace-pre-wrap">{report.summary}</p>
								</div>
							</Link>
						</li>
					);
				})}
			</ol>
		</div>
	);
}
