import { existsSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

/**
 * Centralised browser-rendering for the whole platform. master-api is the only
 * process that needs Chromium installed — project containers call the HTTP
 * endpoints in ../routes/render.ts instead of bundling their own browser.
 */

// Common Chromium/Chrome locations across Linux + macOS, tried in order when
// PUPPETEER_EXECUTABLE_PATH is not set explicitly.
const CHROMIUM_CANDIDATES = [
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/usr/bin/google-chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

let cachedExecutable: string | null | undefined;

/** Resolve the Chromium executable, or null if none can be found. */
export function resolveChromium(): string | null {
	if (cachedExecutable !== undefined) return cachedExecutable;

	const explicit = process.env.PUPPETEER_EXECUTABLE_PATH;
	if (explicit) {
		cachedExecutable = explicit;
		return explicit;
	}

	cachedExecutable = CHROMIUM_CANDIDATES.find((p) => existsSync(p)) ?? null;
	return cachedExecutable;
}

function requireChromium(): string {
	const exe = resolveChromium();
	if (!exe) {
		throw new Error(
			"Chromium not found. Install it on the master-api host (e.g. `brew install chromium` " +
				"or `apt-get install chromium`) or set PUPPETEER_EXECUTABLE_PATH."
		);
	}
	return exe;
}

const LAUNCH_ARGS = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];

/** Path to the mermaid-cli binary bundled as a master-api dependency. */
const MMDC = join(import.meta.dir, "..", "..", "node_modules", ".bin", "mmdc");

/** Render a Mermaid definition to a PNG using the bundled mmdc CLI. */
export async function renderMermaid(definition: string): Promise<Buffer> {
	requireChromium();

	const ts = Date.now();
	const inputPath = `/tmp/mermaid-${ts}.mmd`;
	const outputPath = `/tmp/mermaid-${ts}.png`;
	const puppeteerConfig = `/tmp/mermaid-puppeteer-${ts}.json`;

	await Bun.write(inputPath, definition);
	await Bun.write(puppeteerConfig, JSON.stringify({ executablePath: requireChromium(), args: LAUNCH_ARGS }));

	const proc = Bun.spawn(
		[MMDC, "-i", inputPath, "-o", outputPath, "-p", puppeteerConfig, "-b", "transparent", "--width", "1200", "--height", "800"],
		{ stdout: "pipe", stderr: "pipe" }
	);

	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`mmdc failed (exit ${exitCode}): ${stderr.slice(0, 300)}`);
	}

	const buf = Buffer.from(await Bun.file(outputPath).arrayBuffer());

	await Promise.allSettled([
		Bun.spawn(["rm", "-f", inputPath]).exited,
		Bun.spawn(["rm", "-f", outputPath]).exited,
		Bun.spawn(["rm", "-f", puppeteerConfig]).exited,
	]);

	return buf;
}

async function withPage<T>(fn: (page: import("puppeteer-core").Page) => Promise<T>): Promise<T> {
	const browser = await puppeteer.launch({
		executablePath: requireChromium(),
		args: LAUNCH_ARGS,
		headless: true,
	});
	try {
		const page = await browser.newPage();
		await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1.5 });
		return await fn(page);
	} finally {
		await browser.close();
	}
}

/** Screenshot a URL or an absolute file path. */
export async function screenshotTarget(target: string): Promise<Buffer> {
	return withPage(async (page) => {
		if (/^https?:\/\//.test(target)) {
			await page.goto(target, { waitUntil: "networkidle2", timeout: 30_000 });
		} else {
			await page.goto(`file://${target}`, { waitUntil: "load", timeout: 10_000 });
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
