import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { getLogs } from "@/lib/agent-api";
import { mutateCache, useQuery } from "@/lib/query-cache";
import type { Project } from "@/lib/types";

interface LogsTabProps {
	projectId: string;
	running: boolean;
}

export function LogsTab({ projectId, running }: LogsTabProps) {
	const [service, setService] = useState<"agent" | "web">("agent");

	const {
		data: logs = "",
		loading,
		error,
		refetch: fetchLogs,
	} = useQuery(`logs:${projectId}:${service}`, async () => {
		try {
			const text = await getLogs(projectId, service);
			mutateCache<Project>(`project:${projectId}`, (p) => ({
				...p,
				logLines: text.trim() ? text.trim().split("\n").length : 0,
			}));
			return text;
		} catch (err) {
			console.error("Failed to fetch logs:", err);
			throw new Error("Failed to load logs. Is the project running?");
		}
	});

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div className="flex gap-2">
					{(["agent"] as const).map((svc) => (
						<button
							key={svc}
							type="button"
							onClick={() => setService(svc)}
							className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
								service === svc ? "bg-blue-600 text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-50"
							}`}
						>
							{svc}
						</button>
					))}
				</div>
				<button
					type="button"
					onClick={fetchLogs}
					className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-50 text-gray-600 rounded-lg hover:bg-gray-100 text-sm"
				>
					<RefreshCw className="w-4 h-4" />
					Refresh
				</button>
			</div>

			{!running && (
				<div className="text-sm text-gray-500 bg-gray-100 rounded-lg p-3">
					Project is not running — logs may be empty or stale.
				</div>
			)}

			{loading ? (
				<div className="text-gray-500">Loading logs...</div>
			) : error ? (
				<div className="text-red-600">{error.message}</div>
			) : (
				<pre className="bg-gray-900 text-gray-100 rounded-lg p-4 text-xs font-mono overflow-auto max-h-[60vh] whitespace-pre-wrap">
					{logs || "(no logs)"}
				</pre>
			)}
		</div>
	);
}
