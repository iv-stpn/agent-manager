import { Button } from "@/components/ui/button";

export interface SettingField {
	key: string;
	label: string;
	value: string;
	display?: string;
	placeholder?: string;
	description?: string;
	type?: string;
	buildPayload: (value: string) => Record<string, unknown>;
}

interface SettingRowProps {
	field: SettingField;
	onEdit: () => void;
}

export function SettingRow({ field, onEdit }: SettingRowProps) {
	const shown = field.display ?? field.value;
	return (
		<div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
			<div className="min-w-0 space-y-1">
				<div className="text-sm font-medium">{field.label}</div>
				<div className="truncate text-sm text-muted-foreground">{shown || <span className="italic">Not set</span>}</div>
				{field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
			</div>
			<Button type="button" variant="outline" size="sm" onClick={onEdit}>
				Edit
			</Button>
		</div>
	);
}
