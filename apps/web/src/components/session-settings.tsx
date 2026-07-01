import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Session } from "@/lib/agent-api";
import { updateSessionSettings } from "@/lib/agent-api";
import { mutateCache } from "@/lib/query-cache";
import { cacheKeys } from "@/lib/stores";

const selectClass =
	"w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring bg-background";

interface Props {
	projectId: string;
	sessionId: string;
	session: Session;
}

type FormState = {
	reportIntervalMins: number;
	stopThresholdMins: number;
	awaitReportMode: Session["awaitReportMode"];
	awaitReportCustomRule: string;
	awaitAskMode: Session["awaitAskMode"];
	compactThresholdTokens: number;
	stopThresholdTokens: number;
	alwaysImproveMode: Session["alwaysImproveMode"];
	alwaysImproveScope: string;
};

function fromSession(s: Session): FormState {
	return {
		reportIntervalMins: s.reportIntervalMins,
		stopThresholdMins: s.stopThresholdMins,
		awaitReportMode: s.awaitReportMode,
		awaitReportCustomRule: s.awaitReportCustomRule ?? "",
		awaitAskMode: s.awaitAskMode,
		compactThresholdTokens: s.compactThresholdTokens,
		stopThresholdTokens: s.stopThresholdTokens,
		alwaysImproveMode: s.alwaysImproveMode,
		alwaysImproveScope: s.alwaysImproveScope ?? "",
	};
}

export function SessionSettings({ projectId, sessionId, session }: Props) {
	const [form, setForm] = useState<FormState>(() => fromSession(session));
	const [saving, setSaving] = useState(false);

	const update = <K extends keyof FormState>(field: K, value: FormState[K]) => setForm((form) => ({ ...form, [field]: value }));

	// Disable Save until something actually changed. Compares against the
	// session record the form was seeded from.
	const isDirty = JSON.stringify(fromSession(session)) !== JSON.stringify(form);

	async function handleSave() {
		setSaving(true);
		try {
			const updated = await updateSessionSettings(projectId, sessionId, {
				reportIntervalMins: Number(form.reportIntervalMins),
				stopThresholdMins: Number(form.stopThresholdMins),
				awaitReportMode: form.awaitReportMode,
				// Only send the rule/scope when their mode is active; clear otherwise.
				awaitReportCustomRule: form.awaitReportMode === "custom" ? form.awaitReportCustomRule.trim() || null : null,
				awaitAskMode: form.awaitAskMode,
				compactThresholdTokens: Number(form.compactThresholdTokens),
				stopThresholdTokens: Number(form.stopThresholdTokens),
				alwaysImproveMode: form.alwaysImproveMode,
				alwaysImproveScope: form.alwaysImproveMode === "custom" ? form.alwaysImproveScope.trim() || null : null,
			});
			mutateCache<Session>(cacheKeys.session(projectId, sessionId), () => updated);
			toast.success("Settings saved");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to save settings");
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="space-y-3 p-3">
			<Card>
				<CardHeader className="pb-3 pt-4">
					<CardTitle className="text-sm">Reports &amp; timeout</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<div className="space-y-1.5">
						<Label htmlFor="set-report">Report interval (minutes)</Label>
						<Input
							id="set-report"
							type="number"
							min={0}
							value={form.reportIntervalMins}
							onChange={(event) => update("reportIntervalMins", Number(event.target.value))}
						/>
						<p className="text-xs text-muted-foreground">
							How often the agent posts a progress check-in. 0 disables timed reports.
						</p>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="set-timeout">Total timeout (minutes)</Label>
						<Input
							id="set-timeout"
							type="number"
							min={0}
							value={form.stopThresholdMins}
							onChange={(event) => update("stopThresholdMins", Number(event.target.value))}
						/>
						<p className="text-xs text-muted-foreground">Hard wall-clock cap after which the session is stopped.</p>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader className="pb-3 pt-4">
					<CardTitle className="text-sm">Await behavior</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<div className="space-y-1.5">
						<Label htmlFor="set-await-report">Await report mode</Label>
						<select
							id="set-await-report"
							className={selectClass}
							value={form.awaitReportMode}
							onChange={(event) => update("awaitReportMode", event.target.value as FormState["awaitReportMode"])}
						>
							<option value="never">Never</option>
							<option value="always">Always</option>
							<option value="custom">Custom</option>
						</select>
						{form.awaitReportMode === "custom" && (
							<Input
								placeholder="Natural-language rule, e.g. 'only before risky changes'"
								value={form.awaitReportCustomRule}
								onChange={(event) => update("awaitReportCustomRule", event.target.value)}
							/>
						)}
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="set-await-ask">Await ask mode</Label>
						<select
							id="set-await-ask"
							className={selectClass}
							value={form.awaitAskMode}
							onChange={(event) => update("awaitAskMode", event.target.value as FormState["awaitAskMode"])}
						>
							<option value="always">Always</option>
							<option value="requiredOnly">Required only</option>
							<option value="onReportOnly">On report only</option>
							<option value="never">Never</option>
						</select>
						<p className="text-xs text-muted-foreground">When the agent is allowed to block on a question.</p>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader className="pb-3 pt-4">
					<CardTitle className="text-sm">Token thresholds</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<div className="space-y-1.5">
						<Label htmlFor="set-compact">Compact at (tokens)</Label>
						<Input
							id="set-compact"
							type="number"
							min={0}
							value={form.compactThresholdTokens}
							onChange={(event) => update("compactThresholdTokens", Number(event.target.value))}
						/>
						<p className="text-xs text-muted-foreground">
							Context size that triggers an automatic compaction. 0 disables compaction.
						</p>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="set-stop-tok">Stop at (tokens)</Label>
						<Input
							id="set-stop-tok"
							type="number"
							min={0}
							value={form.stopThresholdTokens}
							onChange={(event) => update("stopThresholdTokens", Number(event.target.value))}
						/>
						<p className="text-xs text-muted-foreground">Context size that force-stops the session. 0 disables the token stop.</p>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader className="pb-3 pt-4">
					<CardTitle className="text-sm">Always improve</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<div className="space-y-1.5">
						<Label htmlFor="set-improve">Always improve mode</Label>
						<select
							id="set-improve"
							className={selectClass}
							value={form.alwaysImproveMode}
							onChange={(event) => update("alwaysImproveMode", event.target.value as FormState["alwaysImproveMode"])}
						>
							<option value="no">No</option>
							<option value="yes">Yes</option>
							<option value="custom">Custom</option>
						</select>
						<p className="text-xs text-muted-foreground">Whether the agent keeps improving after the task is considered done.</p>
						{form.alwaysImproveMode === "custom" && (
							<Input
								placeholder="Scope, e.g. 'test coverage and error handling'"
								value={form.alwaysImproveScope}
								onChange={(event) => update("alwaysImproveScope", event.target.value)}
							/>
						)}
					</div>
				</CardContent>
			</Card>

			<div className="flex justify-end gap-2 pt-1">
				<Button type="button" variant="outline" onClick={() => setForm(fromSession(session))} disabled={saving || !isDirty}>
					Reset
				</Button>
				<Button type="button" onClick={handleSave} disabled={saving || !isDirty}>
					{saving && <Loader2 className="h-3 w-3 animate-spin" />}
					{saving ? "Saving..." : "Save settings"}
				</Button>
			</div>
		</div>
	);
}
