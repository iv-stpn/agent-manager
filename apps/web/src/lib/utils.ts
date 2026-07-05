import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export function formatTokens(number: number | null | undefined): string {
	const n = number ?? 0;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

export function formatRelativeTime(ts: number): string {
	const diff = Date.now() - ts;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return new Date(ts).toLocaleDateString();
}

export function formatDateTime(ts: number): string {
	return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function statusColor(status: string): string {
	switch (status) {
		case "running":
			return "text-green-500";
		case "compacting":
			return "text-purple-500";
		case "paused":
			return "text-yellow-500";
		case "completed":
			return "text-blue-500";
		case "stopped":
		case "aborted":
			return "text-gray-500";
		case "error":
			return "text-red-500";
		default:
			return "text-gray-400";
	}
}

export function statusBg(status: string): string {
	switch (status) {
		case "running":
			return "bg-green-500/10 text-green-700 dark:text-green-400";
		case "compacting":
			return "bg-purple-500/10 text-purple-700 dark:text-purple-400";
		case "paused":
			return "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400";
		case "completed":
			return "bg-blue-500/10 text-blue-700 dark:text-blue-400";
		case "stopped":
		case "aborted":
			return "bg-gray-500/10 text-gray-600 dark:text-gray-400";
		case "error":
			return "bg-red-500/10 text-red-700 dark:text-red-400";
		default:
			return "bg-gray-500/10 text-gray-500";
	}
}

export const containerClassName = "max-w-7xl mx-auto px-4 sm:px-6 lg:px-8";
