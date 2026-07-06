import { replaceOrPrependById } from "@agent-manager/utils";
import { Edit2, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { Guideline, GuidelineCategory } from "@/lib/agent-api";
import { createGuideline, deleteGuideline, getGuidelineCategories, getGuidelines, updateGuideline } from "@/lib/agent-api";
import { mutateCache, useQuery } from "@/lib/query-cache";
import { byNewestFirst, cn } from "@/lib/utils";

type Form = { name: string; description: string; categoryId: string | null; language: string | null; content: string };

const EMPTY_FORM: Form = { name: "", description: "", categoryId: null, language: null, content: "" };
const inputClassName =
	"w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";

export default function GuidelinesPage() {
	const [filter, setFilter] = useState<string | "all">("all");
	const [editing, setEditing] = useState<Guideline | null>(null);
	const [creating, setCreating] = useState(false);
	const [form, setForm] = useState<Form>(EMPTY_FORM);

	const { data: guidelines = [], loading } = useQuery<Guideline[]>("guidelines", getGuidelines);
	const { data: categories = [] } = useQuery<GuidelineCategory[]>("guideline-categories", getGuidelineCategories);

	const categoryName = (id: string | null) => categories.find((category) => category.id === id)?.name ?? "Uncategorized";
	const visible = [...(filter === "all" ? guidelines : guidelines.filter((guideline) => guideline.categoryId === filter))].sort(
		byNewestFirst
	);

	function openCreate() {
		setForm(EMPTY_FORM);
		setCreating(true);
		setEditing(null);
	}

	function openEdit(guideline: Guideline) {
		setForm({
			name: guideline.name,
			description: guideline.description,
			categoryId: guideline.categoryId,
			language: guideline.language ?? null,
			content: guideline.content,
		});
		setEditing(guideline);
		setCreating(false);
	}

	function closeDialog() {
		setCreating(false);
		setEditing(null);
	}

	async function save() {
		if (!form.name.trim()) return;
		try {
			const saved = editing ? await updateGuideline(editing.id, form) : await createGuideline(form);
			mutateCache<Guideline[]>("guidelines", (list) => replaceOrPrependById(list, saved));
			closeDialog();
		} catch (err) {
			console.error("Failed to save guideline:", err);
		}
	}

	async function remove(id: string) {
		if (!confirm("Delete this guideline?")) return;
		try {
			await deleteGuideline(id);
			mutateCache<Guideline[]>("guidelines", (list) => list.filter((guideline) => guideline.id !== id));
		} catch (err) {
			console.error("Failed to delete guideline:", err);
		}
	}

	const dialogOpen = creating || editing !== null;

	return (
		<div className="min-h-screen bg-gray-50">
			<header className="bg-white border-b px-6 py-4 flex items-center justify-between">
				<div>
					<h1 className="text-xl font-bold text-gray-900">Guidelines</h1>
					<p className="text-sm text-gray-500 mt-0.5">Reusable guidelines, classified by category</p>
				</div>
				<button
					type="button"
					onClick={openCreate}
					className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
				>
					<Plus className="w-4 h-4" />
					New Guideline
				</button>
			</header>

			<div className="bg-white border-b px-6 py-2 flex items-center gap-2 flex-wrap">
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
				{categories.map((cat) => (
					<button
						key={cat.id}
						type="button"
						onClick={() => setFilter(cat.id)}
						className={cn(
							"px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
							filter === cat.id ? "text-white" : "text-gray-600 hover:bg-gray-100"
						)}
						style={filter === cat.id ? { backgroundColor: cat.color } : undefined}
					>
						{cat.name}
					</button>
				))}
			</div>

			<main className="max-w-5xl mx-auto px-6 py-8">
				{loading && guidelines.length === 0 ? (
					<div className="text-gray-500 text-center py-16">Loading guidelines...</div>
				) : visible.length === 0 ? (
					<div className="text-center py-16 space-y-3">
						<p className="text-gray-400">No guidelines yet</p>
						<button type="button" onClick={openCreate} className="text-blue-600 hover:text-blue-700 text-sm">
							Create your first guideline
						</button>
					</div>
				) : (
					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						{visible.map((guideline) => (
							<div
								key={guideline.id}
								className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-3 hover:border-gray-300 transition-colors"
							>
								<div className="flex items-start justify-between gap-3">
									<div className="min-w-0">
										<div className="flex items-center gap-2 mb-1">
											<span
												className="text-xs font-medium px-2 py-0.5 rounded-full text-white"
												style={{
													backgroundColor:
														categories.find((category) => category.id === guideline.categoryId)?.color ?? "#6b7280",
												}}
											>
												{categoryName(guideline.categoryId)}
											</span>
											{guideline.language && (
												<span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
													{guideline.language}
												</span>
											)}
										</div>
										<h3 className="font-semibold text-gray-900 truncate">{guideline.name}</h3>
										{guideline.description && (
											<p className="text-sm text-gray-500 mt-0.5 line-clamp-2">{guideline.description}</p>
										)}
									</div>
									<div className="flex gap-1 shrink-0">
										<button
											type="button"
											onClick={() => openEdit(guideline)}
											className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
											title="Edit"
										>
											<Edit2 className="w-3.5 h-3.5" />
										</button>
										<button
											type="button"
											onClick={() => remove(guideline.id)}
											className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
											title="Delete"
										>
											<Trash2 className="w-3.5 h-3.5" />
										</button>
									</div>
								</div>
								{guideline.content && (
									<pre className="bg-gray-50 rounded-lg p-3 text-xs text-gray-600 font-mono overflow-hidden line-clamp-4 whitespace-pre-wrap">
										{guideline.content}
									</pre>
								)}
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
					<div className="bg-white rounded-xl shadow-2xl w-full max-w-lg flex flex-col max-h-[90vh]">
						<div className="flex items-center justify-between px-6 py-4 border-b">
							<h2 className="text-base font-semibold text-gray-900">{editing ? "Edit Guideline" : "New Guideline"}</h2>
							<button type="button" onClick={closeDialog} className="text-gray-400 hover:text-gray-600">
								<X className="w-4 h-4" />
							</button>
						</div>
						<div className="p-6 space-y-4 overflow-y-auto flex-1">
							<div className="space-y-1.5">
								<label className="text-sm font-medium text-gray-700" htmlFor="gl-name">
									Name *
								</label>
								<input
									id="gl-name"
									// biome-ignore lint/a11y/noAutofocus: intentional focus for modal
									autoFocus
									type="text"
									value={form.name}
									onChange={(event) => setForm({ ...form, name: event.target.value })}
									className={inputClassName}
									placeholder="Guideline name"
								/>
							</div>
							<div className="space-y-1.5">
								<label className="text-sm font-medium text-gray-700" htmlFor="gl-desc">
									Description
								</label>
								<input
									id="gl-desc"
									type="text"
									value={form.description}
									onChange={(event) => setForm({ ...form, description: event.target.value })}
									className={inputClassName}
									placeholder="Short description"
								/>
							</div>
							<div className="space-y-1.5">
								<label className="text-sm font-medium text-gray-700" htmlFor="gl-cat">
									Category
								</label>
								<select
									id="gl-cat"
									value={form.categoryId ?? ""}
									onChange={(event) => setForm({ ...form, categoryId: event.target.value || null })}
									className={inputClassName}
								>
									<option value="" disabled>
										Select a category
									</option>
									{categories.map((category) => (
										<option key={category.id} value={category.id}>
											{category.name}
										</option>
									))}
								</select>
							</div>
							<div className="space-y-1.5">
								<label className="text-sm font-medium text-gray-700" htmlFor="gl-lang">
									Language <span className="text-gray-400 font-normal">(optional)</span>
								</label>
								<input
									id="gl-lang"
									type="text"
									value={form.language ?? ""}
									onChange={(event) => setForm({ ...form, language: event.target.value || null })}
									className={inputClassName}
									placeholder="e.g. TypeScript, Python, Rust…"
								/>
							</div>
							<div className="space-y-1.5">
								<label className="text-sm font-medium text-gray-700" htmlFor="gl-content">
									Content
								</label>
								<textarea
									id="gl-content"
									value={form.content}
									onChange={(event) => setForm({ ...form, content: event.target.value })}
									rows={8}
									className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
									placeholder="Guideline content — the instructions injected into a project"
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
