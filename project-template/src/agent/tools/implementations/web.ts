// Web tools — fetch a page and reduce it to readable text, and run a web search.
// Both rely on the global fetch available in the Node/Bun runtime; no API key required.

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const FETCH_TIMEOUT_MS = 20_000;

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		return await fetch(url, {
			...init,
			signal: controller.signal,
			headers: { "user-agent": USER_AGENT, ...(init?.headers ?? {}) },
		});
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
		.map((l) => l.trim())
		.join("\n")
		.trim();
}

/** Fetch a URL and return its readable text content, truncated to a budget. */
export async function webFetch(url: string, maxChars = 20_000): Promise<string> {
	if (!/^https?:\/\//i.test(url)) return `Error: url must start with http:// or https:// (got "${url}")`;
	let resp: Response;
	try {
		resp = await fetchWithTimeout(url);
	} catch (e) {
		return `Error fetching ${url}: ${e instanceof Error ? e.message : String(e)}`;
	}
	if (!resp.ok) return `Error fetching ${url}: HTTP ${resp.status} ${resp.statusText}`;

	const contentType = resp.headers.get("content-type") ?? "";
	const body = await resp.text();
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
	const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
	const snippets: string[] = [];
	let sm: RegExpExecArray | null;
	while ((sm = snippetRe.exec(html)) !== null) snippets.push(htmlToText(sm[1]));
	let lm: RegExpExecArray | null;
	let i = 0;
	while ((lm = linkRe.exec(html)) !== null && results.length < limit) {
		let url = lm[1];
		// DuckDuckGo wraps targets in a redirect (uddg= param) — unwrap it.
		const m = /[?&]uddg=([^&]+)/.exec(url);
		if (m) url = decodeURIComponent(m[1]);
		results.push({ title: htmlToText(lm[2]), url, snippet: snippets[i] ?? "" });
		i++;
	}
	return results;
}

/** Run a web search and return a formatted list of results. */
export async function webSearch(query: string, limit = 8): Promise<string> {
	if (!query.trim()) return "Error: query is required.";
	let resp: Response;
	try {
		resp = await fetchWithTimeout("https://html.duckduckgo.com/html/", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ q: query }).toString(),
		});
	} catch (e) {
		return `Error searching for "${query}": ${e instanceof Error ? e.message : String(e)}`;
	}
	if (!resp.ok) return `Search failed: HTTP ${resp.status} ${resp.statusText}`;

	const results = parseDuckDuckGo(await resp.text(), limit);
	if (results.length === 0) return `No results found for "${query}".`;
	return results.map((r, idx) => `${idx + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n\n");
}
