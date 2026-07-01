import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createSession } from "@/lib/agent-api";

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
}

export function NewSessionDialog({ open, onOpenChange, projectId }: Props) {
	const navigate = useNavigate();
	const [task, setTask] = useState("");
	const [reportIntervalMins, setReportIntervalMins] = useState("15");
	const [stopThresholdMins, setstopThresholdMins] = useState("240");
	const [awaitReportMode, setAwaitReportMode] = useState<"always" | "never" | "custom">("never");
	const [awaitReportCustomRule, setAwaitReportCustomRule] = useState("");
	const [awaitAskMode, setAwaitAskMode] = useState<"always" | "requiredOnly" | "onReportOnly" | "never">("always");
	const [compactThreshold, setCompactThreshold] = useState("80000");
	const [stopThreshold, setStopThreshold] = useState("10000000");
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
				stopThresholdMins: Number(stopThresholdMins) || 240,
				awaitReportMode,
				awaitReportCustomRule: awaitReportCustomRule || undefined,
				awaitAskMode,
				compactThresholdTokens: Number(compactThreshold) || 80_000,
				stopThresholdTokens: Number(stopThreshold) || 2_000_000,
				alwaysImproveMode,
				alwaysImproveScope: alwaysImproveScope || undefined,
			});
			onOpenChange(false);
			setTask("");
			navigate(`/projects/${projectId}/sessions/${session.id}`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to start session");
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
							onChange={(event) => setTask(event.target.value)}
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
								onChange={(event) => setReportIntervalMins(event.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="total-timeout">Total timeout (mins)</Label>
							<Input
								id="total-timeout"
								type="number"
								min="1"
								max="1440"
								value={stopThresholdMins}
								onChange={(event) => setstopThresholdMins(event.target.value)}
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
								onChange={(event) => setCompactThreshold(event.target.value)}
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
								onChange={(event) => setStopThreshold(event.target.value)}
							/>
							<p className="text-xs text-muted-foreground">0 = disabled</p>
						</div>
					</div>

					{/* Await modes */}
					<div className="grid grid-cols-2 gap-4">
						<div className="space-y-2">
							<Label htmlFor="await-report">Await on reports</Label>
							<select
								id="await-report"
								value={awaitReportMode}
								onChange={(event) => setAwaitReportMode(event.target.value as typeof awaitReportMode)}
								className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
							>
								<option value="never">never — async, continues</option>
								<option value="always">always — awaits each time</option>
								<option value="custom">custom — per-report rule</option>
							</select>
						</div>
						<div className="space-y-2">
							<Label htmlFor="await-ask">Ask mode</Label>
							<select
								id="await-ask"
								value={awaitAskMode}
								onChange={(event) => setAwaitAskMode(event.target.value as typeof awaitAskMode)}
								className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
							>
								<option value="always">always — ask immediately</option>
								<option value="requiredOnly">requiredOnly — only when blocked</option>
								<option value="onReportOnly">onReportOnly — defer to reports</option>
								<option value="never">never — append all questions for later, and proceed on other tasks</option>
							</select>
						</div>
					</div>

					{awaitReportMode === "custom" && (
						<div className="space-y-2">
							<Label htmlFor="custom-rule">Custom await rule</Label>
							<Input
								id="custom-rule"
								placeholder="e.g. await on security or major architecture changes"
								value={awaitReportCustomRule}
								onChange={(event) => setAwaitReportCustomRule(event.target.value)}
							/>
						</div>
					)}

					{/* Always improve */}
					<div className="space-y-2">
						<Label htmlFor="always-improve">Always improve mode</Label>
						<select
							id="always-improve"
							value={alwaysImproveMode}
							onChange={(event) => setAlwaysImproveMode(event.target.value as typeof alwaysImproveMode)}
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
								onChange={(event) => setAlwaysImproveScope(event.target.value)}
							/>
						</div>
					)}

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
