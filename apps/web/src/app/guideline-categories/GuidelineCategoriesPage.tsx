import { Edit2, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { GuidelineCategory } from "@/lib/agent-api";
import {
	createGuidelineCategory,
	deleteGuidelineCategory,
	getGuidelineCategories,
	updateGuidelineCategory,
} from "@/lib/agent-api";
import { mutateCache, useQuery } from "@/lib/query-cache";

const EMPTY_FORM = { name: "", description: "", color: "#6b7280" };
const inputCls = "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";

export default function GuidelineCategoriesPage() {
	const [editing, setEditing] = useState<GuidelineCategory | null>(null);
	const [creating, setCreating] = useState(false);
	const [form, setForm] = useState(EMPTY_FORM);

	const { data: categories = [], loading } = useQuery<GuidelineCategory[]>("guideline-categories", getGuidelineCategories);

	function openCreate() {
		setForm(EMPTY_FORM);
		setCreating(true);
		setEditing(null);
	}

	function openEdit(category: GuidelineCategory) {
		setForm({ name: category.name, description: category.description, color: category.color });
		setEditing(category);
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
				const updated = await updateGuidelineCategory(editing.id, form);
				mutateCache<GuidelineCategory[]>("guideline-categories", (list) =>
					list.map((category) => (category.id === editing.id ? updated : category))
				);
			} else {
				const created = await createGuidelineCategory(form);
				mutateCache<GuidelineCategory[]>("guideline-categories", (list) =>
					[...list, created].sort((category1, category2) => category1.name.localeCompare(category2.name))
				);
			}
			closeDialog();
		} catch (err) {
			console.error("Failed to save guideline category:", err);
		}
	}

	async function remove(id: string) {
		if (!confirm("Delete this category? Guidelines using it will become uncategorized.")) return;
		try {
			await deleteGuidelineCategory(id);
			mutateCache<GuidelineCategory[]>("guideline-categories", (list) => list.filter((category) => category.id !== id));
		} catch (err) {
			console.error("Failed to delete guideline category:", err);
		}
	}

	const dialogOpen = creating || editing !== null;

	return (
		<div className="min-h-screen bg-gray-50">
			<header className="bg-white border-b px-6 py-4 flex items-center justify-between">
				<div>
					<h1 className="text-xl font-bold text-gray-900">Guideline Categories</h1>
					<p className="text-sm text-gray-500 mt-0.5">Classify guidelines into reusable categories</p>
				</div>
				<button
					type="button"
					onClick={openCreate}
					className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
				>
					<Plus className="w-4 h-4" />
					New Category
				</button>
			</header>

			<main className="max-w-3xl mx-auto px-6 py-8">
				{loading && categories.length === 0 ? (
					<div className="text-gray-500 text-center py-16">Loading categories...</div>
				) : categories.length === 0 ? (
					<div className="text-center py-16 space-y-3">
						<p className="text-gray-400">No categories yet</p>
						<button type="button" onClick={openCreate} className="text-blue-600 hover:text-blue-700 text-sm">
							Create your first category
						</button>
					</div>
				) : (
					<div className="bg-white rounded-xl border border-gray-200 divide-y">
						{categories.map((category) => (
							<div key={category.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
								<div className="flex items-center gap-3 min-w-0">
									<span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: category.color }} />
									<div className="min-w-0">
										<h3 className="font-semibold text-gray-900">{category.name}</h3>
										{category.description && <p className="text-sm text-gray-500 mt-0.5">{category.description}</p>}
									</div>
								</div>
								<div className="flex gap-1 shrink-0">
									<button
										type="button"
										onClick={() => openEdit(category)}
										className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
										title="Edit"
										aria-label="Edit category"
									>
										<Edit2 className="w-3.5 h-3.5" />
									</button>
									<button
										type="button"
										onClick={() => remove(category.id)}
										className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
										title="Delete"
										aria-label="Delete category"
									>
										<Trash2 className="w-3.5 h-3.5" />
									</button>
								</div>
							</div>
						))}
					</div>
				)}
			</main>

			{dialogOpen && (
				<div
					className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
					onClick={(event) => event.target === event.currentTarget && closeDialog()}
					onKeyDown={(event) => event.key === "Escape" && closeDialog()}
					role="dialog"
					aria-modal="true"
				>
					<div className="bg-white rounded-xl shadow-2xl w-full max-w-md flex flex-col">
						<div className="flex items-center justify-between px-6 py-4 border-b">
							<h2 className="text-base font-semibold text-gray-900">{editing ? "Edit Category" : "New Category"}</h2>
							<button type="button" onClick={closeDialog} className="text-gray-400 hover:text-gray-600">
								<X className="w-4 h-4" />
							</button>
						</div>
						<div className="p-6 space-y-4">
							<div className="space-y-1.5">
								<label className="text-sm font-medium text-gray-700" htmlFor="gc-name">
									Name *
								</label>
								<input
									id="gc-name"
									// biome-ignore lint/a11y/noAutofocus: intentional focus for modal
									autoFocus
									type="text"
									value={form.name}
									onChange={(event) => setForm({ ...form, name: event.target.value })}
									className={inputCls}
									placeholder="Category name"
								/>
							</div>
							<div className="space-y-1.5">
								<label className="text-sm font-medium text-gray-700" htmlFor="gc-desc">
									Description
								</label>
								<input
									id="gc-desc"
									type="text"
									value={form.description}
									onChange={(event) => setForm({ ...form, description: event.target.value })}
									className={inputCls}
									placeholder="Short description"
								/>
							</div>
							<div className="space-y-1.5">
								<label className="text-sm font-medium text-gray-700" htmlFor="gc-color">
									Color
								</label>
								<div className="flex items-center gap-2">
									<input
										id="gc-color"
										type="color"
										value={form.color}
										onChange={(event) => setForm({ ...form, color: event.target.value })}
										className="w-9 h-9 rounded-lg border border-gray-300 cursor-pointer p-0.5"
									/>
									<span className="text-sm text-gray-500">{form.color}</span>
								</div>
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
