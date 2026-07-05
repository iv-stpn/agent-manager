import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { LlmClient } from "@/lib/agent-api";
import { getLlmClients, getProject, updateSettings } from "@/lib/agent-api";
import { ProjectContextCard } from "./ProjectContextCard";
import { type SettingField, SettingRow } from "./SettingRow";

interface SettingsTabProps {
	projectId: string;
}

type SettingsSubTab = "general" | "llm" | "context";

export function SettingsTab({ projectId }: SettingsTabProps) {
	const [settingsTab, setSettingsTab] = useState<SettingsSubTab>("general");
	const [projectName, setProjectName] = useState("");
	const [serverPort, setServerPort] = useState("");
	const [workspacePath, setWorkspacePath] = useState("");
	const [selectedClientId, setSelectedClientId] = useState("");
	const [llmClients, setLlmClients] = useState<LlmClient[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [editing, setEditing] = useState<SettingField | null>(null);
	const [draft, setDraft] = useState("");

	const load = useCallback(async () => {
		try {
			const [p, clients] = await Promise.all([getProject(projectId), getLlmClients()]);
			if (!p) return;
			setProjectName(p.name ?? "");
			setServerPort(String(p.ports?.server ?? ""));
			setWorkspacePath(p.workspace?.path ?? "");
			setSelectedClientId(p.agent?.clientId ?? "");
			setLlmClients(clients);
		} catch (err) {
			console.error("Failed to load project:", err);
		} finally {
			setLoading(false);
		}
	}, [projectId]);

	useEffect(() => {
		load();
	}, [load]);

	function openEdit(field: SettingField) {
		setEditing(field);
		setDraft(field.value);
	}

	async function save() {
		if (!editing) return;
		setSaving(true);
		try {
			await updateSettings(projectId, editing.buildPayload(draft));
			toast.success("Saved. Restart the project for changes to take effect.");
			setEditing(null);
			load();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to save settings.");
		} finally {
			setSaving(false);
		}
	}

	const general: SettingField[] = [
		{
			key: "name",
			label: "Project name",
			value: projectName,
			placeholder: "My Project",
			buildPayload: (value) => ({ name: value || undefined }),
		},
		{
			key: "server-port",
			label: "Server port",
			value: serverPort,
			placeholder: "4000",
			type: "number",
			description: "The port the agent server listens on inside Docker and on the host.",
			buildPayload: (value) => ({ ports: value ? { server: Number(value) } : undefined }),
		},
		{
			key: "workspace-path",
			label: "Workspace path",
			value: workspacePath,
			placeholder: "/path/to/workspace",
			description: "Absolute orchestrator path mounted as /workspace in the container.",
			buildPayload: (value) => ({ workspace: value ? { path: value, type: "external" } : undefined }),
		},
	];

	if (loading) {
		return <div className="text-gray-500">Loading settings...</div>;
	}

	const subTabs: Array<{ key: SettingsSubTab; label: string }> = [
		{ key: "general", label: "General" },
		{ key: "llm", label: "LLM" },
		{ key: "context", label: "Context" },
	];

	const selectedClient = llmClients.find((c) => c.id === selectedClientId);

	async function saveLlmClient(clientId: string) {
		setSaving(true);
		try {
			await updateSettings(projectId, { agent: { clientId: clientId || undefined } });
			toast.success("Saved. Restart the project for changes to take effect.");
			setSelectedClientId(clientId);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to save settings.");
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="max-w-3xl space-y-6">
			{/* Sub-tab bar */}
			<div className="flex gap-1 border-b">
				{subTabs.map(({ key, label }) => (
					<button
						key={key}
						type="button"
						onClick={() => setSettingsTab(key)}
						className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
							settingsTab === key ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-800"
						}`}
					>
						{label}
					</button>
				))}
			</div>

			<p className="text-sm text-gray-500">
				Settings are stored in the project&apos;s .env and docker-compose.yml. Restart the project after changing.
			</p>

			{settingsTab === "general" && (
				<Card>
					<CardHeader>
						<CardTitle>General</CardTitle>
					</CardHeader>
					<CardContent className="divide-y">
						{general.map((field) => (
							<SettingRow key={field.key} field={field} onEdit={() => openEdit(field)} />
						))}
					</CardContent>
				</Card>
			)}

			{settingsTab === "llm" && (
				<Card>
					<CardHeader>
						<CardTitle>LLM</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						<p className="text-sm text-muted-foreground">
							Select an LLM client configured in your library. The client's API key, base URL, and model will be used by this
							project.
						</p>
						<div className="space-y-2">
							<label htmlFor="llm-client-select" className="text-sm font-medium">
								LLM Client
							</label>
							{llmClients.length === 0 ? (
								<div className="text-sm text-muted-foreground">
									No LLM clients configured yet.{" "}
									<Link to="/llm-clients" className="text-blue-600 hover:underline">
										Create one
									</Link>
								</div>
							) : (
								<div className="flex gap-2">
									<select
										id="llm-client-select"
										value={selectedClientId}
										onChange={(event) => saveLlmClient(event.target.value)}
										disabled={saving}
										className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
									>
										<option value="">-- Select a client --</option>
										{llmClients.map((client) => (
											<option key={client.id} value={client.id}>
												{client.name} ({client.provider})
											</option>
										))}
									</select>
									{selectedClientId && (
										<Link
											to={`/llm-clients?edit=${selectedClientId}`}
											className="inline-flex items-center gap-2 px-4 py-2 bg-gray-50 text-gray-600 rounded-lg hover:bg-gray-100 text-sm"
										>
											Edit Client
										</Link>
									)}
								</div>
							)}
							{selectedClient && (
								<div className="mt-3 p-3 bg-gray-50 rounded-lg text-xs space-y-1 text-gray-600">
									<div>
										<strong>Provider:</strong> {selectedClient.provider}
									</div>
									{selectedClient.model && (
										<div>
											<strong>Model:</strong> {selectedClient.model}
										</div>
									)}
									{selectedClient.baseUrl && (
										<div>
											<strong>Base URL:</strong> {selectedClient.baseUrl}
										</div>
									)}
								</div>
							)}
						</div>
					</CardContent>
				</Card>
			)}

			{settingsTab === "context" && <ProjectContextCard projectId={projectId} />}

			<Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Edit {editing?.label}</DialogTitle>
						{editing?.description && <DialogDescription>{editing.description}</DialogDescription>}
					</DialogHeader>
					<Input
						type={editing?.type}
						placeholder={editing?.placeholder}
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						autoFocus
						onKeyDown={(event) => {
							if (event.key === "Enter") save();
						}}
					/>
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => setEditing(null)} disabled={saving}>
							Cancel
						</Button>
						<Button type="button" onClick={save} disabled={saving}>
							{saving ? "Saving..." : "Save"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
