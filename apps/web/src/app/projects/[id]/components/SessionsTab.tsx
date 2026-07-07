import { Archive, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { NewSessionDialog } from "@/components/dialog/new-session-dialog";
import { SessionCard } from "@/components/session-card";
import { Button } from "@/components/ui/button";
import { ViewToggle } from "@/components/ui/view-toggle";
import type { Session } from "@/lib/agent-api";
import { archiveFinishedSessions, archiveSession, getSessions } from "@/lib/agent-api";
import { mutateCache, useQuery } from "@/lib/query-cache";
import type { Project } from "@/lib/types";
import { byNewestFirst } from "@/lib/utils";

interface SessionsTabProps {
	projectId: string;
	running: boolean;
	dialogOpen: boolean;
	setDialogOpen: (open: boolean) => void;
}

export function SessionsTab({ projectId, running, dialogOpen, setDialogOpen }: SessionsTabProps) {
	const [view, setView] = useState<"active" | "archived">("active");
	const [archivingAll, setArchivingAll] = useState(false);

	// Initial load (and read-only fallback when the project is stopped). While
	// running, the project SSE stream in the parent keeps this cache live.
	const {
		data: sessions = [],
		loading,
		error,
		refetch: fetchSessions,
	} = useQuery(`sessions:${projectId}`, async () => {
		const data = await getSessions(projectId);
		mutateCache<Project>(`project:${projectId}`, (project) => ({
			...project,
			stats: { ...project.stats, sessions: data.length },
		}));
		return data;
	});

	const toggleArchive = async (session: Session) => {
		try {
			await archiveSession(projectId, session.id, !session.archived);
			mutateCache<Session[]>(`sessions:${projectId}`, (prev) =>
				prev.map((s) => (s.id === session.id ? { ...s, archived: !session.archived } : s))
			);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to archive session");
		}
	};

	const archiveAllFinished = async () => {
		setArchivingAll(true);
		try {
			const count = await archiveFinishedSessions(projectId);
			fetchSessions();
			toast.success(
				count > 0 ? `Archived ${count} finished session${count === 1 ? "" : "s"}` : "No finished sessions to archive"
			);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to archive finished sessions");
		} finally {
			setArchivingAll(false);
		}
	};

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

	const sorted = [...sessions].sort(byNewestFirst);
	const notArchived = sorted.filter((session) => !session.archived);
	const archived = sorted.filter((session) => session.archived);
	const shown = view === "archived" ? archived : notArchived;
	const active = shown.filter(
		(session) => session.status === "running" || session.status === "paused" || session.status === "compacting"
	);
	const finished = shown.filter(
		(session) => session.status === "completed" || session.status === "aborted" || session.status === "error"
	);

	return (
		<div className="space-y-6">
			{!running && (
				<div className="text-sm text-gray-600 bg-amber-50 border border-amber-200 rounded-lg p-3">
					Project is not running — showing sessions from the database (read-only). Start the project to create sessions or
					interact.
				</div>
			)}
			<div className="flex items-center justify-between gap-3">
				<ViewToggle
					value={view}
					onChange={setView}
					options={[
						{ value: "active", label: "Active", count: notArchived.length },
						{ value: "archived", label: "Archived", count: archived.length },
					]}
				/>
				<div className="flex gap-2">
					{view === "active" && finished.length > 0 && (
						<Button variant="secondary" size="sm" onClick={archiveAllFinished} disabled={archivingAll}>
							{archivingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />}
							Archive finished
						</Button>
					)}
					<Button variant="secondary" size="icon" onClick={fetchSessions} title="Refresh sessions" aria-label="Refresh sessions">
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

			{shown.length === 0 ? (
				<div className="text-center py-12 space-y-3">
					<p className="text-gray-400">{view === "archived" ? "No archived sessions" : "No sessions yet"}</p>
					{view === "active" &&
						(running ? (
							<button type="button" onClick={() => setDialogOpen(true)} className="text-blue-600 hover:text-blue-700">
								Start your first agent
							</button>
						) : (
							<p className="text-sm text-gray-500">Start the project to create a session.</p>
						))}
				</div>
			) : (
				<div className="space-y-6">
					{active.length > 0 && (
						<section>
							<h2 className="text-sm font-medium text-gray-500 mb-3 uppercase tracking-wide">Active</h2>
							<div className="grid gap-3">
								{active.map((session) => (
									<SessionCard key={session.id} session={session} projectId={projectId} onArchive={toggleArchive} />
								))}
							</div>
						</section>
					)}
					{finished.length > 0 && (
						<section>
							<h2 className="text-sm font-medium text-gray-500 mb-3 uppercase tracking-wide">Finished</h2>
							<div className="grid gap-3">
								{finished.map((session) => (
									<SessionCard key={session.id} session={session} projectId={projectId} onArchive={toggleArchive} />
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
