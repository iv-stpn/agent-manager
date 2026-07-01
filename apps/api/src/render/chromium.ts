import puppeteer from "puppeteer-core";
import { env } from "../env";

/**
 * Centralised browser-rendering for the whole platform. orchestrator API connects to a
 * shared Chromium container (browserless) via CDP WebSocket — no local browser
 * installation required.
 */

const CHROMIUM_WS_URL = env.CHROMIUM_WS_URL;

/** Check if the remote Chromium is reachable. */
export async function checkChromium(): Promise<boolean> {
	try {
		const httpUrl = CHROMIUM_WS_URL.replace(/^ws/, "http");
		const res = await fetch(`${httpUrl}/json/version`, { signal: AbortSignal.timeout(3000) });
		return res.ok;
	} catch {
		return false;
	}
}

/** Get the WebSocket endpoint from browserless. */
async function getBrowserWSEndpoint(): Promise<string> {
	const httpUrl = CHROMIUM_WS_URL.replace(/^ws/, "http");
	const res = await fetch(`${httpUrl}/json/version`);
	if (!res.ok) throw new Error(`Chromium not reachable at ${CHROMIUM_WS_URL}`);
	const data = (await res.json()) as { webSocketDebuggerUrl?: string };
	return data.webSocketDebuggerUrl ?? `${CHROMIUM_WS_URL}`;
}

async function withPage<T>(fn: (page: import("puppeteer-core").Page) => Promise<T>): Promise<T> {
	const wsEndpoint = await getBrowserWSEndpoint();
	const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
	try {
		const page = await browser.newPage();
		await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1.5 });
		const result = await fn(page);
		await page.close();
		return result;
	} finally {
		browser.disconnect();
	}
}

/** Render a Mermaid definition to a PNG using inline mermaid.js in the browser. */
export async function renderMermaid(definition: string): Promise<Buffer> {
	return withPage(async (page) => {
		const html = `<!DOCTYPE html>
<html><head>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
</head><body>
<pre class="mermaid">${definition.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>
<script>mermaid.initialize({startOnLoad:true,theme:'neutral'});</script>
</body></html>`;

		await page.setContent(html, { waitUntil: "networkidle0", timeout: 30_000 });
		// Wait for mermaid to render
		await page.waitForSelector("svg", { timeout: 10_000 });

		const svg = await page.$("svg");
		if (!svg) throw new Error("Mermaid rendering produced no SVG");

		const mermaidScreenshot = await svg.screenshot({ type: "png" });
		return Buffer.from(mermaidScreenshot);
	});
}
