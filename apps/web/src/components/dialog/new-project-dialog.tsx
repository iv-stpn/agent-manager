import { groupBy, toggleItem } from "@agent-manager/utils";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
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
	checkWorkspacePath,
	createProjectStream,
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

interface ProgressStep {
	key: string;
	label: string;
	status: "running" | "done" | "error";
	detail?: string;
}

/** Turn a `createProject` progress step key (see manager.ts's `createProject`) into a readable label. */
function stepLabel(key: string): string {
	const [kind, ...rest] = key.split(":");
	const suffix = rest.join(":");
	switch (kind) {
		case "workspace":
			return "Setting up workspace";
		case "seed":
			return suffix ? `Fetching template (${suffix})` : "Fetching template";
		case "install":
			return suffix ? `Installing dependencies (${suffix})` : "Installing dependencies";
		case "finalize":
			return "Finalizing project";
		default:
			return key;
	}
}

/** Derive a readable subdirectory name from a GitHub URL (e.g. repo name). */
function defaultGithubSubdir(url: string): string {
	const trimmed = url.trim();
	if (!trimmed) return "";
	try {
		const url = new URL(trimmed);
		const last = url.pathname.split("/").filter(Boolean).pop();
		if (!last) return "";
		return last.replace(/\.git$/, "");
	} catch {
		return "";
	}
}

interface NewProjectFormProps {
	loading: boolean;
	onLoadingChange: (loading: boolean) => void;
	onSuccess?: () => void;
	onCancel?: () => void;
}

function NewProjectForm({ loading, onLoadingChange, onSuccess, onCancel }: NewProjectFormProps) {
	const [step, setStep] = useState<Step>("basic");
	const [form, setForm] = useState<NewProjectFormValues>(emptyForm);
	const [pathWarning, setPathWarning] = useState<PathWarning>(null);
	const [acknowledgeDelete, setAcknowledgeDelete] = useState(false);
	const [llmClients, setLlmClients] = useState<LlmClient[]>([]);
	const [addingClient, setAddingClient] = useState(false);
	const [progressSteps, setProgressSteps] = useState<ProgressStep[]>([]);
	const [progressLines, setProgressLines] = useState<Record<string, string[]>>({});

	// Load LLM clients on mount
	useEffect(() => {
		getLlmClients()
			.then(setLlmClients)
			.catch((err) => console.error("Failed to load LLM clients:", err));
	}, []);

	function onClientSaved(client: LlmClient) {
		setLlmClients((prev) => [client, ...prev]);
		setForm((form) => ({ ...form, clientId: client.id }));
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
	const [githubTemplates, setGithubTemplates] = useState<Array<{ id: string; url: string; subdirectory: string }>>([]);
	const [templateSubdirs, setTemplateSubdirs] = useState<Record<string, string>>({});
	const [templatesLoading, setTemplatesLoading] = useState(false);

	const update = (field: keyof NewProjectFormValues, value: string) => setForm((form) => ({ ...form, [field]: value }));

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
		setSelectedTechStacks((previous) => toggleItem(previous, id));
	}

	function toggleGuideline(id: string) {
		setSelectedGuidelines((previous) => toggleItem(previous, id));
	}

	function toggleBinary(binary: "python3" | "workerd" | "cargo") {
		setForm((form) => ({ ...form, binaries: toggleItem(form.binaries, binary) }));
	}

	function toggleTemplate(name: string) {
		setSelectedTemplates((prev) => toggleItem(prev, name));
	}

	function addGithubTemplate(url = "") {
		setGithubTemplates((previous) => [...previous, { id: crypto.randomUUID(), url, subdirectory: "" }]);
	}
	function updateGithubTemplate(id: string, field: "url" | "subdirectory", value: string) {
		setGithubTemplates((previous) =>
			previous.map((githubTemplate) => (githubTemplate.id === id ? { ...githubTemplate, [field]: value } : githubTemplate))
		);
	}
	function removeGithubTemplate(id: string) {
		setGithubTemplates((previous) => previous.filter((githubTemplate) => githubTemplate.id !== id));
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

		onLoadingChange(true);
		setProgressSteps([]);
		setProgressLines({});
		try {
			// Build templates array — local + github templates.
			// The backend places each template in its own subdirectory when more
			// than one template is provided; a single template with no explicit
			// subdirectory goes directly into the workspace root.
			const rawTemplates: TemplateSelection[] = [];
			for (const name of selectedTemplates) {
				const subdir = templateSubdirs[name]?.trim();
				rawTemplates.push({ type: "local", source: name, ...(subdir && { subdirectory: subdir }) });
			}
			for (const githubTemplate of githubTemplates) {
				const url = githubTemplate.url.trim();
				if (!url) continue;
				const subdir = githubTemplate.subdirectory.trim();
				rawTemplates.push({ type: "github", source: url, ...(subdir && { subdirectory: subdir }) });
			}

			// When multiple templates are selected, give each GitHub template a
			// readable subdirectory name (derived from the repo) if the user left
			// it blank, so the created subfolders aren't slugified URLs.
			const multipleTemplates = rawTemplates.length > 1;
			const templatesList: TemplateSelection[] = multipleTemplates
				? rawTemplates.map((template) => {
						if (template.subdirectory || template.type !== "github") return template;
						return { ...template, subdirectory: defaultGithubSubdir(template.source) };
					})
				: rawTemplates;

			const created = await createProjectStream(
				{
					name: form.name.trim(),
					description: form.description || undefined,
					workspacePath: form.workspacePath || undefined,
					agent: {
						clientId: form.clientId,
					},
					...(templatesList.length > 0 && { templates: templatesList }),
					...(form.binaries.length > 0 && { binaries: form.binaries }),
				},
				{
					onStep: (stepKey, status, detail) => {
						setProgressSteps((prev) => {
							const label = stepLabel(stepKey);
							const idx = prev.findIndex((s) => s.key === stepKey);
							const entry: ProgressStep = { key: stepKey, label, status, detail };
							if (idx === -1) return [...prev, entry];
							const next = [...prev];
							next[idx] = entry;
							return next;
						});
					},
					onLine: (stepKey, lineText) => {
						setProgressLines((prev) => ({ ...prev, [stepKey]: [...(prev[stepKey] ?? []), lineText].slice(-8) }));
					},
				}
			);

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
			setGithubTemplates([]);
			setTemplateSubdirs({});
			setProgressSteps([]);
			setProgressLines({});
			setStep("basic");
			toast.success("Project created");
			onSuccess?.();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to create project");
		} finally {
			onLoadingChange(false);
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
						<div className="flex gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
							<AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
							<div className="space-y-1">
								<p className="text-sm font-semibold text-destructive">
									Warning: all files in this folder will be permanently deleted
								</p>
								<p className="text-sm text-muted-foreground">
									The folder <code className="bg-muted px-1 rounded">{pathWarning.path}</code> is not empty. To apply the selected
									template,{" "}
									<span className="font-semibold text-destructive">
										every file and subfolder currently in this folder will be permanently deleted
									</span>
									. This action cannot be undone.
								</p>
							</div>
						</div>
						{/* biome-ignore lint/a11y/noLabelWithoutControl: the Checkbox is bound to this label */}
						<label className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 cursor-pointer">
							<Checkbox
								checked={acknowledgeDelete}
								onCheckedChange={(value) => setAcknowledgeDelete(value === true)}
								className="mt-0.5"
							/>
							<span className="text-sm text-muted-foreground">
								I understand that all files currently in this folder will be permanently deleted.
							</span>
						</label>
						<div className="flex gap-2">
							<Button
								variant="destructive"
								className="flex-1"
								disabled={!acknowledgeDelete}
								onClick={() => {
									setPathWarning(null);
									setAcknowledgeDelete(false);
									handleSubmit(true);
								}}
							>
								Delete &amp; continue
							</Button>
							<Button
								className="flex-1"
								variant="secondary"
								onClick={() => {
									setPathWarning(null);
									setAcknowledgeDelete(false);
								}}
							>
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
		<>
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
						{(selectedTemplates.length > 0 || githubTemplates.some((githubTemplate) => githubTemplate.url.trim())) && (
							<span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 text-[10px] font-semibold rounded-full bg-blue-100 text-blue-700">
								{selectedTemplates.length + githubTemplates.filter((githubTemplate) => githubTemplate.url.trim()).length}
							</span>
						)}
					</button>
				</div>

				{step === "basic" && (
					<form
						onSubmit={(event) => {
							event.preventDefault();
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
								onChange={(event) => update("name", event.target.value)}
								placeholder="My Project"
								required
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="np-desc">Description</Label>
							<Input
								id="np-desc"
								value={form.description}
								onChange={(event) => update("description", event.target.value)}
								placeholder="Optional description"
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="np-path">Workspace Path</Label>
							<Input
								id="np-path"
								value={form.workspacePath}
								onChange={(event) => update("workspacePath", event.target.value)}
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
								onChange={(event) => update("clientId", event.target.value)}
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
														<Checkbox checked={selected} onCheckedChange={() => toggleTemplate(tpl.name)} />
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
														{selected && (
															<Input
																placeholder={`subdir · ${tpl.name}`}
																value={templateSubdirs[tpl.name] || ""}
																onChange={(event) => {
																	event.stopPropagation();
																	setTemplateSubdirs((prev) => ({ ...prev, [tpl.name]: event.target.value }));
																}}
																className="w-36 h-7 text-xs"
																onClick={(event) => event.stopPropagation()}
															/>
														)}
													</label>
												);
											})}
										</div>
									)}
								</div>

								{/* GitHub templates */}
								<div className="space-y-2">
									<Label className="text-sm font-medium">GitHub Repository URLs</Label>
									{githubTemplates.length === 0 && <p className="text-xs italic text-gray-400">No GitHub templates added yet.</p>}
									<div className="space-y-2">
										{githubTemplates.map((githubTemplate) => (
											<div key={githubTemplate.id} className="flex gap-2 items-center">
												<Input
													type="url"
													value={githubTemplate.url}
													onChange={(event) => updateGithubTemplate(githubTemplate.id, "url", event.target.value)}
													placeholder="https://github.com/user/repo.git"
													className="flex-1"
												/>
												<Input
													value={githubTemplate.subdirectory}
													onChange={(event) => updateGithubTemplate(githubTemplate.id, "subdirectory", event.target.value)}
													placeholder={`subdir · ${githubTemplate.url ? defaultGithubSubdir(githubTemplate.url) || "auto" : "auto"}`}
													className="w-44"
												/>
												<Button
													type="button"
													variant="ghost"
													size="sm"
													onClick={() => removeGithubTemplate(githubTemplate.id)}
													className="text-gray-400 hover:text-destructive px-2"
												>
													✕
												</Button>
											</div>
										))}
									</div>
									<Button type="button" variant="outline" size="sm" onClick={() => addGithubTemplate("")}>
										+ Add GitHub template
									</Button>
									<p className="text-xs text-gray-500">
										Clone one or more public GitHub repositories. Multiple templates are placed in separate subfolders.
									</p>
								</div>

								{/* Tech stack suggestions */}
								{selectedTechStacks.length > 0 && techStacks.length > 0 && (
									<div className="border rounded-lg p-3 bg-blue-50/30">
										<p className="text-sm font-medium mb-2">Suggested from selected tech stacks:</p>
										<div className="space-y-1">
											{selectedTechStacks
												.map((stackId) => techStacks.find((techStack) => techStack.id === stackId))
												.filter((stack): stack is TechStack => Boolean(stack?.templateGithubUrl))
												.map((stack) => {
													const alreadyAdded = githubTemplates.some(
														(githubTemplate) => githubTemplate.url.trim() === (stack.templateGithubUrl || "").trim()
													);
													return (
														<div key={stack.id} className="flex items-center gap-2 text-xs">
															<span className="font-medium">{stack.name}:</span>
															<span className="text-gray-500 truncate flex-1">{stack.templateGithubUrl}</span>
															<Button
																type="button"
																variant="outline"
																size="sm"
																disabled={alreadyAdded}
																onClick={() => addGithubTemplate(stack.templateGithubUrl || "")}
																className="h-6 px-2 text-xs"
															>
																{alreadyAdded ? "Added" : "Use"}
															</Button>
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
											{techStacks.map((techStack) => {
												const selected = selectedTechStacks.includes(techStack.id);
												return (
													<li key={techStack.id}>
														<label
															htmlFor={`stack-${techStack.id}`}
															className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-gray-50 transition-colors cursor-pointer"
														>
															<Checkbox
																id={`stack-${techStack.id}`}
																checked={selected}
																onCheckedChange={() => toggleStack(techStack.id)}
															/>
															<span className="min-w-0">
																<span className="block text-sm font-medium">{techStack.name}</span>
																<span className="block text-xs text-gray-500">
																	{techStack.language}
																	{techStack.description ? ` · ${techStack.description}` : ""}
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
			{loading && (
				<div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-4 rounded-lg bg-background/95 p-6 backdrop-blur-sm">
					<p className="text-sm font-medium text-muted-foreground">Creating project...</p>
					{progressSteps.length === 0 ? (
						<Loader2 className="h-8 w-8 animate-spin text-blue-600" />
					) : (
						<ul className="w-full max-w-sm space-y-2">
							{progressSteps.map((progressStep) => (
								<li key={progressStep.key} className="space-y-1">
									<div className="flex items-center gap-2 text-sm">
										{progressStep.status === "running" && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-600" />}
										{progressStep.status === "done" && <Check className="h-4 w-4 shrink-0 text-green-600" />}
										{progressStep.status === "error" && <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />}
										<span className={cn(progressStep.status === "error" && "text-amber-600")}>{progressStep.label}</span>
									</div>
									{progressStep.status === "error" && progressStep.detail && (
										<p className="pl-6 text-xs text-muted-foreground">{progressStep.detail}</p>
									)}
									{progressStep.status === "running" && (progressLines[progressStep.key]?.length ?? 0) > 0 && (
										<pre className="ml-6 max-h-24 overflow-y-auto rounded bg-muted px-2 py-1 text-[10px] leading-relaxed text-muted-foreground">
											{progressLines[progressStep.key]?.join("\n")}
										</pre>
									)}
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</>
	);
}

/** Grouped guideline picker used in the new-project form. */
type GuidelinePickerListProps = {
	guidelines: Guideline[];
	categories: GuidelineCategory[];
	selectedIds: string[];
	onToggle: (id: string) => void;
};

function GuidelinePickerList({ guidelines, categories, selectedIds, onToggle }: GuidelinePickerListProps) {
	// Group by category
	const grouped = groupBy(guidelines, (guideline) => guideline.categoryId ?? null);

	const orderedKeys: Array<string | null> = [
		...categories.map((category) => category.id).filter((id) => grouped.has(id)),
		...(grouped.has(null) ? [null] : []),
	];

	const [activeKey, setActiveKey] = useState<string | null>(orderedKeys[0] ?? null);

	// Keep the active tab valid as the library loads/changes.
	const activeExists = orderedKeys.some((key) => key === activeKey);
	const currentKey = activeExists ? activeKey : (orderedKeys[0] ?? null);

	const guidelineChoices = grouped.get(currentKey) ?? [];
	const hasLanguage = guidelineChoices.some((guideline) => guideline.language);

	return (
		<div>
			{/* Category tabs */}
			<div className="flex flex-wrap gap-1 border-b mb-2">
				{orderedKeys.map((categoryId) => {
					const category = categoryId ? categories.find((category) => category.id === categoryId) : null;
					const count = grouped.get(categoryId)?.length ?? 0;
					const active = categoryId === currentKey;

					return (
						<button
							key={categoryId ?? "__uncategorized"}
							type="button"
							onClick={() => setActiveKey(categoryId)}
							className={cn(
								"flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition",
								active ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"
							)}
						>
							{category ? <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: category.color }} /> : null}
							<span>{category ? category.name : "Uncategorized"}</span>
							<span className="text-gray-400">({count})</span>
						</button>
					);
				})}
			</div>

			<div className="max-h-64 overflow-y-auto pr-1">
				<table className="w-full text-left rounded-md border border-separate border-spacing-0 overflow-hidden">
					<tbody>
						{guidelineChoices.map((guideline) => {
							const selected = selectedIds.includes(guideline.id);
							return (
								<tr
									key={guideline.id}
									onClick={() => onToggle(guideline.id)}
									className={cn(
										"cursor-pointer transition-colors hover:bg-gray-50",
										selected && "bg-blue-50/60 hover:bg-blue-50"
									)}
								>
									<td className="w-8 px-3 py-2 align-top border-b">
										<Checkbox
											id={`guideline-${guideline.id}`}
											checked={selected}
											onCheckedChange={() => onToggle(guideline.id)}
											onClick={(event) => event.stopPropagation()}
										/>
									</td>
									<td className="px-3 py-2 align-top border-b text-sm font-medium">{guideline.name}</td>
									<td className="px-3 py-2 align-top border-b text-xs text-gray-500">{guideline.description || "—"}</td>
									{hasLanguage && (
										<td className="w-24 px-3 py-2 align-top border-b text-xs text-gray-500">{guideline.language || "—"}</td>
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
	const [loading, setLoading] = useState(false);
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				// Block closing (X, Escape, backdrop) while a project is being created.
				if (!next && loading) return;
				onOpenChange(next);
			}}
		>
			<DialogContent className="max-h-[85vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>New Project</DialogTitle>
				</DialogHeader>
				<NewProjectForm
					loading={loading}
					onLoadingChange={setLoading}
					onSuccess={() => onOpenChange(false)}
					onCancel={() => onOpenChange(false)}
				/>
			</DialogContent>
		</Dialog>
	);
}
