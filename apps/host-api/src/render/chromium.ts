import { join } from "node:path";
import puppeteer from "puppeteer-core";

/**
 * Centralised browser-rendering for the whole platform. host-api connects to a
 * shared Chromium container (browserless) via CDP WebSocket — no local browser
 * installation required.
 */

const CHROMIUM_WS_URL = process.env.CHROMIUM_WS_URL ?? "ws://localhost:3201";

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

		const screenshot = await svg.screenshot({ type: "png" });
		return Buffer.from(screenshot);
	});
}

/** Screenshot a URL or an absolute file path. */
export async function screenshotTarget(target: string): Promise<Buffer> {
	return withPage(async (page) => {
		if (/^https?:\/\//.test(target)) {
			await page.goto(target, { waitUntil: "networkidle2", timeout: 30_000 });
		} else {
			// For file paths, read and set as content since remote browser can't access host filesystem
			const file = Bun.file(target);
			const html = await file.text();
			await page.setContent(html, { waitUntil: "load", timeout: 10_000 });
		}
		return Buffer.from(await page.screenshot({ type: "png", fullPage: false }));
	});
}

/** Screenshot a raw HTML string. */
export async function screenshotHtml(html: string): Promise<Buffer> {
	return withPage(async (page) => {
		await page.setContent(html, { waitUntil: "load" });
		return Buffer.from(await page.screenshot({ type: "png", fullPage: false }));
	});
}

/** Resolve a workspace-relative target to an absolute path under workspaceRoot. */
export function resolveWorkspacePath(workspaceRoot: string, target: string): string {
	if (target.startsWith("/")) {
		return target.startsWith(workspaceRoot) ? target : join(workspaceRoot, target.replace(/^\/+/, ""));
	}
	return join(workspaceRoot, target);
}
