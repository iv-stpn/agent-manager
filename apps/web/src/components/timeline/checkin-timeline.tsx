import { AlertTriangle, Archive, CheckCircle2, Clock, PlayCircle, Scissors } from "lucide-react";
import { Markdown } from "@/components/markdown";
import type { Checkin, Compaction, Question } from "@/lib/agent-api";
import { cn, formatRelativeTime, formatTokens } from "@/lib/utils";

const triggerIcon = {
	timer: Clock,
	urgent: AlertTriangle,
	manual: PlayCircle,
	completion: CheckCircle2,
	compaction: Archive,
};

const statusStyle = {
	pending: "border-yellow-400 bg-yellow-50 dark:bg-yellow-950/20",
	answered: "border-green-400 bg-green-50 dark:bg-green-950/20",
	skipped: "border-gray-300 bg-gray-50 dark:bg-gray-950/20",
	timeout: "border-red-300 bg-red-50 dark:bg-red-950/20",
};

interface Props {
	checkins: Checkin[];
	questions: Question[];
	compactions?: Compaction[];
	mode?: "full" | "sinceLastCompaction";
}

type TimelineItem = { kind: "checkin"; ci: Checkin } | { kind: "compaction"; c: Compaction };

export function CheckinTimeline({ checkins, questions, compactions = [], mode = "full" }: Props) {
	if (checkins.length === 0 && compactions.length === 0) {
		return <p className="text-sm text-muted-foreground text-center py-8">No check-ins yet</p>;
	}

	// Merge check-ins and compactions into a single chronological timeline.
	// Both are fetched ascending by createdAt, so a stable sort keeps equal
	// timestamps in their original order.
	// Filter out compaction-triggered checkins since we display compactions separately.
	let items: TimelineItem[] = [
		...checkins.filter((checkin) => checkin.trigger !== "compaction").map((ci) => ({ kind: "checkin" as const, ci })),
		...compactions.map((compaction) => ({ kind: "compaction" as const, c: compaction })),
	].sort((timelineItem1, timelineItem2) => timeOf(timelineItem1) - timeOf(timelineItem2));

	// Filter to items since last compaction when in that mode
	if (mode === "sinceLastCompaction" && compactions.length > 0) {
		const lastCompactionTime = compactions[compactions.length - 1].createdAt;
		items = items.filter((item) => timeOf(item) >= lastCompactionTime);
	}

	if (items.length === 0) {
		return <p className="text-sm text-muted-foreground text-center py-8">No items in this view</p>;
	}

	return (
		<ol className="relative border-l border-border ml-3">
			{items.map((item) =>
				item.kind === "checkin" ? (
					<CheckinItem key={`ci-${item.ci.id}`} ci={item.ci} questions={questions} />
				) : (
					<CompactionItem key={`cp-${item.c.id}`} c={item.c} />
				)
			)}
		</ol>
	);
}

function timeOf(item: TimelineItem): number {
	return item.kind === "checkin" ? item.ci.createdAt : item.c.createdAt;
}

function CheckinItem({ ci, questions }: { ci: Checkin; questions: Question[] }) {
	const Icon = triggerIcon[ci.trigger] ?? Clock;
	const checkInQuestions = questions.filter((question) => question.checkinId === ci.id);

	return (
		<li className="mb-6 ml-6">
			<span className="absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full border bg-background">
				<Icon className="h-3 w-3 text-muted-foreground" />
			</span>
			<div className={cn("rounded-lg border p-3 text-sm", statusStyle[ci.status] ?? "")}>
				<div className="flex items-center justify-between mb-1">
					<span className="font-medium capitalize">{ci.trigger} check-in</span>
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<span className="capitalize">{ci.status}</span>
						<span>{formatRelativeTime(ci.createdAt)}</span>
					</div>
				</div>
				<Markdown className="text-muted-foreground text-xs line-clamp-3 mb-2">{ci.summary}</Markdown>
				{checkInQuestions.length > 0 && (
					<div className="space-y-1">
						{checkInQuestions.map((question) => (
							<div key={question.id} className="text-xs">
								<span className="font-medium">Q: </span>
								<span className="text-muted-foreground">{question.text}</span>
								{question.answer && (
									<>
										<br />
										<span className="font-medium text-green-700 dark:text-green-400">A: </span>
										<span className="text-muted-foreground">{question.answer}</span>
									</>
								)}
							</div>
						))}
					</div>
				)}
			</div>
		</li>
	);
}

function CompactionItem({ c }: { c: Compaction }) {
	const tokenDrop = c.tokensBefore - c.tokensAfter;
	const pct = c.tokensBefore > 0 ? Math.round((tokenDrop / c.tokensBefore) * 100) : 0;

	return (
		<li className="mb-6 ml-6">
			<span className="absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full border bg-background">
				<Scissors className="h-3 w-3 text-muted-foreground" />
			</span>
			<div className="rounded-lg border border-purple-300 bg-purple-50 dark:bg-purple-950/20 p-3 text-sm">
				<div className="flex items-center justify-between mb-1">
					<span className="font-medium">Context compacted</span>
					<span className="text-xs text-muted-foreground">{formatRelativeTime(c.createdAt)}</span>
				</div>
				<div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground mb-2">
					<div className="flex justify-between">
						<span>Messages</span>
						<span className="font-mono">
							{c.messagesBefore} → {c.messagesAfter}
						</span>
					</div>
					<div className="flex justify-between">
						<span>Tokens</span>
						<span className="font-mono">
							{formatTokens(c.tokensBefore)} → {formatTokens(c.tokensAfter)}
						</span>
					</div>
					<div className="flex justify-between">
						<span>Reclaimed</span>
						<span className="font-mono text-green-600 dark:text-green-400">
							−{formatTokens(tokenDrop)} ({pct}%)
						</span>
					</div>
					<div className="flex justify-between">
						<span>Threshold</span>
						<span className="font-mono">{formatTokens(c.thresholdTokens)}</span>
					</div>
				</div>
				{c.summary && <Markdown className="text-muted-foreground text-xs line-clamp-4 border-t pt-2">{c.summary}</Markdown>}
			</div>
		</li>
	);
}
