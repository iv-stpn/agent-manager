import { cn } from "@/lib/utils";

export interface ViewToggleOption<T extends string> {
	value: T;
	label: string;
	count?: number;
}

interface ViewToggleProps<T extends string> {
	value: T;
	options: ViewToggleOption<T>[];
	onChange: (value: T) => void;
}

/**
 * A small segmented control used to switch a list between its "Active" and
 * "Archived" views. Purely presentational — the parent owns the selected value
 * and does the filtering.
 */
export function ViewToggle<T extends string>({ value, options, onChange }: ViewToggleProps<T>) {
	return (
		<div className="inline-flex items-center rounded-lg border bg-muted p-0.5">
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					onClick={() => onChange(option.value)}
					className={cn(
						"inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium transition",
						value === option.value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
					)}
				>
					{option.label}
					{option.count != null && (
						<span
							className={cn(
								"inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full text-[10px] font-semibold",
								value === option.value ? "bg-gray-200 text-gray-600" : "bg-gray-200/60 text-gray-500"
							)}
						>
							{option.count}
						</span>
					)}
				</button>
			))}
		</div>
	);
}
