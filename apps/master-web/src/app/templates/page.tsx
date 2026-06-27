"use client";

import {
	createTemplate,
	deleteTemplate,
	getTemplates,
	updateTemplate,
} from "@/lib/agent-api";
import type { Template } from "@/lib/agent-api";
import { useQuery, mutateCache } from "@/lib/query-cache";
import { cn } from "@/lib/utils";
import { Edit2, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";

type Category = Template["category"];

const CATEGORIES: { value: Category; label: string; color: string }[] = [
	{ value: "tech-stack", label: "Tech Stack", color: "bg-blue-100 text-blue-700" },
	{ value: "ui-design", label: "UI Design", color: "bg-purple-100 text-purple-700" },
	{ value: "best-practices", label: "Best Practices", color: "bg-green-100 text-green-700" },
	{ value: "system-prompt", label: "System Prompt", color: "bg-orange-100 text-orange-700" },
];

const categoryColor = (c: Category) => CATEGORIES.find((x) => x.value === c)?.color ?? "bg-gray-100 text-gray-600";
const categoryLabel = (c: Category) => CATEGORIES.find((x) => x.value === c)?.label ?? c;

const EMPTY_FORM = { name: "", description: "", category: "tech-stack" as Category, content: "" };

export default function TemplatesPage() {
	const [filter, setFilter] = useState<Category | "all">("all");
	const [editing, setEditing] = useState<Template | null>(null);
	const [creating, setCreating] = useState(false);
	const [form, setForm] = useState(EMPTY_FORM);

	const { data: templates = [], loading, refetch } = useQuery<Template[]>("templates", getTemplates);

	const visible = filter === "all" ? templates : templates.filter((t) => t.category === filter);

	function openCreate() {
		setForm(EMPTY_FORM);
		setCreating(true);
		setEditing(null);
	}

	function openEdit(t: Template) {
		setForm({ name: t.name, description: t.description, category: t.category, content: t.content });
		setEditing(t);
		setCreating(false);
	}

	function closeDialog() {
		setCreating(false);
		setEditing(null);
	}

	async function save() {
		if (!form.name.trim()) return;
		try {
			if (editing) {
				const updated = await updateTemplate(editing.id, form);
				mutateCache<Template[]>("templates", (list) => list.map((t) => (t.id === editing.id ? updated : t)));
			} else {
				const created = await createTemplate(form);
				mutateCache<Template[]>("templates", (list) => [created, ...list]);
			}
			closeDialog();
		} catch (err) {
			console.error("Failed to save template:", err);
		}
	}

	async function remove(id: string) {
		if (!confirm("Delete this template?")) return;
		try {
			await deleteTemplate(id);
			mutateCache<Template[]>("templates", (list) => list.filter((t) => t.id !== id));
		} catch (err) {
			console.error("Failed to delete template:", err);
		}
	}

	const dialogOpen = creating || editing !== null;

	return (
		<div className="min-h-screen bg-gray-50">
			<header className="bg-white border-b px-6 py-4 flex items-center justify-between">
				<div>
					<h1 className="text-xl font-bold text-gray-900">Templates</h1>
					<p className="text-sm text-gray-500 mt-0.5">Reusable tech stacks, UI patterns, best practices, and system prompts</p>
				</div>
				<button
					type="button"
					onClick={openCreate}
					className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
				>
					<Plus className="w-4 h-4" />
					New Template
				</button>
			</header>

			{/* Category filter */}
			<div className="bg-white border-b px-6 py-2 flex items-center gap-2">
				<button
					type="button"
					onClick={() => setFilter("all")}
					className={cn(
						"px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
						filter === "all" ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100"
					)}
				>
					All
				</button>
				{CATEGORIES.map((cat) => (
					<button
						key={cat.value}
						type="button"
						onClick={() => setFilter(cat.value)}
						className={cn(
							"px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
							filter === cat.value ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100"
						)}
					>
						{cat.label}
					</button>
				))}
			</div>

			<main className="max-w-5xl mx-auto px-6 py-8">
				{loading && templates.length === 0 ? (
					<div className="text-gray-500 text-center py-16">Loading templates...</div>
				) : visible.length === 0 ? (
					<div className="text-center py-16 space-y-3">
						<p className="text-gray-400">No templates yet</p>
						<button type="button" onClick={openCreate} className="text-blue-600 hover:text-blue-700 text-sm">
							Create your first template
						</button>
					</div>
				) : (
					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						{visible.map((t) => (
							<div key={t.id} className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-3 hover:border-gray-300 transition-colors">
								<div className="flex items-start justify-between gap-3">
									<div className="min-w-0">
										<div className="flex items-center gap-2 mb-1">
											<span className={cn("text-xs font-medium px-2 py-0.5 rounded-full", categoryColor(t.category))}>
												{categoryLabel(t.category)}
											</span>
										</div>
										<h3 className="font-semibold text-gray-900 truncate">{t.name}</h3>
										{t.description && <p className="text-sm text-gray-500 mt-0.5 line-clamp-2">{t.description}</p>}
									</div>
									<div className="flex gap-1 shrink-0">
										<button
											type="button"
											onClick={() => openEdit(t)}
											className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
											title="Edit"
										>
											<Edit2 className="w-3.5 h-3.5" />
										</button>
										<button
											type="button"
											onClick={() => remove(t.id)}
											className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
											title="Delete"
										>
											<Trash2 className="w-3.5 h-3.5" />
										</button>
									</div>
								</div>
								{t.content && (
									<pre className="bg-gray-50 rounded-lg p-3 text-xs text-gray-600 font-mono overflow-hidden line-clamp-4 whitespace-pre-wrap">
										{t.content}
									</pre>
								)}
							</div>
						))}
					</div>
				)}
			</main>

			{/* Create / Edit dialog */}
			{dialogOpen && (
				<div
					className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
					onClick={closeDialog}
					onKeyDown={(e) => e.key === "Escape" && closeDialog()}
					role="dialog"
					aria-modal="true"
				>
					<div
						className="bg-white rounded-xl shadow-2xl w-full max-w-lg flex flex-col max-h-[90vh]"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="flex items-center justify-between px-6 py-4 border-b">
							<h2 className="text-base font-semibold text-gray-900">{editing ? "Edit Template" : "New Template"}</h2>
							<button type="button" onClick={closeDialog} className="text-gray-400 hover:text-gray-600">
								<X className="w-4 h-4" />
							</button>
						</div>

						<div className="p-6 space-y-4 overflow-y-auto flex-1">
							<div className="space-y-1.5">
								<label className="text-sm font-medium text-gray-700" htmlFor="tpl-name">Name *</label>
								<input
									id="tpl-name"
									// biome-ignore lint/a11y/noAutofocus: intentional focus for modal
									autoFocus
									type="text"
									value={form.name}
									onChange={(e) => setForm({ ...form, name: e.target.value })}
									className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
									placeholder="Template name"
								/>
							</div>

							<div className="space-y-1.5">
								<label className="text-sm font-medium text-gray-700" htmlFor="tpl-desc">Description</label>
								<input
									id="tpl-desc"
									type="text"
									value={form.description}
									onChange={(e) => setForm({ ...form, description: e.target.value })}
									className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
									placeholder="Short description"
								/>
							</div>

							<div className="space-y-1.5">
								<span className="text-sm font-medium text-gray-700">Category</span>
								<div className="flex flex-wrap gap-2">
									{CATEGORIES.map((cat) => (
										<button
											key={cat.value}
											type="button"
											onClick={() => setForm({ ...form, category: cat.value })}
											className={cn(
												"px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors",
												form.category === cat.value
													? "border-blue-600 bg-blue-50 text-blue-700"
													: "border-gray-200 text-gray-600 hover:bg-gray-50"
											)}
										>
											{cat.label}
										</button>
									))}
								</div>
							</div>

							<div className="space-y-1.5">
								<label className="text-sm font-medium text-gray-700" htmlFor="tpl-content">Content</label>
								<textarea
									id="tpl-content"
									value={form.content}
									onChange={(e) => setForm({ ...form, content: e.target.value })}
									rows={8}
									className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
									placeholder="Template content — paste your config, prompt, or instructions here"
								/>
							</div>
						</div>

						<div className="flex gap-2 px-6 py-4 border-t">
							<button
								type="button"
								onClick={save}
								disabled={!form.name.trim()}
								className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
							>
								{editing ? "Save changes" : "Create"}
							</button>
							<button
								type="button"
								onClick={closeDialog}
								className="flex-1 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-200"
							>
								Cancel
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
