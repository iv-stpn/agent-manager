import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { NewSessionDialog } from "@/components/dialog/new-session-dialog";
import { SessionCard } from "@/components/session-card";
import { mutateCache, useQuery } from "@/lib/query-cache";
import { getSessions } from "@/lib/agent-api";
import type { Project } from "@/lib/types";

interface SessionsTabProps {
	projectId: string;
	running: boolean;
	dialogOpen: boolean;
	setDialogOpen: (open: boolean) => void;
}

export function SessionsTab({ projectId, running, dialogOpen, setDialogOpen }: SessionsTabProps) {
	// Initial load (and read-only fallback when the project is stopped). While
	// running, the project SSE stream in the parent keeps this cache live.
	const {
		data: sessions = [],
		loading,
		error,
		refetch: fetchSessions,
	} = useQuery(`sessions:${projectId}`, async () => {
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
	const finished = sessions.filter((s) => s.status === "completed" || s.status === "aborted" || s.status === "error");

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
