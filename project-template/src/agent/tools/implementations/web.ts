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
