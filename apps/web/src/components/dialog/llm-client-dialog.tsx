import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { LlmClient, LlmProvider } from "@/lib/agent-api";
import { createLlmClient, updateLlmClient } from "@/lib/agent-api";

type Form = { name: string; provider: LlmProvider; apiKey: string; baseUrl: string; model: string; smallModel: string };

function formFrom(client: LlmClient | null): Form {
	if (!client) return { name: "", provider: "anthropic", apiKey: "", baseUrl: "", model: "", smallModel: "" };
	return {
		name: client.name,
		provider: client.provider,
		apiKey: "", // don't prefill masked key
		baseUrl: client.baseUrl,
		model: client.model,
		smallModel: client.smallModel,
	};
}

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** When set, the dialog edits this client; otherwise it creates a new one. */
	editing?: LlmClient | null;
	/** Called with the persisted client after a successful save. */
	onSaved: (client: LlmClient) => void;
};

/** Self-contained create/edit modal for an LLM client. Owns its form state and persistence. */
export function LlmClientDialog({ open, onOpenChange, editing = null, onSaved }: Props) {
	const [form, setForm] = useState<Form>(() => formFrom(editing));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Reset form whenever the target client changes (e.g. switching from create to edit).
	useEffect(() => {
		setForm(formFrom(editing ?? null));
		setError(null);
	}, [editing]);

	async function save() {
		if (!form.name.trim() || saving) return;
		setSaving(true);
		setError(null);
		try {
			let result: LlmClient;
			if (editing) {
				const payload: Record<string, unknown> = { ...form };
				if (!payload.apiKey) delete payload.apiKey; // keep existing key when blank
				result = await updateLlmClient(editing.id, payload as Partial<LlmClient>);
			} else {
				result = await createLlmClient(form);
			}
			onSaved(result);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save client");
		} finally {
			setSaving(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{editing ? "Edit Client" : "New Client"}</DialogTitle>
				</DialogHeader>

				<div className="space-y-4">
					{error && <p className="text-sm text-destructive">{error}</p>}

					<div className="space-y-1.5">
						<Label htmlFor="client-name">Name *</Label>
						<Input
							id="client-name"
							autoFocus
							value={form.name}
							onChange={(event) => setForm((form) => ({ ...form, name: event.target.value }))}
							placeholder="e.g. Production Anthropic"
						/>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="client-provider">Provider *</Label>
						<select
							id="client-provider"
							value={form.provider}
							onChange={(event) => setForm((form) => ({ ...form, provider: event.target.value as LlmProvider }))}
							className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
						>
							<option value="anthropic">Anthropic</option>
							<option value="openai">OpenAI</option>
							<option value="custom">Custom (OpenAI-compatible)</option>
						</select>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="client-key">
							API Key {editing && <span className="text-muted-foreground font-normal">(leave blank to keep current)</span>}
						</Label>
						<Input
							id="client-key"
							type="password"
							value={form.apiKey}
							onChange={(event) => setForm((form) => ({ ...form, apiKey: event.target.value }))}
							placeholder={editing ? "••••••••" : "sk-..."}
						/>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="client-url">Base URL</Label>
						<Input
							id="client-url"
							value={form.baseUrl}
							onChange={(event) => setForm((form) => ({ ...form, baseUrl: event.target.value }))}
							placeholder={form.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1"}
						/>
					</div>

					<div className="grid grid-cols-2 gap-4">
						<div className="space-y-1.5">
							<Label htmlFor="client-model">Model</Label>
							<Input
								id="client-model"
								value={form.model}
								onChange={(event) => setForm((form) => ({ ...form, model: event.target.value }))}
								placeholder="claude-sonnet-4-6"
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="client-small-model">Small Model</Label>
							<Input
								id="client-small-model"
								value={form.smallModel}
								onChange={(event) => setForm((form) => ({ ...form, smallModel: event.target.value }))}
								placeholder="claude-haiku-4-5-20251001"
							/>
						</div>
					</div>
				</div>

				<DialogFooter>
					<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button type="button" onClick={save} disabled={!form.name.trim() || saving}>
						{saving ? "Saving..." : editing ? "Save changes" : "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
