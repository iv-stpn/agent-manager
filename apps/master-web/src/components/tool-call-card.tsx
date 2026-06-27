"use client";

import { JsonView } from "@/components/json-view";
import { ToolIconBox } from "@/components/tool-icons";
import type { ToolCall } from "@/lib/agent-api";
import { formatRelativeTime } from "@/lib/utils";
import { CheckCircle2, ChevronDown, ChevronRight, Clock, XCircle } from "lucide-react";
import { useState } from "react";

// Output may be a JSON string or plain text. Parse it so a `content` key gets
// the inline-markdown treatment; fall back to rendering the raw string.
function OutputView({ output }: { output: string }) {
	try {
		const parsed = JSON.parse(output);
		if (parsed && typeof parsed === "object") {
			return <JsonView value={parsed} />;
		}
	} catch {
		// not JSON — render as-is below
	}
	return <pre className="whitespace-pre-wrap break-all text-[11px] max-h-48 overflow-y-auto">{output}</pre>;
}

export function ToolCallCard({ tc }: { tc: ToolCall }) {
	const [open, setOpen] = useState(false);
	const input = JSON.parse(tc.input || "{}");
	const statusIcon =
		tc.status === "success" ? (
			<CheckCircle2 className="h-3 w-3 text-green-500" />
		) : tc.status === "error" ? (
			<XCircle className="h-3 w-3 text-red-500" />
		) : (
			<Clock className="h-3 w-3 text-yellow-500 animate-pulse" />
		);

	return (
		<div className="rounded-md border text-xs font-mono overflow-hidden">
			<button
				type="button"
				onClick={() => setOpen((x) => !x)}
				className="flex items-center gap-2 w-full px-3 py-2 bg-muted/50 hover:bg-muted text-left"
			>
				{open ? (
					<ChevronDown className="h-3 w-3 text-muted-foreground" />
				) : (
					<ChevronRight className="h-3 w-3 text-muted-foreground" />
				)}
				{statusIcon}
				<ToolIconBox name={tc.toolName} className="h-5 w-5" />
				<span className="font-semibold text-foreground">{tc.toolName}</span>
				{input.command && <span className="truncate text-muted-foreground">{String(input.command).slice(0, 50)}</span>}
				{input.path && !input.command && <span className="truncate text-muted-foreground">{String(input.path)}</span>}
				<span className="ml-auto text-muted-foreground">{formatRelativeTime(tc.createdAt)}</span>
			</button>
			{open && (
				<div className="border-t">
					<div className="p-3 bg-muted/20">
						<p className="text-muted-foreground mb-1 font-sans font-medium text-[10px] uppercase tracking-wide">Input</p>
						<JsonView value={input} />
					</div>
					{tc.output && (
						<div className="p-3 border-t">
							<p className="text-muted-foreground mb-1 font-sans font-medium text-[10px] uppercase tracking-wide">Output</p>
							<OutputView output={tc.output} />
						</div>
					)}
				</div>
			)}
		</div>
	);
}
