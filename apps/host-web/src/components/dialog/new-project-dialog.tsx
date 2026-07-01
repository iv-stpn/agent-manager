import { useEffect, useState } from "react";
import { toast } from "sonner";
import { LlmClientDialog } from "@/components/dialog/llm-client-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Guideline, GuidelineCategory, LlmClient, LocalTemplate, TechStack } from "@/lib/agent-api";
import {
	createProject as apiCreateProject,
	checkWorkspacePath,
	getGuidelineCategories,
	getGuidelines,
	getLlmClients,
	getTechStacks,
	getTemplates,
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
	binaries: Array<"python3" | "workerd" | "cargo">;
}

const emptyForm: NewProjectFormValues = {
	name: "",
	description: "",
	workspacePath: "",
	clientId: "",
	binaries: [],
};

type PathWarning = { status: "not_found" | "not_empty" | "not_directory" | "protected"; path: string } | null;
type Step = "basic" | "templates" | "context";

interface TemplateSelection {
	type: "local" | "github";
	source: string;
	subdirectory?: string;
}

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

	// Templates selections
	const [templates, setTemplates] = useState<LocalTemplate[]>([]);
	const [selectedTemplates, setSelectedTemplates] = useState<string[]>([]);
	const [customGithubUrl, setCustomGithubUrl] = useState("");
	const [useMultipleTemplates, setUseMultipleTemplates] = useState(false);
	const [templateSubdirs, setTemplateSubdirs] = useState<Record<string, string>>({});
	const [templatesLoading, setTemplatesLoading] = useState(false);

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

	// Load templates when switching to templates step
	useEffect(() => {
		if (step !== "templates") return;
		if (templates.length > 0) return; // already loaded
		setTemplatesLoading(true);
		getTemplates()
			.then((tpls) => setTemplates(tpls))
			.catch((err) => console.error("Failed to load templates:", err))
			.finally(() => setTemplatesLoading(false));
	}, [step, templates.length]);

	function toggleStack(id: string) {
		setSelectedTechStacks((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
	}

	function toggleGuideline(id: string) {
		setSelectedGuidelines((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
	}

	function toggleBinary(binary: "python3" | "workerd" | "cargo") {
		setForm((f) => ({
			...f,
			binaries: f.binaries.includes(binary) ? f.binaries.filter((b) => b !== binary) : [...f.binaries, binary],
		}));
	}

	function toggleTemplate(name: string) {
		if (useMultipleTemplates) {
			// Multiple mode: toggle selection
			setSelectedTemplates((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]));
		} else {
			// Single mode: replace selection
			setSelectedTemplates([name]);
		}
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
			// Build templates array
			const templatesList: TemplateSelection[] = [];

			// Add selected local templates
			for (const name of selectedTemplates) {
				const subdir = useMultipleTemplates ? templateSubdirs[name] || name : undefined;
				templatesList.push({
					type: "local",
					source: name,
					...(subdir && { subdirectory: subdir }),
				});
			}

			// Add custom GitHub URL if provided
			if (customGithubUrl.trim()) {
				const subdir = useMultipleTemplates ? templateSubdirs.__github || "github-template" : undefined;
				templatesList.push({
					type: "github",
					source: customGithubUrl.trim(),
					...(subdir && { subdirectory: subdir }),
				});
			}

			const created = await apiCreateProject({
				name: form.name.trim(),
				description: form.description || undefined,
				workspacePath: form.workspacePath || undefined,
				agent: {
					clientId: form.clientId,
				},
				...(templatesList.length > 0 && { templates: templatesList }),
				...(form.binaries.length > 0 && { binaries: form.binaries }),
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
			setSelectedTemplates([]);
			setCustomGithubUrl("");
			setTemplateSubdirs({});
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
				{pathWarning.status === "protected" && (
					<>
						<p className="text-sm text-destructive">
							The path <code className="bg-muted px-1 rounded">{pathWarning.path}</code> is a protected system directory and
							cannot be used as a workspace. Please choose a different path.
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
				<button
					type="button"
					onClick={() => setStep("templates")}
					className={cn(
						"px-3 py-2 text-sm font-medium border-b-2 -mb-px transition",
						step === "templates" ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"
					)}
				>
					Templates
					{(selectedTemplates.length > 0 || customGithubUrl) && (
						<span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 text-[10px] font-semibold rounded-full bg-blue-100 text-blue-700">
							{selectedTemplates.length + (customGithubUrl ? 1 : 0)}
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

					<div className="border-t pt-4 space-y-3">
						<Label>Additional Binaries</Label>
						<p className="text-xs text-muted-foreground mb-2">Select binaries to install in the Docker container</p>
						<div className="space-y-2">
							<label htmlFor="binary-python3" className="flex items-center gap-2 cursor-pointer">
								<Checkbox
									id="binary-python3"
									checked={form.binaries.includes("python3")}
									onCheckedChange={() => toggleBinary("python3")}
								/>
								<span className="text-sm font-medium">python3</span>
								<span className="text-xs text-muted-foreground">Python 3 interpreter and pip</span>
							</label>
							<label htmlFor="binary-workerd" className="flex items-center gap-2 cursor-pointer">
								<Checkbox
									id="binary-workerd"
									checked={form.binaries.includes("workerd")}
									onCheckedChange={() => toggleBinary("workerd")}
								/>
								<span className="text-sm font-medium">workerd</span>
								<span className="text-xs text-muted-foreground">Cloudflare Workers runtime</span>
							</label>
							<label htmlFor="binary-cargo" className="flex items-center gap-2 cursor-pointer">
								<Checkbox
									id="binary-cargo"
									checked={form.binaries.includes("cargo")}
									onCheckedChange={() => toggleBinary("cargo")}
								/>
								<span className="text-sm font-medium">cargo</span>
								<span className="text-xs text-muted-foreground">Rust package manager and compiler</span>
							</label>
						</div>
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

			{step === "templates" && (
				<div className="space-y-4">
					<div className="flex items-center gap-2 mb-3">
						<Checkbox
							id="use-multiple"
							checked={useMultipleTemplates}
							onCheckedChange={(checked) => setUseMultipleTemplates(checked === true)}
						/>
						<Label htmlFor="use-multiple" className="text-sm font-medium cursor-pointer">
							Use multiple templates
						</Label>
					</div>

					{templatesLoading ? (
						<p className="text-sm text-gray-500">Loading templates...</p>
					) : (
						<>
							{/* Local templates */}
							<div className="space-y-2">
								<p className="text-sm font-medium">Local Templates</p>
								{templates.length === 0 ? (
									<p className="text-xs italic text-gray-400">
										No local templates. Add templates to the <code>templates/</code> directory.
									</p>
								) : (
									<div className="border rounded-lg divide-y max-h-48 overflow-y-auto">
										{templates.map((tpl) => {
											const selected = selectedTemplates.includes(tpl.name);
											return (
												// biome-ignore lint/a11y/noLabelWithoutControl: there is an input bound to the label
												<label
													key={tpl.name}
													className={cn(
														"flex items-start gap-3 px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors",
														selected && "bg-blue-50/60"
													)}
												>
													<Checkbox
														checked={selected}
														onCheckedChange={() => toggleTemplate(tpl.name)}
														disabled={!useMultipleTemplates && selectedTemplates.length > 0 && !selected}
													/>
													<div className="flex-1 min-w-0">
														<div className="text-sm font-medium">{tpl.name}</div>
														{tpl.description && <div className="text-xs text-gray-500">{tpl.description}</div>}
														{tpl.techStackNames.length > 0 && (
															<div className="flex flex-wrap gap-1 mt-1">
																{tpl.techStackNames.map((name) => (
																	<span key={name} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
																		{name}
																	</span>
																))}
															</div>
														)}
													</div>
													{useMultipleTemplates && selected && (
														<Input
															placeholder="subdirectory"
															value={templateSubdirs[tpl.name] || ""}
															onChange={(e) => {
																e.stopPropagation();
																setTemplateSubdirs((prev) => ({ ...prev, [tpl.name]: e.target.value }));
															}}
															className="w-32 h-7 text-xs"
															onClick={(e) => e.stopPropagation()}
														/>
													)}
												</label>
											);
										})}
									</div>
								)}
							</div>

							{/* GitHub URL */}
							<div className="space-y-2">
								<Label htmlFor="github-url" className="text-sm font-medium">
									GitHub Repository URL
								</Label>
								<div className="flex gap-2">
									<Input
										id="github-url"
										type="url"
										value={customGithubUrl}
										onChange={(e) => setCustomGithubUrl(e.target.value)}
										placeholder="https://github.com/user/repo.git"
										className="flex-1"
									/>
									{useMultipleTemplates && customGithubUrl && (
										<Input
											placeholder="subdirectory"
											value={templateSubdirs.__github || ""}
											onChange={(e) => setTemplateSubdirs((prev) => ({ ...prev, __github: e.target.value }))}
											className="w-32"
										/>
									)}
								</div>
								<p className="text-xs text-gray-500">Clone a public GitHub repository as a template</p>
							</div>

							{/* Tech stack suggestions */}
							{selectedTechStacks.length > 0 && techStacks.length > 0 && (
								<div className="border rounded-lg p-3 bg-blue-50/30">
									<p className="text-sm font-medium mb-2">Suggested from selected tech stacks:</p>
									<div className="space-y-1">
										{selectedTechStacks.map((stackId) => {
											const stack = techStacks.find((s) => s.id === stackId);
											if (!stack?.templateGithubUrl) return null;
											return (
												<div key={stackId} className="flex items-center gap-2 text-xs">
													<span className="font-medium">{stack.name}:</span>
													<button
														type="button"
														onClick={() => {
															if (!customGithubUrl) {
																setCustomGithubUrl(stack.templateGithubUrl || "");
															}
														}}
														className="text-blue-600 hover:text-blue-700 underline truncate"
													>
														{stack.templateGithubUrl}
													</button>
												</div>
											);
										})}
									</div>
								</div>
							)}
						</>
					)}

					<DialogFooter>
						{onCancel && (
							<Button type="button" variant="outline" onClick={onCancel}>
								Cancel
							</Button>
						)}
						<Button type="button" variant="outline" onClick={() => setStep("context")}>
							Back
						</Button>
						<Button type="button" disabled={loading || !form.name.trim() || !form.clientId} onClick={() => handleSubmit()}>
							{loading ? "Creating..." : "Create"}
						</Button>
					</DialogFooter>
				</div>
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
							Back
						</Button>
						<Button type="button" variant="outline" onClick={() => setStep("templates")}>
							Next
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

	const [activeKey, setActiveKey] = useState<string | null>(orderedKeys[0] ?? null);
	// Keep the active tab valid as the library loads/changes.
	const activeExists = orderedKeys.some((k) => k === activeKey);
	const currentKey = activeExists ? activeKey : (orderedKeys[0] ?? null);

	const items = grouped.get(currentKey) ?? [];
	const hasLanguage = items.some((g) => g.language);

	return (
		<div>
			{/* Category tabs */}
			<div className="flex flex-wrap gap-1 border-b mb-2">
				{orderedKeys.map((catId) => {
					const cat = catId ? categories.find((c) => c.id === catId) : null;
					const count = grouped.get(catId)?.length ?? 0;
					const active = catId === currentKey;
					return (
						<button
							key={catId ?? "__uncategorized"}
							type="button"
							onClick={() => setActiveKey(catId)}
							className={cn(
								"flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition",
								active ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"
							)}
						>
							{cat ? <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: cat.color }} /> : null}
							<span>{cat ? cat.name : "Uncategorized"}</span>
							<span className="text-gray-400">({count})</span>
						</button>
					);
				})}
			</div>

			<div className="max-h-64 overflow-y-auto pr-1">
				<table className="w-full text-left rounded-md border border-separate border-spacing-0 overflow-hidden">
					<tbody>
						{items.map((g) => {
							const selected = selectedIds.includes(g.id);
							return (
								<tr
									key={g.id}
									onClick={() => onToggle(g.id)}
									className={cn(
										"cursor-pointer transition-colors hover:bg-gray-50",
										selected && "bg-blue-50/60 hover:bg-blue-50"
									)}
								>
									<td className="w-8 px-3 py-2 align-top border-b">
										<Checkbox
											id={`guideline-${g.id}`}
											checked={selected}
											onCheckedChange={() => onToggle(g.id)}
											onClick={(e) => e.stopPropagation()}
										/>
									</td>
									<td className="px-3 py-2 align-top border-b text-sm font-medium">{g.name}</td>
									<td className="px-3 py-2 align-top border-b text-xs text-gray-500">{g.description || "—"}</td>
									{hasLanguage && (
										<td className="w-24 px-3 py-2 align-top border-b text-xs text-gray-500">{g.language || "—"}</td>
									)}
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
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
