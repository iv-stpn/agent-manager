import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

interface ContextSelectListProps {
	title: string;
	empty: string;
	items: { id: string; label: string; sub?: string }[];
	selectedIds: string[];
	onToggle: (id: string) => void;
	onEdit: (id: string) => void;
}

export function ContextSelectList({ title, empty, items, selectedIds, onToggle, onEdit }: ContextSelectListProps) {
	return (
		<div className="space-y-2">
			<div className="text-sm font-medium">{title}</div>
			{items.length === 0 ? (
				<p className="text-xs italic text-muted-foreground">{empty}</p>
			) : (
				<ul className="divide-y rounded-md border">
					{items.map((item) => {
						const selected = selectedIds.includes(item.id);
						return (
							<li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2">
								<div className="flex min-w-0 items-center gap-3">
									<Checkbox id={`checkbox-${item.id}`} checked={selected} onCheckedChange={() => onToggle(item.id)} />
									<label htmlFor={`checkbox-${item.id}`} className="min-w-0 cursor-pointer">
										<span className="block text-sm">{item.label}</span>
										{item.sub && <span className="block truncate text-xs text-muted-foreground">{item.sub}</span>}
									</label>
								</div>
								<Button type="button" variant="outline" size="sm" onClick={() => onEdit(item.id)}>
									Edit
								</Button>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
