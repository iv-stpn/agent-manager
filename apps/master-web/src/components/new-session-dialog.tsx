"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createSession } from "@/lib/agent-api";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
}

export function NewSessionDialog({ open, onOpenChange, projectId }: Props) {
	const router = useRouter();
	const [task, setTask] = useState("");
	const [reportIntervalMins, setReportIntervalMins] = useState("15");
	const [totalTimeoutMins, setTotalTimeoutMins] = useState("240");
	const [channelId, setChannelId] = useState("");
	const [freezeReportMode, setFreezeReportMode] = useState<"always" | "never" | "custom">("never");
	const [freezeReportCustomRule, setFreezeReportCustomRule] = useState("");
	const [freezeAskMode, setFreezeAskMode] = useState<"always" | "requiredOnly" | "onReportOnly" | "never">("always");
	const [compactThreshold, setCompactThreshold] = useState("80000");
	const [stopThreshold, setStopThreshold] = useState("400000");
	const [alwaysImproveMode, setAlwaysImproveMode] = useState<"yes" | "no" | "custom">("no");
	const [alwaysImproveScope, setAlwaysImproveScope] = useState("");
	const [loading, setLoading] = useState(false);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!task.trim()) return;
		setLoading(true);
		try {
			const session = await createSession(projectId, {
				task,
				reportIntervalMins: Number(reportIntervalMins) || 15,
				totalTimeoutMins: Number(totalTimeoutMins) || 240,
				discordChannelId: channelId || undefined,
				freezeReportMode,
				freezeReportCustomRule: freezeReportCustomRule || undefined,
				freezeAskMode,
				compactThresholdTokens: Number(compactThreshold) || 80_000,
				stopThresholdTokens: Number(stopThreshold) || 400_000,
				alwaysImproveMode,
				alwaysImproveScope: alwaysImproveScope || undefined,
			});
			onOpenChange(false);
			setTask("");
			router.push(`/projects/${projectId}/sessions/${session.id}`);
		} finally {
			setLoading(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[640px] max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>New Agent Session</DialogTitle>
				</DialogHeader>
				<form onSubmit={handleSubmit} className="space-y-5">
					{/* Task */}
					<div className="space-y-2">
						<Label htmlFor="task">Task</Label>
						<Textarea
							id="task"
							placeholder="Describe what the agent should do..."
							value={task}
							onChange={(e) => setTask(e.target.value)}
							rows={5}
							required
						/>
					</div>

					{/* Timing */}
					<div className="grid grid-cols-2 gap-4">
						<div className="space-y-2">
							<Label htmlFor="report-interval">Report interval (mins)</Label>
							<Input
								id="report-interval"
								type="number"
								min="0"
								max="240"
								value={reportIntervalMins}
								onChange={(e) => setReportIntervalMins(e.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="total-timeout">Total timeout (mins)</Label>
							<Input
								id="total-timeout"
								type="number"
								min="1"
								max="1440"
								value={totalTimeoutMins}
								onChange={(e) => setTotalTimeoutMins(e.target.value)}
							/>
						</div>
					</div>

					{/* Token thresholds */}
					<div className="grid grid-cols-2 gap-4">
						<div className="space-y-2">
							<Label htmlFor="compact-threshold">Compact threshold (tokens)</Label>
							<Input
								id="compact-threshold"
								type="number"
								min="0"
								step="10000"
								value={compactThreshold}
								onChange={(e) => setCompactThreshold(e.target.value)}
							/>
							<p className="text-xs text-muted-foreground">0 = disabled</p>
						</div>
						<div className="space-y-2">
							<Label htmlFor="stop-threshold">Stop threshold (tokens)</Label>
							<Input
								id="stop-threshold"
								type="number"
								min="0"
								step="10000"
								value={stopThreshold}
								onChange={(e) => setStopThreshold(e.target.value)}
							/>
							<p className="text-xs text-muted-foreground">0 = disabled</p>
						</div>
					</div>

					{/* Freeze modes */}
					<div className="grid grid-cols-2 gap-4">
						<div className="space-y-2">
							<Label htmlFor="freeze-report">Freeze on reports</Label>
							<select
								id="freeze-report"
								value={freezeReportMode}
								onChange={(e) => setFreezeReportMode(e.target.value as typeof freezeReportMode)}
								className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
							>
								<option value="never">never — async, continues</option>
								<option value="always">always — freezes each time</option>
								<option value="custom">custom — per-report rule</option>
							</select>
						</div>
						<div className="space-y-2">
							<Label htmlFor="freeze-ask">Ask mode</Label>
							<select
								id="freeze-ask"
								value={freezeAskMode}
								onChange={(e) => setFreezeAskMode(e.target.value as typeof freezeAskMode)}
								className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
							>
								<option value="always">always — ask immediately</option>
								<option value="requiredOnly">requiredOnly — only when blocked</option>
								<option value="onReportOnly">onReportOnly — defer to reports</option>
								<option value="never">never — QUESTIONS.md only</option>
							</select>
						</div>
					</div>

					{freezeReportMode === "custom" && (
						<div className="space-y-2">
							<Label htmlFor="custom-rule">Custom freeze rule</Label>
							<Input
								id="custom-rule"
								placeholder="e.g. freeze on security or major architecture changes"
								value={freezeReportCustomRule}
								onChange={(e) => setFreezeReportCustomRule(e.target.value)}
							/>
						</div>
					)}

					{/* Always improve */}
					<div className="space-y-2">
						<Label htmlFor="always-improve">Always improve mode</Label>
						<select
							id="always-improve"
							value={alwaysImproveMode}
							onChange={(e) => setAlwaysImproveMode(e.target.value as typeof alwaysImproveMode)}
							className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
						>
							<option value="no">no — stop after task completes</option>
							<option value="yes">yes — always keep improving</option>
							<option value="custom">custom — improve within a scope</option>
						</select>
					</div>

					{alwaysImproveMode === "custom" && (
						<div className="space-y-2">
							<Label htmlFor="improve-scope">Improvement scope</Label>
							<Input
								id="improve-scope"
								placeholder="e.g. add tests and improve docs only; no new features"
								value={alwaysImproveScope}
								onChange={(e) => setAlwaysImproveScope(e.target.value)}
							/>
						</div>
					)}

					<div className="space-y-2">
						<Label htmlFor="channel">Discord channel ID (optional)</Label>
						<Input
							id="channel"
							placeholder="Uses DISCORD_DEFAULT_CHANNEL_ID if empty"
							value={channelId}
							onChange={(e) => setChannelId(e.target.value)}
						/>
					</div>

					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={loading || !task.trim()}>
							{loading ? "Starting..." : "Start Agent"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
