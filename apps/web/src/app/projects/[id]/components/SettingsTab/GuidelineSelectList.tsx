import { groupBy } from "@agent-manager/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { Guideline, GuidelineCategory } from "@/lib/agent-api";

interface GuidelineSelectListProps {
	guidelines: Guideline[];
	categories: GuidelineCategory[];
	selectedIds: string[];
	onToggle: (id: string) => void;
	onEdit: (id: string) => void;
}

export function GuidelineSelectList({ guidelines, categories, selectedIds, onToggle, onEdit }: GuidelineSelectListProps) {
	if (guidelines.length === 0) {
		return (
			<div className="space-y-2">
				<div className="text-sm font-medium">Guidelines</div>
				<p className="text-xs italic text-muted-foreground">No guidelines in the library yet.</p>
			</div>
		);
	}

	// Group guidelines by category; null → "Uncategorized"
	const grouped = groupBy(guidelines, (guideline) => guideline.categoryId ?? null);

	// Order: categories in their natural order, then uncategorized last
	const orderedKeys: Array<string | null> = [
		...categories.map((category) => category.id).filter((id) => grouped.has(id)),
		...(grouped.has(null) ? [null] : []),
	];

	function GuidelineItem({ g }: { g: Guideline }) {
		const selected = selectedIds.includes(g.id);
		return (
			<li className="flex items-center justify-between gap-3 px-3 py-2">
				<div className="flex min-w-0 items-center gap-3">
					<Checkbox id={`checkbox-${g.id}`} checked={selected} onCheckedChange={() => onToggle(g.id)} />
					<label htmlFor={`checkbox-${g.id}`} className="min-w-0 cursor-pointer">
						<span className="block text-sm">{g.name}</span>
						{g.description && <span className="block truncate text-xs text-muted-foreground">{g.description}</span>}
					</label>
				</div>
				<Button type="button" variant="outline" size="sm" onClick={() => onEdit(g.id)}>
					Edit
				</Button>
			</li>
		);
	}

	return (
		<div className="space-y-2">
			<div className="text-sm font-medium">Guidelines</div>
			<div className="space-y-3">
				{orderedKeys.map((categoryId) => {
					const category = categoryId ? categories.find((category) => category.id === categoryId) : null;
					const items = grouped.get(categoryId) ?? [];

					return (
						<div key={categoryId ?? "__uncategorized"}>
							<div className="flex items-center gap-2 mb-1">
								{category ? (
									<>
										<span className="w-2 h-2 rounded-full" style={{ backgroundColor: category.color }} />
										<span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{category.name}</span>
									</>
								) : (
									<span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Uncategorized</span>
								)}
							</div>
							<ul className="divide-y rounded-md border">
								{items.map((guideline) => (
									<GuidelineItem key={guideline.id} g={guideline} />
								))}
							</ul>
						</div>
					);
				})}
			</div>
		</div>
	);
}
