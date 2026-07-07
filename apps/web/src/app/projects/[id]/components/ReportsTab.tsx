import { AlertTriangle, Archive, ArchiveRestore, CheckCircle2, Clock, Loader2, PlayCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ViewToggle } from "@/components/ui/view-toggle";
import type { Report } from "@/lib/agent-api";
import { archiveFinishedSessionReports, archiveReport, getReports } from "@/lib/agent-api";
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

function reportsKey(projectId: string) {
	return `reports:${projectId}`;
}

export function ReportsTab({ projectId }: ReportsTabProps) {
	const [view, setView] = useState<"active" | "archived">("active");
	const [archivingAll, setArchivingAll] = useState(false);
	const {
		data: reports = [],
		loading,
		error,
		refetch: fetchReports,
	} = useQuery<Report[]>(reportsKey(projectId), async () => {
		const data = await getReports(projectId);

		mutateCache<Project>(`project:${projectId}`, (project) => ({
			...project,
			stats: { ...project.stats, reports: data.length },
		}));
		return data;
	});

	const toggleArchive = async (report: Report) => {
		try {
			await archiveReport(projectId, report.id, !report.archived);
			mutateCache<Report[]>(reportsKey(projectId), (prev) =>
				prev.map((r) => (r.id === report.id ? { ...r, archived: !report.archived } : r))
			);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to archive report");
		}
	};

	const archiveAllFinished = async () => {
		setArchivingAll(true);
		try {
			const count = await archiveFinishedSessionReports(projectId);
			fetchReports();
			toast.success(
				count > 0
					? `Archived ${count} report${count === 1 ? "" : "s"} from finished sessions`
					: "No reports from finished sessions to archive"
			);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to archive reports");
		} finally {
			setArchivingAll(false);
		}
	};

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

	const sorted = [...reports].sort(byNewestFirst);
	const notArchived = sorted.filter((report) => !report.archived);
	const archived = sorted.filter((report) => report.archived);
	const shown = view === "archived" ? archived : notArchived;

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between gap-3">
				<ViewToggle
					value={view}
					onChange={setView}
					options={[
						{ value: "active", label: "Active", count: notArchived.length },
						{ value: "archived", label: "Archived", count: archived.length },
					]}
				/>
				<div className="flex items-center gap-2">
					{view === "active" && notArchived.length > 0 && (
						<Button
							variant="secondary"
							size="sm"
							onClick={archiveAllFinished}
							disabled={archivingAll}
							title="Archive all reports from finished (completed/aborted/errored) sessions"
						>
							{archivingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />}
							Archive finished
						</Button>
					)}
					<Button variant="secondary" size="icon" onClick={fetchReports} title="Refresh reports">
						<RefreshCw className="w-4 h-4" />
					</Button>
				</div>
			</div>

			{shown.length === 0 ? (
				<div className="text-center py-12 space-y-2">
					<p className="text-gray-400">{view === "archived" ? "No archived reports" : "No reports yet"}</p>
					{view === "active" && (
						<p className="text-sm text-gray-500">Reports appear here as the agent checks in across all sessions.</p>
					)}
				</div>
			) : (
				<ol className="space-y-3">
					{shown.map((report) => {
						const Icon = reportTriggerIcon[report.trigger] ?? Clock;
						return (
							<li key={report.id} className="relative">
								<Link
									to={`/projects/${projectId}/sessions/${report.sessionId}`}
									className="block hover:border-blue-400 transition"
								>
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
										<p className="text-gray-600 text-xs line-clamp-4 whitespace-pre-wrap pr-8">{report.summary}</p>
									</div>
								</Link>
								<Button
									variant="ghost"
									size="icon"
									onClick={() => toggleArchive(report)}
									title={report.archived ? "Restore report" : "Archive report"}
									className="absolute bottom-2 right-2 h-7 w-7 bg-white/70 hover:bg-white"
								>
									{report.archived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
								</Button>
							</li>
						);
					})}
				</ol>
			)}
		</div>
	);
}
