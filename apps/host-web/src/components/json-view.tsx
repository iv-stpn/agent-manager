"use client";

import { Fragment, type ReactNode } from "react";
import { Markdown } from "@/components/markdown";
import { cn } from "@/lib/utils";

// Pulls renderable markdown text out of a `content` value. It may be a plain
// string, an array of content blocks (`{ type: "text", text }`), or a single
// such block. Returns null when there's nothing markdown-able to show.
function markdownFromContent(v: unknown): string | null {
	if (typeof v === "string") return v.length > 0 ? v : null;
	if (Array.isArray(v)) {
		const parts = v.map(markdownFromContent).filter((p): p is string => p != null);
		return parts.length > 0 ? parts.join("\n\n") : null;
	}
	if (v && typeof v === "object") {
		const text = (v as { text?: unknown }).text;
		if (typeof text === "string" && text.length > 0) return text;
	}
	return null;
}

const indent = (depth: number) => "  ".repeat(depth);

// Renders one JSON value recursively, mirroring `JSON.stringify(v, null, 2)`,
// but wherever a `content` key holds markdown text it drops in a rendered
// markdown box at that position instead of an escaped one-line string — so
// prose stays readable inside the raw payload.
function ValueNode({ value, depth }: { value: unknown; depth: number }): ReactNode {
	if (value === null) return <span className="text-foreground/40">null</span>;

	const t = typeof value;
	if (t === "string") return <span className="text-foreground/70">{JSON.stringify(value)}</span>;
	if (t === "number" || t === "boolean") return <span className="text-foreground/70">{String(value)}</span>;

	if (Array.isArray(value)) {
		if (value.length === 0) return <>[]</>;
		return (
			<>
				{"[\n"}
				{value.map((item, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: positional JSON rendering
					<Fragment key={i}>
						{indent(depth + 1)}
						<ValueNode value={item} depth={depth + 1} />
						{i < value.length - 1 ? ",\n" : "\n"}
					</Fragment>
				))}
				{indent(depth)}
				{"]"}
			</>
		);
	}

	if (value && t === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) return <>{"{}"}</>;
		return (
			<>
				{"{\n"}
				{entries.map(([k, v], i) => {
					const md = k === "content" ? markdownFromContent(v) : null;
					const last = i === entries.length - 1;
					return (
						<Fragment key={k}>
							{indent(depth + 1)}
							<span className="text-foreground">{JSON.stringify(k)}</span>
							{": "}
							{md != null ? (
								// Block element interrupts the pre flow, so it sits on its own
								// line; the next entry naturally starts below it.
								<div
									className="my-1 break-normal whitespace-normal rounded-md border bg-background p-2 font-sans"
									style={{ marginLeft: `${(depth + 1) * 2}ch` }}
								>
									<Markdown>{md}</Markdown>
								</div>
							) : (
								<>
									<ValueNode value={v} depth={depth + 1} />
									{last ? "\n" : ",\n"}
								</>
							)}
						</Fragment>
					);
				})}
				{indent(depth)}
				{"}"}
			</>
		);
	}

	return <span>{String(value)}</span>;
}

// Renders a JSON payload as an indented, pre-wrapped tree with `content` values
// shown as inline markdown. Pass the already-parsed value.
export function JsonView({ value, className }: { value: unknown; className?: string }) {
	return (
		<div className={cn("whitespace-pre-wrap break-all font-mono text-[11px] text-foreground/80", className)}>
			<ValueNode value={value} depth={0} />
		</div>
	);
}
