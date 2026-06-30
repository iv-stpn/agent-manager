import { useEffect, useState } from "react";
import { toast } from "sonner";
import { LlmClientDialog } from "@/components/dialog/llm-client-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Guideline, GuidelineCategory, LlmClient, TechStack } from "@/lib/agent-api";
import {
	createProject as apiCreateProject,
	checkWorkspacePath,
	getGuidelineCategories,
	getGuidelines,
	getLlmClients,
	getTechStacks,
	updateProjectContext,
} from "@/lib/agent-api";
import { mutateCache } from "@/lib/query-cache";
import type { EnrichedProject } from "@/lib/types";
import { cn } from "@/lib/utils";

interface NewProjectFormValues {
	name: string;
	description: string;
	workspacePath: string;
	clientId: string;
}

const emptyForm: NewProjectFormValues = {
	name: "",
	description: "",
	workspacePath: "",
	clientId: "",
};

type PathWarning = { status: "not_found" | "not_empty" | "not_directory"; path: string } | null;
type Step = "basic" | "context";

interface NewProjectFormProps {
	onSuccess?: () => void;
	onCancel?: () => void;
}

export function NewProjectForm({ onSuccess, onCancel }: NewProjectFormProps) {
	const [step, setStep] = useState<Step>("basic");
	const [form, setForm] = useState<NewProjectFormValues>(emptyForm);
	const [pathWarning, setPathWarning] = useState<PathWarning>(null);
	const [loading, setLoading] = useState(false);
	const [llmClients, setLlmClients] = useState<LlmClient[]>([]);
	const [addingClient, setAddingClient] = useState(false);

	// Load LLM clients on mount
	useEffect(() => {
		getLlmClients()
			.then(setLlmClients)
			.catch((err) => console.error("Failed to load LLM clients:", err));
	}, []);

	function onClientSaved(client: LlmClient) {
		setLlmClients((prev) => [client, ...prev]);
		setForm((f) => ({ ...f, clientId: client.id }));
		setAddingClient(false);
	}

	// Context selections
	const [techStacks, setTechStacks] = useState<TechStack[]>([]);
	const [guidelines, setGuidelines] = useState<Guideline[]>([]);
	const [categories, setCategories] = useState<GuidelineCategory[]>([]);
	const [selectedTechStacks, setSelectedTechStacks] = useState<string[]>([]);
	const [selectedGuidelines, setSelectedGuidelines] = useState<string[]>([]);
	const [contextLoading, setContextLoading] = useState(false);

	const update = (field: keyof NewProjectFormValues, value: string) => setForm((f) => ({ ...f, [field]: value }));

	// Load tech stacks + guidelines when switching to context step
	useEffect(() => {
		if (step !== "context") return;
		if (techStacks.length > 0 || guidelines.length > 0) return; // already loaded
		setContextLoading(true);
		Promise.all([getTechStacks(), getGuidelines(), getGuidelineCategories()])
			.then(([stacks, guides, cats]) => {
				setTechStacks(stacks);
				setGuidelines(guides);
				setCategories(cats);
			})
			.catch((err) => console.error("Failed to load context library:", err))
			.finally(() => setContextLoading(false));
	}, [step, techStacks.length, guidelines.length]);

	function toggleStack(id: string) {
		setSelectedTechStacks((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
	}

	function toggleGuideline(id: string) {
		setSelectedGuidelines((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
	}

	async function handleSubmit(skipPathCheck = false) {
		if (!form.name.trim() || !form.clientId) return;

		if (form.workspacePath && !skipPathCheck) {
			try {
				const result = await checkWorkspacePath(form.workspacePath);
				if (result.status !== "empty") {
					setPathWarning({ status: result.status, path: result.path });
					return;
				}
			} catch {
				// If check fails, proceed anyway
			}
		}

		setLoading(true);
		try {
			const created = await apiCreateProject({
				name: form.name.trim(),
				description: form.description || undefined,
				workspacePath: form.workspacePath || undefined,
				agent: {
					clientId: form.clientId,
				},
			});

			// Set context if any selections were made
			if (selectedTechStacks.length > 0 || selectedGuidelines.length > 0) {
				try {
					await updateProjectContext(created.id, {
						techStackIds: selectedTechStacks,
						guidelineIds: selectedGuidelines,
						instructions: "",
					});
				} catch (err) {
					console.error("Failed to save context, project was still created:", err);
				}
			}

			// Add project to the cache immediately so it shows on the list
			const enriched: EnrichedProject = {
				...created,
				dockerStatus: { running: false, containers: [] },
				stats: { sessions: 0, messages: 0, reports: 0, lastActivity: null },
				logLines: null,
			};
			mutateCache<EnrichedProject[]>("projects", (list) => [...list, enriched]);

			setForm(emptyForm);
			setPathWarning(null);
			setSelectedTechStacks([]);
			setSelectedGuidelines([]);
			setStep("basic");
			toast.success("Project created");
			onSuccess?.();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to create project");
		} finally {
			setLoading(false);
		}
	}

	if (pathWarning) {
		return (
			<div className="space-y-4">
				{pathWarning.status === "not_found" && (
					<>
						<p className="text-sm text-muted-foreground">
							The folder <code className="bg-muted px-1 rounded">{pathWarning.path}</code> does not exist. Create it?
						</p>
						<div className="flex gap-2">
							<Button
								className="flex-1"
								onClick={() => {
									setPathWarning(null);
									handleSubmit(true);
								}}
							>
								Create folder
							</Button>
							<Button className="flex-1" variant="secondary" onClick={() => setPathWarning(null)}>
								Go back
							</Button>
						</div>
					</>
				)}
				{pathWarning.status === "not_empty" && (
					<>
						<p className="text-sm text-muted-foreground">
							The folder <code className="bg-muted px-1 rounded">{pathWarning.path}</code> is not empty. Use it anyway?
						</p>
						<div className="flex gap-2">
							<Button
								className="flex-1"
								onClick={() => {
									setPathWarning(null);
									handleSubmit(true);
								}}
							>
								Continue
							</Button>
							<Button className="flex-1" variant="secondary" onClick={() => setPathWarning(null)}>
								Go back
							</Button>
						</div>
					</>
				)}
				{pathWarning.status === "not_directory" && (
					<>
						<p className="text-sm text-muted-foreground">
							The path <code className="bg-muted px-1 rounded">{pathWarning.path}</code> is not a directory. Please choose a
							different path.
						</p>
						<Button variant="secondary" onClick={() => setPathWarning(null)}>
							Go back
						</Button>
					</>
				)}
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{/* Step tabs */}
			<div className="flex gap-1 border-b -mx-1 px-1">
				<button
					type="button"
					onClick={() => setStep("basic")}
					className={cn(
						"px-3 py-2 text-sm font-medium border-b-2 -mb-px transition",
						step === "basic" ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"
					)}
				>
					Basic
				</button>
				<button
					type="button"
					onClick={() => setStep("context")}
					className={cn(
						"px-3 py-2 text-sm font-medium border-b-2 -mb-px transition",
						step === "context" ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"
					)}
				>
					Context
					{(selectedTechStacks.length > 0 || selectedGuidelines.length > 0) && (
						<span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 text-[10px] font-semibold rounded-full bg-blue-100 text-blue-700">
							{selectedTechStacks.length + selectedGuidelines.length}
						</span>
					)}
				</button>
			</div>

			{step === "basic" && (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						handleSubmit();
					}}
					className="space-y-4"
				>
					<div className="space-y-2">
						<Label htmlFor="np-name">Project Name</Label>
						<Input
							id="np-name"
							autoFocus
							value={form.name}
							onChange={(e) => update("name", e.target.value)}
							placeholder="My Project"
							required
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="np-desc">Description</Label>
						<Input
							id="np-desc"
							value={form.description}
							onChange={(e) => update("description", e.target.value)}
							placeholder="Optional description"
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="np-path">Workspace Path</Label>
						<Input
							id="np-path"
							value={form.workspacePath}
							onChange={(e) => update("workspacePath", e.target.value)}
							placeholder="/path/to/repo (leave empty for internal)"
						/>
					</div>

					<div className="border-t pt-4 space-y-3">
						<div className="flex items-center justify-between">
							<Label htmlFor="np-client">LLM Client</Label>
							<button
								type="button"
								onClick={() => setAddingClient(true)}
								className="text-xs text-blue-600 hover:text-blue-700 font-medium"
							>
								+ Add new client
							</button>
						</div>
						<select
							id="np-client"
							value={form.clientId}
							onChange={(e) => update("clientId", e.target.value)}
							className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
						>
							<option value="" disabled>
								Select a client...
							</option>
							{llmClients.map((client) => (
								<option key={client.id} value={client.id}>
									{client.name} ({client.provider})
								</option>
							))}
						</select>
						{llmClients.length === 0 && <p className="text-xs text-gray-400">No clients yet. Add one to create a project.</p>}
					</div>

					<DialogFooter>
						{onCancel && (
							<Button type="button" variant="outline" onClick={onCancel}>
								Cancel
							</Button>
						)}
						<Button type="button" variant="outline" onClick={() => setStep("context")}>
							Next
						</Button>
					</DialogFooter>
				</form>
			)}

			{step === "context" && (
				<div className="space-y-5">
					{contextLoading ? (
						<p className="text-sm text-gray-500">Loading library...</p>
					) : (
						<>
							{/* Tech stacks */}
							<div className="space-y-2">
								<p className="text-sm font-medium">Tech Stacks</p>
								{techStacks.length === 0 ? (
									<p className="text-xs italic text-gray-400">No tech stacks in the library yet.</p>
								) : (
									<ul className="divide-y rounded-md border max-h-48 overflow-y-auto">
										{techStacks.map((s) => {
											const selected = selectedTechStacks.includes(s.id);
											return (
												<li key={s.id}>
													<label
														htmlFor={`stack-${s.id}`}
														className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-gray-50 transition-colors cursor-pointer"
													>
														<Checkbox id={`stack-${s.id}`} checked={selected} onCheckedChange={() => toggleStack(s.id)} />
														<span className="min-w-0">
															<span className="block text-sm font-medium">{s.name}</span>
															<span className="block text-xs text-gray-500">
																{s.language}
																{s.description ? ` · ${s.description}` : ""}
															</span>
														</span>
													</label>
												</li>
											);
										})}
									</ul>
								)}
							</div>

							{/* Guidelines by category */}
							<div className="space-y-2">
								<p className="text-sm font-medium">Guidelines</p>
								{guidelines.length === 0 ? (
									<p className="text-xs italic text-gray-400">No guidelines in the library yet.</p>
								) : (
									<GuidelinePickerList
										guidelines={guidelines}
										categories={categories}
										selectedIds={selectedGuidelines}
										onToggle={toggleGuideline}
									/>
								)}
							</div>
						</>
					)}

					<DialogFooter>
						{onCancel && (
							<Button type="button" variant="outline" onClick={onCancel}>
								Cancel
							</Button>
						)}
						<Button type="button" variant="outline" onClick={() => setStep("basic")}>
							← Back
						</Button>
						<Button type="button" disabled={loading || !form.name.trim() || !form.clientId} onClick={() => handleSubmit()}>
							{loading ? "Creating..." : "Create"}
						</Button>
					</DialogFooter>
				</div>
			)}

			<LlmClientDialog
				open={addingClient}
				onOpenChange={(open) => {
					if (!open) setAddingClient(false);
				}}
				onSaved={onClientSaved}
			/>
		</div>
	);
}

/** Grouped guideline picker used in the new-project form. */
function GuidelinePickerList({
	guidelines,
	categories,
	selectedIds,
	onToggle,
}: {
	guidelines: Guideline[];
	categories: GuidelineCategory[];
	selectedIds: string[];
	onToggle: (id: string) => void;
}) {
	// Group by category
	const grouped = new Map<string | null, Guideline[]>();
	for (const g of guidelines) {
		const key = g.categoryId ?? null;
		const arr = grouped.get(key) ?? [];
		arr.push(g);
		grouped.set(key, arr);
	}

	const orderedKeys: Array<string | null> = [
		...categories.map((c) => c.id).filter((id) => grouped.has(id)),
		...(grouped.has(null) ? [null] : []),
	];

	return (
		<div className="space-y-3 max-h-64 overflow-y-auto pr-1">
			{orderedKeys.map((catId) => {
				const cat = catId ? categories.find((c) => c.id === catId) : null;
				const items = grouped.get(catId) ?? [];
				return (
					<div key={catId ?? "__uncategorized"}>
						<div className="flex items-center gap-1.5 mb-1">
							{cat ? (
								<>
									<span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: cat.color }} />
									<span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{cat.name}</span>
								</>
							) : (
								<span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Uncategorized</span>
							)}
						</div>
						<ul className="divide-y rounded-md border">
							{items.map((g) => {
								const selected = selectedIds.includes(g.id);
								return (
									<li key={g.id}>
										<label
											htmlFor={`guideline-${g.id}`}
											className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-gray-50 transition-colors cursor-pointer"
										>
											<Checkbox id={`guideline-${g.id}`} checked={selected} onCheckedChange={() => onToggle(g.id)} />
											<span className="min-w-0">
												<span className="block text-sm">{g.name}</span>
												{g.description && <span className="block truncate text-xs text-gray-500">{g.description}</span>}
											</span>
										</label>
									</li>
								);
							})}
						</ul>
					</div>
				);
			})}
		</div>
	);
}

interface NewProjectDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function NewProjectDialog({ open, onOpenChange }: NewProjectDialogProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[85vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>New Project</DialogTitle>
				</DialogHeader>
				<NewProjectForm onSuccess={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} />
			</DialogContent>
		</Dialog>
	);
}
