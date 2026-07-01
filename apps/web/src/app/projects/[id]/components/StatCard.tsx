import type { LucideIcon } from "lucide-react";

interface StatCardProps {
	icon: LucideIcon;
	label: string;
	value: string;
}

export function StatCard({ icon: Icon, label, value }: StatCardProps) {
	return (
		<div className="bg-white rounded-lg border border-gray-200 p-4 flex items-center gap-3">
			<Icon className="w-5 h-5 text-gray-400" />
			<div>
				<div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
				<div className="text-lg font-semibold text-gray-900">{value}</div>
			</div>
		</div>
	);
}
