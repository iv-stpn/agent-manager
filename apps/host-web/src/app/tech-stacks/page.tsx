import { Edit2, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { StackEntry, TechStack } from "@/lib/agent-api";
import { createTechStack, deleteTechStack, getTechStacks, updateTechStack } from "@/lib/agent-api";
import { mutateCache, useQuery } from "@/lib/query-cache";

type Form = { language: string; name: string; description: string; stack: StackEntry[] };

const EMPTY_FORM: Form = { language: "", name: "", description: "", stack: [] };
const EMPTY_ENTRY: StackEntry = { label: "", libraries: [], usagePatterns: [] };

const inputCls = "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";

export default function TechStacksPage() {
	const [editing, setEditing] = useState<TechStack | null>(null);
	const [creating, setCreating] = useState(false);
	const [form, setForm] = useState<Form>(EMPTY_FORM);

	const { data: stacks = [], loading } = useQuery<TechStack[]>("tech-stacks", getTechStacks);

	function openCreate() {
		setForm(EMPTY_FORM);
		setCreating(true);
		setEditing(null);
	}

	function openEdit(s: TechStack) {
		setForm({ language: s.language, name: s.name, description: s.description, stack: s.stack });
		setEditing(s);
		setCreating(false);
	}

	function closeDialog() {
		setCreating(false);
		setEditing(null);
	}

	async function save() {
		if (!form.name.trim() || !form.language.trim()) return;
		try {
			if (editing) {
				const updated = await updateTechStack(editing.id, form);
				mutateCache<TechStack[]>("tech-stacks", (list) => list.map((s) => (s.id === editing.id ? updated : s)));
			} else {
				const created = await createTechStack(form);
				mutateCache<TechStack[]>("tech-stacks", (list) => [created, ...list]);
			}
			closeDialog();
		} catch (err) {
			console.error("Failed to save tech stack:", err);
		}
	}

	async function remove(id: string) {
		if (!confirm("Delete this tech stack?")) return;
		try {
			await deleteTechStack(id);
			mutateCache<TechStack[]>("tech-stacks", (list) => list.filter((s) => s.id !== id));
		} catch (err) {
			console.error("Failed to delete tech stack:", err);
		}
	}

	const dialogOpen = creating || editing !== null;

	// ── Stack entry editing helpers ──────────────────────────────────────────
	function patchEntry(i: number, patch: Partial<StackEntry>) {
		setForm((f) => ({ ...f, stack: f.stack.map((e, idx) => (idx === i ? { ...e, ...patch } : e)) }));
	}
	function addEntry() {
		setForm((f) => ({ ...f, stack: [...f.stack, { ...EMPTY_ENTRY }] }));
	}
	function removeEntry(i: number) {
		setForm((f) => ({ ...f, stack: f.stack.filter((_, idx) => idx !== i) }));
	}

	return (
		<div className="min-h-screen bg-gray-50">
			<header className="bg-white border-b px-6 py-4 flex items-center justify-between">
				<div>
					<h1 className="text-xl font-bold text-gray-900">Tech Stacks</h1>
					<p className="text-sm text-gray-500 mt-0.5">Reusable language-scoped stacks of libraries and usage patterns</p>
				</div>
				<button
					type="button"
					onClick={openCreate}
					className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
				>
					<Plus className="w-4 h-4" />
					New Tech Stack
				</button>
			</header>

			<main className="max-w-5xl mx-auto px-6 py-8">
				{loading && stacks.length === 0 ? (
					<div className="text-gray-500 text-center py-16">Loading tech stacks...</div>
				) : stacks.length === 0 ? (
					<div className="text-center py-16 space-y-3">
						<p className="text-gray-400">No tech stacks yet</p>
						<button type="button" onClick={openCreate} className="text-blue-600 hover:text-blue-700 text-sm">
							Create your first tech stack
						</button>
					</div>
				) : (
					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						{stacks.map((s) => (
							<div
								key={s.id}
								className="bg-white rounded-xl border border-gray-200 p-5 flex flex-col gap-3 hover:border-gray-300 transition-colors"
							>
								<div className="flex items-start justify-between gap-3">
									<div className="min-w-0">
										<div className="flex items-center gap-2 mb-1">
											<span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">{s.language}</span>
										</div>
										<h3 className="font-semibold text-gray-900 truncate">{s.name}</h3>
										{s.description && <p className="text-sm text-gray-500 mt-0.5 line-clamp-2">{s.description}</p>}
									</div>
									<div className="flex gap-1 shrink-0">
										<button
											type="button"
											onClick={() => openEdit(s)}
											className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
											title="Edit"
										>
											<Edit2 className="w-3.5 h-3.5" />
										</button>
										<button
											type="button"
											onClick={() => remove(s.id)}
											className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
											title="Delete"
										>
											<Trash2 className="w-3.5 h-3.5" />
										</button>
									</div>
								</div>
								<div className="flex flex-col gap-2">
									{s.stack.map((entry, i) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: render-stable snapshot list
										<div key={`${entry.label}-${i}`} className="bg-gray-50 rounded-lg p-3 text-xs">
											<div className="font-semibold text-gray-700 mb-1">{entry.label}</div>
											<div className="flex flex-wrap gap-1 mb-1">
												{entry.libraries.map((lib, j) => (
													<span
														// biome-ignore lint/suspicious/noArrayIndexKey: render-stable snapshot list
														key={`${lib.name}-${j}`}
														className="px-1.5 py-0.5 rounded bg-white border border-gray-200 text-gray-600 font-mono"
													>
														{lib.name}
														{lib.version ? `@${lib.version}` : ""}
													</span>
												))}
											</div>
											{entry.usagePatterns.length > 0 && (
												<ul className="list-disc list-inside text-gray-500">
													{entry.usagePatterns.map((p, k) => (
														// biome-ignore lint/suspicious/noArrayIndexKey: render-stable snapshot list
														<li key={`${p}-${k}`}>{p}</li>
													))}
												</ul>
											)}
										</div>
									))}
								</div>
							</div>
						))}
					</div>
				)}
			</main>

			{dialogOpen && (
				<StackDialog
					editing={editing}
					form={form}
					setForm={setForm}
					patchEntry={patchEntry}
					addEntry={addEntry}
					removeEntry={removeEntry}
					save={save}
					close={closeDialog}
				/>
			)}
		</div>
	);
}

// ── Create / Edit dialog ─────────────────────────────────────────────────────

type DialogProps = {
	editing: TechStack | null;
	form: Form;
	setForm: React.Dispatch<React.SetStateAction<Form>>;
	patchEntry: (i: number, patch: Partial<StackEntry>) => void;
	addEntry: () => void;
	removeEntry: (i: number) => void;
	save: () => void;
	close: () => void;
};

function StackDialog({ editing, form, setForm, patchEntry, addEntry, removeEntry, save, close }: DialogProps) {
	return (
		<div
			className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
			onClick={(e) => e.target === e.currentTarget && close()}
			onKeyDown={(e) => e.key === "Escape" && close()}
			role="dialog"
			aria-modal="true"
		>
			<div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">
				<div className="flex items-center justify-between px-6 py-4 border-b">
					<h2 className="text-base font-semibold text-gray-900">{editing ? "Edit Tech Stack" : "New Tech Stack"}</h2>
					<button type="button" onClick={close} className="text-gray-400 hover:text-gray-600">
						<X className="w-4 h-4" />
					</button>
				</div>

				<div className="p-6 space-y-4 overflow-y-auto flex-1">
					<div className="grid grid-cols-2 gap-4">
						<div className="space-y-1.5">
							<label className="text-sm font-medium text-gray-700" htmlFor="ts-language">
								Language *
							</label>
							<input
								id="ts-language"
								// biome-ignore lint/a11y/noAutofocus: intentional focus for modal
								autoFocus
								type="text"
								value={form.language}
								onChange={(e) => setForm((f) => ({ ...f, language: e.target.value }))}
								className={inputCls}
								placeholder="e.g. TypeScript"
							/>
						</div>
						<div className="space-y-1.5">
							<label className="text-sm font-medium text-gray-700" htmlFor="ts-name">
								Name *
							</label>
							<input
								id="ts-name"
								type="text"
								value={form.name}
								onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
								className={inputCls}
								placeholder="Stack name"
							/>
						</div>
					</div>

					<div className="space-y-1.5">
						<label className="text-sm font-medium text-gray-700" htmlFor="ts-desc">
							Description
						</label>
						<input
							id="ts-desc"
							type="text"
							value={form.description}
							onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
							className={inputCls}
							placeholder="Short description"
						/>
					</div>

					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<span className="text-sm font-medium text-gray-700">Stack</span>
							<button
								type="button"
								onClick={addEntry}
								className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
							>
								<Plus className="w-3.5 h-3.5" /> Add group
							</button>
						</div>
						{form.stack.length === 0 && (
							<p className="text-xs text-gray-400">No groups yet. Add a group like "Backend" or "Frontend".</p>
						)}
						{form.stack.map((entry, i) => (
							<StackEntryEditor
								// biome-ignore lint/suspicious/noArrayIndexKey: items edited in place by index
								key={i}
								entry={entry}
								onChange={(patch) => patchEntry(i, patch)}
								onRemove={() => removeEntry(i)}
							/>
						))}
					</div>
				</div>

				<div className="flex gap-2 px-6 py-4 border-t">
					<button
						type="button"
						onClick={save}
						disabled={!form.name.trim() || !form.language.trim()}
						className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{editing ? "Save changes" : "Create"}
					</button>
					<button
						type="button"
						onClick={close}
						className="flex-1 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-200"
					>
						Cancel
					</button>
				</div>
			</div>
		</div>
	);
}

// ── Single stack-group editor ────────────────────────────────────────────────

function StackEntryEditor({
	entry,
	onChange,
	onRemove,
}: {
	entry: StackEntry;
	onChange: (patch: Partial<StackEntry>) => void;
	onRemove: () => void;
}) {
	function patchLib(i: number, patch: Partial<{ name: string; version: string }>) {
		onChange({
			libraries: entry.libraries.map((lib, idx) =>
				idx === i
					? { name: patch.name ?? lib.name, version: patch.version !== undefined ? patch.version || undefined : lib.version }
					: lib
			),
		});
	}

	return (
		<div className="border border-gray-200 rounded-lg p-3 space-y-3 bg-gray-50">
			<div className="flex items-center gap-2">
				<input
					type="text"
					value={entry.label}
					onChange={(e) => onChange({ label: e.target.value })}
					className="flex-1 px-2.5 py-1.5 border border-gray-300 rounded-md text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
					placeholder="Group label (e.g. Backend)"
				/>
				<button
					type="button"
					onClick={onRemove}
					className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md"
					title="Remove group"
				>
					<Trash2 className="w-3.5 h-3.5" />
				</button>
			</div>

			<div className="space-y-1.5">
				<div className="flex items-center justify-between">
					<span className="text-xs font-medium text-gray-600">Libraries</span>
					<button
						type="button"
						onClick={() => onChange({ libraries: [...entry.libraries, { name: "" }] })}
						className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
					>
						<Plus className="w-3 h-3" /> Add library
					</button>
				</div>
				{entry.libraries.map((lib, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: items edited in place by index
					<div key={i} className="flex items-center gap-2">
						<input
							type="text"
							value={lib.name}
							onChange={(e) => patchLib(i, { name: e.target.value })}
							className="flex-1 px-2.5 py-1.5 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
							placeholder="library name"
						/>
						<input
							type="text"
							value={lib.version ?? ""}
							onChange={(e) => patchLib(i, { version: e.target.value })}
							className="w-24 px-2.5 py-1.5 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
							placeholder="version"
						/>
						<button
							type="button"
							onClick={() => onChange({ libraries: entry.libraries.filter((_, idx) => idx !== i) })}
							className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md"
							title="Remove library"
						>
							<X className="w-3.5 h-3.5" />
						</button>
					</div>
				))}
			</div>

			<div className="space-y-1.5">
				<span className="text-xs font-medium text-gray-600">Usage patterns (one per line)</span>
				<textarea
					value={entry.usagePatterns.join("\n")}
					onChange={(e) =>
						onChange({
							usagePatterns: e.target.value
								.split("\n")
								.map((p) => p.trim())
								.filter(Boolean),
						})
					}
					rows={3}
					className="w-full px-2.5 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white resize-none"
					placeholder={"serverless\nuse hono/client for the API client"}
				/>
			</div>
		</div>
	);
}
