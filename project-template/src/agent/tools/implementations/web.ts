// Web tools — fetch a page and reduce it to readable text, and run a web search.
// Both rely on the global fetch available in the Node/Bun runtime; no API key required.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

/**
 * Reject IPs that address the host, its network, or cloud metadata. The agent
 * would otherwise be able to fetch the (unauthenticated) orchestrator at
 * `host.docker.internal`, the `169.254.169.254` metadata endpoint, or any other
 * service on the internal network — a classic SSRF pivot. Checked against every
 * resolved address, and re-checked on each redirect hop.
 */
function isBlockedIp(ip: string): boolean {
	const v = isIP(ip);
	if (v === 4) {
		const [a, b] = ip.split(".").map(Number);
		if (a === 10 || a === 127 || a === 0) return true; // private / loopback / this-host
		if (a === 172 && b >= 16 && b <= 31) return true; // private
		if (a === 192 && b === 168) return true; // private
		if (a === 169 && b === 254) return true; // link-local + metadata
		if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
		if (a >= 224) return true; // multicast / reserved
		return false;
	}
	if (v === 6) {
		const lower = ip.toLowerCase();
		if (lower === "::1" || lower === "::") return true; // loopback / unspecified
		if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
		if (lower.startsWith("fe80")) return true; // link-local
		// IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4.
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
		if (mapped) return isBlockedIp(mapped[1]);
		return false;
	}
	return false;
}

/** Throw if a URL's host resolves to a blocked (internal) address. */
async function assertPublicUrl(url: string): Promise<void> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`invalid URL: ${url}`);
	}
	const host = parsed.hostname;
	// Literal IP → check directly. Hostname → resolve every address it maps to.
	if (isIP(host)) {
		if (isBlockedIp(host)) throw new Error(`blocked address: ${host}`);
		return;
	}
	if (host === "localhost" || host.endsWith(".localhost") || host === "host.docker.internal") {
		throw new Error(`blocked host: ${host}`);
	}
	let addrs: { address: string }[];
	try {
		addrs = await lookup(host, { all: true });
	} catch (err) {
		throw new Error(`cannot resolve ${host}: ${err instanceof Error ? err.message : String(err)}`);
	}
	for (const { address } of addrs) {
		if (isBlockedIp(address)) throw new Error(`${host} resolves to a blocked address (${address})`);
	}
}

/**
 * Fetch with a timeout and SSRF protection. Redirects are followed manually so
 * each hop's target is re-validated — otherwise a public URL could 302 to an
 * internal one and bypass the guard.
 */
async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		let current = url;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			await assertPublicUrl(current);
			const response = await fetch(current, {
				...init,
				redirect: "manual",
				signal: controller.signal,
				headers: { "user-agent": USER_AGENT, ...(init?.headers ?? {}) },
			});
			if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
				current = new URL(response.headers.get("location") as string, current).toString();
				continue;
			}
			return response;
		}
		throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
	} finally {
		clearTimeout(timer);
	}
}

function decodeEntities(s: string): string {
	return s
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

// Strip HTML to plain text: drop script/style, convert blocks to newlines, collapse whitespace.
function htmlToText(html: string): string {
	const text = html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
		.replace(/<\/(p|div|section|article|h[1-6]|li|tr|br|table)>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, " ");

	return decodeEntities(text)
		.replace(/[ \t\f\v]+/g, " ")
		.replace(/\n\s*\n\s*\n+/g, "\n\n")
		.split("\n")
		.map((line) => line.trim())
		.join("\n")
		.trim();
}

/** Fetch a URL and return its readable text content, truncated to a budget. */
export async function webFetch(url: string, maxChars = 20_000): Promise<string> {
	if (!/^https?:\/\//i.test(url)) return `Error: url must start with http:// or https:// (got "${url}")`;
	let response: Response;
	try {
		response = await fetchWithTimeout(url);
	} catch (err) {
		return `Error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`;
	}
	if (!response.ok) return `Error fetching ${url}: HTTP ${response.status} ${response.statusText}`;

	const contentType = response.headers.get("content-type") ?? "";
	// Guard against buffering a huge/binary response into memory: skip obvious
	// non-text content and reject anything whose declared size dwarfs the budget.
	if (contentType && !/text\/|application\/(json|xml|xhtml|javascript)|\+xml/i.test(contentType)) {
		return `URL: ${url}\nContent-Type: ${contentType}\n\n[Skipped: non-text content type]`;
	}
	const declaredLength = Number(response.headers.get("content-length") ?? "0");
	if (declaredLength > maxChars * 8) {
		return `URL: ${url}\nContent-Type: ${contentType || "unknown"}\n\n[Skipped: response too large (${declaredLength} bytes)]`;
	}
	const body = await response.text();
	const content = /text\/html|application\/xhtml/i.test(contentType) ? htmlToText(body) : body.trim();
	const truncated =
		content.length > maxChars ? `${content.slice(0, maxChars)}\n\n…[truncated ${content.length - maxChars} chars]` : content;
	return `URL: ${url}\nContent-Type: ${contentType || "unknown"}\n\n${truncated}`;
}

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

// Parse DuckDuckGo's HTML endpoint results (no API key, no JS required).
function parseDuckDuckGo(html: string, limit: number): SearchResult[] {
	const results: SearchResult[] = [];
	const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
	const snippets: string[] = [];
	let snippetMatches: RegExpExecArray | null = snippetRegex.exec(html);
	while (snippetMatches !== null) {
		snippets.push(htmlToText(snippetMatches[1]));
		snippetMatches = snippetRegex.exec(html);
	}
	let linkMatches: RegExpExecArray | null = linkRegex.exec(html);
	let idx = 0;
	while (linkMatches !== null && results.length < limit) {
		let url = linkMatches[1];
		// DuckDuckGo wraps targets in a redirect (uddg= param) — unwrap it.
		const redirect = /[?&]uddg=([^&]+)/.exec(url);
		if (redirect) url = decodeURIComponent(redirect[1]);
		results.push({ title: htmlToText(linkMatches[2]), url, snippet: snippets[idx] ?? "" });
		idx++;
		linkMatches = linkRegex.exec(html);
	}
	return results;
}

/** Run a web search and return a formatted list of results. */
export async function webSearch(query: string, limit = 8): Promise<string> {
	if (!query.trim()) return "Error: query is required.";
	let response: Response;
	try {
		response = await fetchWithTimeout("https://html.duckduckgo.com/html/", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ q: query }).toString(),
		});
	} catch (err) {
		return `Error searching for "${query}": ${err instanceof Error ? err.message : String(err)}`;
	}
	if (!response.ok) return `Search failed: HTTP ${response.status} ${response.statusText}`;

	const results = parseDuckDuckGo(await response.text(), limit);
	if (results.length === 0) return `No results found for "${query}".`;
	return results.map((r, idx) => `${idx + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n\n");
}
