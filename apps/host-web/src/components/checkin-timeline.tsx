import { AlertTriangle, CheckCircle2, Clock, PlayCircle } from "lucide-react";
import { Markdown } from "@/components/markdown";
import type { Checkin, Question } from "@/lib/agent-api";
import { cn, formatRelativeTime } from "@/lib/utils";

const triggerIcon = {
	timer: Clock,
	urgent: AlertTriangle,
	manual: PlayCircle,
	completion: CheckCircle2,
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
}

export function CheckinTimeline({ checkins, questions }: Props) {
	if (checkins.length === 0) {
		return <p className="text-sm text-muted-foreground text-center py-8">No check-ins yet</p>;
	}

	return (
		<ol className="relative border-l border-border ml-3">
			{checkins.map((ci) => {
				const Icon = triggerIcon[ci.trigger] ?? Clock;
				const ciQuestions = questions.filter((q) => q.checkinId === ci.id);

				return (
					<li key={ci.id} className="mb-6 ml-6">
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
							{ciQuestions.length > 0 && (
								<div className="space-y-1">
									{ciQuestions.map((q) => (
										<div key={q.id} className="text-xs">
											<span className="font-medium">Q: </span>
											<span className="text-muted-foreground">{q.text}</span>
											{q.answer && (
												<>
													<br />
													<span className="font-medium text-green-700 dark:text-green-400">A: </span>
													<span className="text-muted-foreground">{q.answer}</span>
												</>
											)}
										</div>
									))}
								</div>
							)}
						</div>
					</li>
				);
			})}
		</ol>
	);
}
