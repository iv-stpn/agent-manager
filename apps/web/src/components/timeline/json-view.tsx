import { Fragment, type ReactNode } from "react";
import { Markdown } from "@/components/markdown";
import { cn } from "@/lib/utils";

// Pulls renderable markdown text out of a `content` value. It may be a plain
// string, an array of content blocks (`{ type: "text", text }`), or a single
// such block. Returns null when there's nothing markdown-able to show.
function markdownFromContent(value: unknown): string | null {
	if (typeof value === "string") return value.length > 0 ? value : null;
	if (Array.isArray(value)) {
		const parts = value.map(markdownFromContent).filter((part): part is string => part != null);
		return parts.length > 0 ? parts.join("\n\n") : null;
	}
	if (value && typeof value === "object") {
		const text = (value as { text?: unknown }).text;
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

	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value);
		if (entries.length === 0) return <>{"{}"}</>;
		return (
			<>
				{"{\n"}
				{entries.map(([key, value], i) => {
					const md = key === "content" ? markdownFromContent(value) : null;
					const last = i === entries.length - 1;
					return (
						<Fragment key={key}>
							{indent(depth + 1)}
							<span className="text-foreground">{JSON.stringify(key)}</span>
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
									<ValueNode value={value} depth={depth + 1} />
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
