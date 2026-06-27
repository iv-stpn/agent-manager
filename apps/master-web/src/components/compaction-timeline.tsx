"use client";

import { Markdown } from "@/components/markdown";
import type { Compaction } from "@/lib/agent-api";
import { formatRelativeTime, formatTokens } from "@/lib/utils";
import { Scissors } from "lucide-react";

interface Props {
	compactions: Compaction[];
}

export function CompactionTimeline({ compactions }: Props) {
	if (compactions.length === 0) {
		return (
			<p className="text-sm text-muted-foreground text-center py-8">
				No compactions yet. Context is compacted automatically once it crosses the compact token threshold.
			</p>
		);
	}

	return (
		<ol className="relative border-l border-border ml-3">
			{compactions.map((c) => {
				const tokenDrop = c.tokensBefore - c.tokensAfter;
				const pct = c.tokensBefore > 0 ? Math.round((tokenDrop / c.tokensBefore) * 100) : 0;

				return (
					<li key={c.id} className="mb-6 ml-6">
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
			})}
		</ol>
	);
}
