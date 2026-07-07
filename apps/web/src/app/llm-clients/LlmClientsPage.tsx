import { replaceOrPrependById } from "@agent-manager/utils";
import { Edit2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { LlmClientDialog } from "@/components/dialog/llm-client-dialog";
import type { LlmClient, LlmProvider } from "@/lib/agent-api";
import { deleteLlmClient, getLlmClients } from "@/lib/agent-api";
import { mutateCache, useQuery } from "@/lib/query-cache";
import { byNewestFirst } from "@/lib/utils";

const PROVIDER_LABELS: Record<LlmProvider, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	custom: "Custom (OpenAI-compatible)",
};

export default function LlmClientsPage() {
	const [editing, setEditing] = useState<LlmClient | null>(null);
	const [creating, setCreating] = useState(false);

	const { data: clients = [], loading } = useQuery<LlmClient[]>("llm-clients", getLlmClients);

	function closeDialog() {
		setCreating(false);
		setEditing(null);
	}

	function onSaved(client: LlmClient) {
		mutateCache<LlmClient[]>("llm-clients", (list) => replaceOrPrependById(list, client));
		closeDialog();
	}

	async function remove(id: string) {
		if (!confirm("Delete this LLM client?")) return;
		try {
			await deleteLlmClient(id);
			mutateCache<LlmClient[]>("llm-clients", (list) => list.filter((client) => client.id !== id));
		} catch (err) {
			console.error("Failed to delete LLM client:", err);
		}
	}

	const dialogOpen = creating || editing !== null;

	return (
		<div className="min-h-screen bg-gray-50">
			<header className="bg-white border-b px-6 py-4 flex items-center justify-between">
				<div>
					<h1 className="text-xl font-bold text-gray-900">LLM Clients</h1>
					<p className="text-sm text-gray-500 mt-0.5">Manage your LLM provider connections</p>
				</div>
				<button
					type="button"
					onClick={() => setCreating(true)}
					className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
				>
					<Plus className="w-4 h-4" />
					New Client
				</button>
			</header>

			<main className="max-w-5xl mx-auto px-6 py-8">
				{loading && clients.length === 0 ? (
					<div className="text-gray-500 text-center py-16">Loading clients...</div>
				) : clients.length === 0 ? (
					<div className="text-center py-16 space-y-3">
						<p className="text-gray-400">No LLM clients configured yet</p>
						<button type="button" onClick={() => setCreating(true)} className="text-blue-600 hover:text-blue-700 text-sm">
							Create your first client
						</button>
					</div>
				) : (
					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						{[...clients].sort(byNewestFirst).map((client) => (
							<div
								key={client.id}
								className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-3 hover:border-gray-300 transition-colors"
							>
								<div className="flex items-start justify-between gap-3">
									<div className="min-w-0">
										<div className="flex items-center gap-2 mb-1">
											<span className="text-xs font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
												{PROVIDER_LABELS[client.provider]}
											</span>
										</div>
										<h3 className="font-semibold text-gray-900 truncate">{client.name}</h3>
										{client.model && <p className="text-sm text-gray-500 mt-0.5 font-mono">{client.model}</p>}
									</div>
									<div className="flex gap-1 shrink-0">
										<button
											type="button"
											onClick={() => setEditing(client)}
											className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
											title="Edit"
											aria-label="Edit client"
										>
											<Edit2 className="w-3.5 h-3.5" />
										</button>
										<button
											type="button"
											onClick={() => remove(client.id)}
											className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
											title="Delete"
											aria-label="Delete client"
										>
											<Trash2 className="w-3.5 h-3.5" />
										</button>
									</div>
								</div>
								<div className="text-xs text-gray-400 space-y-0.5">
									{client.apiKey && <p>API Key: {client.apiKey}</p>}
									{client.baseUrl && <p>Base URL: {client.baseUrl}</p>}
									{client.smallModel && <p>Small model: {client.smallModel}</p>}
								</div>
							</div>
						))}
					</div>
				)}
			</main>

			<LlmClientDialog
				open={dialogOpen}
				onOpenChange={(open) => {
					if (!open) closeDialog();
				}}
				editing={editing}
				onSaved={onSaved}
			/>
		</div>
	);
}
