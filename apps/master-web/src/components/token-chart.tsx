"use client";

import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Message } from "@/lib/agent-api";
import { formatTokens } from "@/lib/utils";

interface Props {
	messages: Message[];
}

export function TokenChart({ messages }: Props) {
	// Estimate system prompt + tool definition tokens: the first message that
	// reads the cache replays the constant system prompt + tool definitions, so
	// its cacheReadTokens is a good proxy. Those same tokens reappear as cache
	// reads on every subsequent turn.
	const firstCacheRead = messages.find((m) => (m.role === "assistant" || m.role === "system") && (m.cacheReadTokens ?? 0) > 0);
	const systemPromptTokens = firstCacheRead?.cacheReadTokens ?? 0;

	let cumulativeInput = 0;
	let cumulativeOutput = 0;
	let cumulativeCacheRead = 0;
	let cumulativeCacheWrite = 0;

	const data = messages
		.filter((m) => (m.role === "assistant" || m.role === "system") && (m.inputTokens ?? 0) > 0)
		.map((m, i) => {
			cumulativeInput += m.inputTokens ?? 0;
			cumulativeOutput += m.outputTokens ?? 0;
			cumulativeCacheRead += m.cacheReadTokens ?? 0;
			cumulativeCacheWrite += m.cacheWriteTokens ?? 0;
			return {
				turn: i + 1,
				cumInput: cumulativeInput,
				cumOutput: cumulativeOutput,
				cumCacheRead: cumulativeCacheRead,
				cumCacheWrite: cumulativeCacheWrite,
			};
		});

	if (data.length === 0) {
		return <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">No token data yet</div>;
	}

	return (
		<div className="space-y-2">
			{systemPromptTokens > 0 && (
				<div className="flex items-center justify-between rounded-md border border-orange-300 bg-orange-50 dark:bg-orange-950/20 px-3 py-2 text-xs">
					<span className="text-muted-foreground">System prompt + tool definitions</span>
					<span className="font-mono font-semibold text-orange-600 dark:text-orange-400">
						{formatTokens(systemPromptTokens)} / turn
					</span>
				</div>
			)}
			<ResponsiveContainer width="100%" height={200}>
				<AreaChart data={data} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
					<CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
					<XAxis
						dataKey="turn"
						tick={{ fontSize: 11 }}
						label={{ value: "Turn", position: "insideBottomRight", offset: -4, fontSize: 11 }}
					/>
					<YAxis tick={{ fontSize: 11 }} tickFormatter={formatTokens} />
					<Tooltip
						formatter={(value: number, name: string) => [
							formatTokens(value),
							name === "cumInput"
								? "Cumulative input"
								: name === "cumOutput"
									? "Cumulative output"
									: name === "cumCacheRead"
										? "Cumulative cache read"
										: "Cumulative cache write",
						]}
					/>
					<Legend
						formatter={(value) =>
							value === "cumInput"
								? "Input tokens"
								: value === "cumOutput"
									? "Output tokens"
									: value === "cumCacheRead"
										? "Cache read tokens"
										: "Cache write tokens"
						}
					/>
					<Area type="monotone" dataKey="cumInput" stroke="#6366f1" fill="#6366f133" strokeWidth={2} />
					<Area type="monotone" dataKey="cumOutput" stroke="#22c55e" fill="#22c55e33" strokeWidth={2} />
					<Area type="monotone" dataKey="cumCacheRead" stroke="#f59e0b" fill="#f59e0b33" strokeWidth={2} />
					<Area type="monotone" dataKey="cumCacheWrite" stroke="#0ea5e9" fill="#0ea5e933" strokeWidth={2} />
				</AreaChart>
			</ResponsiveContainer>
		</div>
	);
}
