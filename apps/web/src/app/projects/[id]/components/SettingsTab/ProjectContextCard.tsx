import { toggleItem } from "@agent-manager/utils";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { Guideline, GuidelineCategory, TechStack } from "@/lib/agent-api";
import {
	getGuidelineCategories,
	getGuidelines,
	getProject,
	getProjectContext,
	getTechStacks,
	updateGuideline,
	updateProjectContext,
	updateTechStack,
} from "@/lib/agent-api";
import { ContextSelectList } from "./ContextSelectList";
import { GuidelineSelectList } from "./GuidelineSelectList";

interface ProjectContextCardProps {
	projectId: string;
}

type LibraryEdit = { kind: "tech-stack"; item: TechStack } | { kind: "guideline"; item: Guideline };

export function ProjectContextCard({ projectId }: ProjectContextCardProps) {
	const [techStacks, setTechStacks] = useState<TechStack[]>([]);
	const [guidelines, setGuidelines] = useState<Guideline[]>([]);
	const [categories, setCategories] = useState<GuidelineCategory[]>([]);
	const [techStackIds, setTechStackIds] = useState<string[]>([]);
	const [guidelineIds, setGuidelineIds] = useState<string[]>([]);
	const [instructions, setInstructions] = useState("");
	const [binaries, setBinaries] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [editing, setEditing] = useState<LibraryEdit | null>(null);
	const [draft, setDraft] = useState("");
	const [savingEntity, setSavingEntity] = useState(false);

	const load = useCallback(async () => {
		try {
			const [stacks, guides, cats, ctx, proj] = await Promise.all([
				getTechStacks(),
				getGuidelines(),
				getGuidelineCategories(),
				getProjectContext(projectId),
				getProject(projectId),
			]);
			setTechStacks(stacks);
			setGuidelines(guides);
			setCategories(cats);
			setTechStackIds(ctx.techStackIds);
			setGuidelineIds(ctx.guidelineIds);
			setInstructions(ctx.instructions);
			setBinaries(proj?.binaries ?? []);
		} catch (err) {
			console.error("Failed to load project context:", err);
		} finally {
			setLoading(false);
		}
	}, [projectId]);

	useEffect(() => {
		load();
	}, [load]);

	function toggle(list: string[], setList: (value: string[]) => void, id: string) {
		setList(toggleItem(list, id));
	}

	async function save() {
		setSaving(true);
		try {
			await updateProjectContext(projectId, { techStackIds, guidelineIds, instructions });
			toast.success("Context saved. Restart the project for changes to take effect.");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to save context.");
		} finally {
			setSaving(false);
		}
	}

	function openEntityEdit(edit: LibraryEdit) {
		setEditing(edit);
		setDraft(edit.kind === "tech-stack" ? edit.item.description : edit.item.content);
	}

	async function saveEntity() {
		if (!editing) return;
		setSavingEntity(true);
		try {
			if (editing.kind === "tech-stack") {
				await updateTechStack(editing.item.id, { description: draft });
			} else {
				await updateGuideline(editing.item.id, { content: draft });
			}
			toast.success("Library item updated for all projects. Re-save context to apply here.");
			setEditing(null);
			await load();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to update library item.");
		} finally {
			setSavingEntity(false);
		}
	}

	if (loading) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>Project context</CardTitle>
				</CardHeader>
				<CardContent className="text-sm text-gray-500">Loading context...</CardContent>
			</Card>
		);
	}

	const selectedStacks = techStacks.filter((techStack) => techStackIds.includes(techStack.id));
	const selectedGuidelines = guidelines.filter((guideline) => guidelineIds.includes(guideline.id));

	return (
		<>
			<Card>
				<CardHeader>
					<CardTitle>Context Summary</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<div>
						<div className="text-sm font-medium mb-2">Selected Tech Stacks ({selectedStacks.length})</div>
						{selectedStacks.length === 0 ? (
							<p className="text-sm text-muted-foreground italic">None selected</p>
						) : (
							<ul className="space-y-1">
								{selectedStacks.map((stack) => (
									<li key={stack.id} className="text-sm text-gray-700">
										• {stack.name} ({stack.language})
									</li>
								))}
							</ul>
						)}
					</div>
					<div>
						<div className="text-sm font-medium mb-2">Selected Guidelines ({selectedGuidelines.length})</div>
						{selectedGuidelines.length === 0 ? (
							<p className="text-sm text-muted-foreground italic">None selected</p>
						) : (
							<ul className="space-y-1">
								{selectedGuidelines.map((guideline) => (
									<li key={guideline.id} className="text-sm text-gray-700">
										• {guideline.name}
									</li>
								))}
							</ul>
						)}
					</div>
					<div>
						<div className="text-sm font-medium mb-2">Project Instructions</div>
						{instructions ? (
							<p className="text-sm text-gray-700 whitespace-pre-wrap">{instructions}</p>
						) : (
							<p className="text-sm text-muted-foreground italic">None set</p>
						)}
					</div>
					<div>
						<div className="text-sm font-medium mb-2">Binaries</div>
						{binaries.length > 0 ? (
							<p className="text-sm text-gray-700">{binaries.join(", ")}</p>
						) : (
							<p className="text-sm text-muted-foreground italic">None configured</p>
						)}
					</div>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>Edit Context</CardTitle>
				</CardHeader>
				<CardContent className="space-y-6">
					<p className="text-sm text-muted-foreground">
						Selected tech stacks, guidelines, and instructions are injected into the agent&apos;s system prompt. Editing a library
						item changes it for every project that uses it.
					</p>

					<ContextSelectList
						title="Tech stacks"
						empty="No tech stacks in the library yet."
						items={techStacks.map((techStack) => ({
							id: techStack.id,
							label: `${techStack.name} (${techStack.language})`,
							sub: techStack.description,
						}))}
						selectedIds={techStackIds}
						onToggle={(id) => toggle(techStackIds, setTechStackIds, id)}
						onEdit={(id) => {
							const item = techStacks.find((techStack) => techStack.id === id);
							if (item) openEntityEdit({ kind: "tech-stack", item });
						}}
					/>

					<GuidelineSelectList
						guidelines={guidelines}
						categories={categories}
						selectedIds={guidelineIds}
						onToggle={(id) => toggle(guidelineIds, setGuidelineIds, id)}
						onEdit={(id) => {
							const item = guidelines.find((guideline) => guideline.id === id);
							if (item) openEntityEdit({ kind: "guideline", item });
						}}
					/>

					<div className="space-y-2">
						<div className="text-sm font-medium">Project instructions</div>
						<p className="text-xs text-muted-foreground">
							Free-form instructions specific to this project. Layered on top of the selected library items.
						</p>
						<Textarea
							value={instructions}
							onChange={(event) => setInstructions(event.target.value)}
							placeholder="e.g. Always run the full test suite before committing. Prefer functional components."
							rows={5}
						/>
					</div>

					<div className="flex justify-end">
						<Button type="button" onClick={save} disabled={saving}>
							{saving ? "Saving..." : "Save context"}
						</Button>
					</div>
				</CardContent>
			</Card>

			<Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Edit {editing?.kind === "tech-stack" ? "tech stack description" : "guideline content"}</DialogTitle>
						<DialogDescription>
							This edits the shared library item — changes apply to every project that uses it.
						</DialogDescription>
					</DialogHeader>
					<Textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={10} autoFocus />
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => setEditing(null)} disabled={savingEntity}>
							Cancel
						</Button>
						<Button type="button" onClick={saveEntity} disabled={savingEntity}>
							{savingEntity ? "Saving..." : "Save library item"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
