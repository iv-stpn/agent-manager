import { Archive, ArchiveRestore, ArrowRight, Bot, Clock, Coins } from "lucide-react";
import type { MouseEvent } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { Session } from "@/lib/agent-api";
import { cn, formatRelativeTime, formatTokens, statusBg } from "@/lib/utils";

export function SessionCard({
	session,
	projectId,
	onArchive,
}: {
	session: Session;
	projectId: string;
	onArchive?: (session: Session) => void;
}) {
	const handleArchive = (event: MouseEvent) => {
		// The card is a Link — keep the archive click from navigating into the session.
		event.preventDefault();
		event.stopPropagation();
		onArchive?.(session);
	};

	return (
		<Link to={`/projects/${projectId}/sessions/${session.id}`}>
			<Card className="hover:border-primary/50 hover:shadow-md transition-all cursor-pointer group">
				<CardHeader className="pb-3">
					<div className="flex items-start justify-between gap-3">
						<div className="flex items-start gap-2 min-w-0 flex-1">
							<Bot className="mt-0.5 h-4 w-4 text-muted-foreground shrink-0" />
							<div className="min-w-0 flex-1">
								{session.name && <p className="text-sm font-semibold truncate">{session.name}</p>}
								<p className="text-xs text-muted-foreground line-clamp-2" title={session.task}>
									{session.task}
								</p>
							</div>
						</div>
						<div className="flex items-center gap-1 shrink-0">
							<Badge className={cn("capitalize", statusBg(session.status))}>{session.status}</Badge>
							{onArchive && (
								<Button
									variant="ghost"
									size="icon"
									onClick={handleArchive}
									title={session.archived ? "Restore session" : "Archive session"}
								>
									{session.archived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
								</Button>
							)}
						</div>
					</div>
				</CardHeader>
				<CardContent>
					<div className="flex items-center gap-4 text-xs text-muted-foreground">
						<span className="flex items-center gap-1">
							<Coins className="h-3 w-3" />
							in {formatTokens(session.totalInputTokens)} · out {formatTokens(session.totalOutputTokens)} · cache read{" "}
							{formatTokens(session.totalCacheReadTokens)} · cache write {formatTokens(session.totalCacheWriteTokens)}
						</span>
						<span className="flex items-center gap-1">
							<Clock className="h-3 w-3" />
							{session.reportIntervalMins}m reports
						</span>
						<span className="flex items-center gap-1 ml-auto">{formatRelativeTime(session.createdAt)}</span>
						<ArrowRight className="h-3 w-3 group-hover:translate-x-1 transition-transform" />
					</div>
				</CardContent>
			</Card>
		</Link>
	);
}
