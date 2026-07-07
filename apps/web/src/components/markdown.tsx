import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// Lightweight, dependency-free markdown renderer for agent output. Handles the
// subset that shows up in agent messages and reports: fenced code blocks,
// headings, blockquotes, ordered/unordered lists, horizontal rules, and inline
// bold/italic/code/links. It renders straight to React elements — no HTML is
// injected, so untrusted model output can't break out of the DOM.

interface MarkdownProps {
	children: string;
	className?: string;
}

type Block =
	| { type: "code"; lang?: string; content: string }
	| { type: "heading"; level: number; text: string }
	| { type: "quote"; text: string }
	| { type: "ul"; items: string[] }
	| { type: "ol"; items: string[] }
	| { type: "hr" }
	| {
			type: "table";
			headers: string[];
			alignments: ("left" | "center" | "right" | null)[];
			rows: string[][];
	  }
	| { type: "p"; text: string };

const FENCE = /^```(\w*)\s*$/;
const HR = /^(\*\*\*|---|___)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^>\s?/;
const UL = /^\s*[-*+]\s+/;
const OL = /^\s*\d+\.\s+/;
const TABLE_ROW = /^\|(.+)\|$/;
const TABLE_SEP = /^\|[\s:|-]+\|$/;

function isBlockStart(line: string): boolean {
	return (
		FENCE.test(line) ||
		HEADING.test(line) ||
		QUOTE.test(line) ||
		UL.test(line) ||
		OL.test(line) ||
		HR.test(line) ||
		TABLE_ROW.test(line)
	);
}

function parseTableCells(line: string): string[] {
	return line
		.replace(/^\||\|$/g, "")
		.split("|")
		.map((cell) => cell.trim());
}

function parseAlignment(cell: string): "left" | "center" | "right" | null {
	const left = cell.startsWith(":");
	const right = cell.endsWith(":");
	if (left && right) return "center";
	if (right) return "right";
	if (left) return "left";
	return null;
}

function parseBlocks(src: string): Block[] {
	const lines = (typeof src === "string" ? src : String(src ?? "")).replace(/\r\n/g, "\n").split("\n");
	const blocks: Block[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];

		const fence = line.match(FENCE);
		if (fence) {
			const code: string[] = [];
			i++;
			while (i < lines.length && !/^```\s*$/.test(lines[i])) {
				code.push(lines[i]);
				i++;
			}
			i++; // consume closing fence (if present)
			blocks.push({ type: "code", lang: fence[1] || undefined, content: code.join("\n") });
			continue;
		}

		if (line.trim() === "") {
			i++;
			continue;
		}
		if (HR.test(line)) {
			blocks.push({ type: "hr" });
			i++;
			continue;
		}
		const height = line.match(HEADING);
		if (height) {
			blocks.push({ type: "heading", level: height[1].length, text: height[2].trim() });
			i++;
			continue;
		}
		if (QUOTE.test(line)) {
			const quote: string[] = [];
			while (i < lines.length && QUOTE.test(lines[i])) {
				quote.push(lines[i].replace(QUOTE, ""));
				i++;
			}
			blocks.push({ type: "quote", text: quote.join("\n") });
			continue;
		}
		if (UL.test(line)) {
			const items: string[] = [];
			while (i < lines.length && UL.test(lines[i])) {
				items.push(lines[i].replace(UL, ""));
				i++;
			}
			blocks.push({ type: "ul", items });
			continue;
		}
		if (OL.test(line)) {
			const items: string[] = [];
			while (i < lines.length && OL.test(lines[i])) {
				items.push(lines[i].replace(OL, ""));
				i++;
			}
			blocks.push({ type: "ol", items });
			continue;
		}

		// Table: header row | separator row | data rows
		if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
			const headers = parseTableCells(line);
			const alignments = parseTableCells(lines[i + 1]).map(parseAlignment);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && TABLE_ROW.test(lines[i])) {
				rows.push(parseTableCells(lines[i]));
				i++;
			}
			blocks.push({ type: "table", headers, alignments, rows });
			continue;
		}

		// Paragraph: gather consecutive non-blank, non-block-start lines.
		const para: string[] = [];
		while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
			para.push(lines[i]);
			i++;
		}
		blocks.push({ type: "p", text: para.join("\n") });
	}
	return blocks;
}

// Matches the next inline token: **bold**, *italic*, `code`, or [text](url).
const INLINE = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/;

// Only allow links whose protocol is safe to make clickable. Agent messages,
// tool results and reports flow through this renderer and can contain arbitrary
// (untrusted) text, so a `javascript:`/`data:`/`vbscript:` href must never
// become a live link. Relative and anchor links are allowed; everything with a
// disallowed scheme is rejected (the caller renders the link text as plain text).
const SAFE_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
function safeUrl(raw: string): string | null {
	const trimmed = raw.trim();
	// Relative / same-page links have no scheme — allow them.
	if (trimmed.startsWith("/") || trimmed.startsWith("#") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
		return trimmed;
	}
	try {
		const url = new URL(trimmed, window.location.origin);
		return SAFE_URL_PROTOCOLS.has(url.protocol) ? trimmed : null;
	} catch {
		return null;
	}
}

function renderInline(text: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	let remaining = text;
	let key = 0;
	while (remaining.length > 0) {
		const m = remaining.match(INLINE);
		if (!m || m.index === undefined) {
			nodes.push(<Fragment key={key++}>{remaining}</Fragment>);
			break;
		}
		if (m.index > 0) {
			nodes.push(<Fragment key={key++}>{remaining.slice(0, m.index)}</Fragment>);
		}
		const [full, , bold, italic, code, linkText, linkUrl] = m;
		if (bold) {
			nodes.push(
				<strong key={key++} className="font-semibold">
					{bold}
				</strong>
			);
		} else if (italic) {
			nodes.push(<em key={key++}>{italic}</em>);
		} else if (code) {
			nodes.push(
				<code key={key++} className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-[0.85em]">
					{code}
				</code>
			);
		} else if (linkText && linkUrl) {
			const href = safeUrl(linkUrl);
			if (href) {
				nodes.push(
					<a
						key={key++}
						href={href}
						target="_blank"
						rel="noreferrer"
						className="text-blue-600 hover:underline dark:text-blue-400"
					>
						{linkText}
					</a>
				);
			} else {
				// Disallowed protocol (e.g. javascript:) — show the link text, not a live link.
				nodes.push(<Fragment key={key++}>{linkText}</Fragment>);
			}
		}
		remaining = remaining.slice(m.index + full.length);
	}
	return nodes;
}

function renderTextWithBreaks(text: string): ReactNode {
	const lines = text.split("\n");
	return lines.map((line, idx) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: static line list, never reordered
		<Fragment key={idx}>
			{renderInline(line)}
			{idx < lines.length - 1 && <br />}
		</Fragment>
	));
}

function renderBlock(block: Block, idx: number): ReactNode {
	switch (block.type) {
		case "code":
			return (
				<pre key={idx} className="my-1 overflow-x-auto rounded-md bg-gray-900 p-3 text-[11px] leading-relaxed text-gray-100">
					<code>{block.content}</code>
				</pre>
			);
		case "heading": {
			const sizes = ["text-base", "text-base", "text-sm", "text-sm", "text-xs", "text-xs"];
			return (
				<div key={idx} className={cn("font-semibold", sizes[block.level - 1])}>
					{renderInline(block.text)}
				</div>
			);
		}
		case "quote":
			return (
				<blockquote key={idx} className="border-l-2 border-border pl-3 text-muted-foreground">
					{block.text.split("\n").map((line, lineIndex) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static list
						<p key={lineIndex}>{renderInline(line)}</p>
					))}
				</blockquote>
			);
		case "ul":
			return (
				<ul key={idx} className="list-disc space-y-0.5 pl-5">
					{block.items.map((item, itemIndex) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static list
						<li key={itemIndex}>{renderInline(item)}</li>
					))}
				</ul>
			);
		case "ol":
			return (
				<ol key={idx} className="list-decimal space-y-0.5 pl-5">
					{block.items.map((item, itemIndex) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static list
						<li key={itemIndex}>{renderInline(item)}</li>
					))}
				</ol>
			);
		case "hr":
			return <hr key={idx} className="my-2 border-border" />;
		case "table": {
			const align = (idx: number) => block.alignments[idx] ?? undefined;
			return (
				<div key={idx} className="overflow-x-auto">
					<table className="min-w-full border-collapse text-xs">
						<thead>
							<tr className="border-b border-border">
								{block.headers.map((header, headerIndex) => (
									<th
										// biome-ignore lint/suspicious/noArrayIndexKey: static list
										key={headerIndex}
										className="px-2 py-1 font-semibold text-left"
										style={{ textAlign: align(headerIndex) }}
									>
										{renderInline(header)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{block.rows.map((row, rowIndex) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: static list
								<tr key={rowIndex} className="border-b border-border/50">
									{row.map((cell, cellIndex) => (
										<td
											// biome-ignore lint/suspicious/noArrayIndexKey: static list
											key={cellIndex}
											className="px-2 py-1"
											style={{ textAlign: align(cellIndex) }}
										>
											{renderInline(cell)}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		}
		case "p":
			return <p key={idx}>{renderTextWithBreaks(block.text)}</p>;
	}
}

export function Markdown({ children, className }: MarkdownProps) {
	const blocks = parseBlocks(children ?? "");
	return <div className={cn("space-y-2", className)}>{blocks.map(renderBlock)}</div>;
}
