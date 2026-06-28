import { env } from "../env";

const HOST_API_URL = env.HOST_API_URL;
const PROJECT_ID = env.PROJECT_ID;

/**
 * Screenshots are delegated to host-api so project containers don't bundle
 * Chromium/puppeteer. For workspace-relative file paths we send PROJECT_ID and
 * the path; host-api resolves it against the project's real workspace path
 * (it sees the host filesystem) and loads it via file:// — preserving relative
 * CSS/image assets.
 */
async function requestScreenshot(body: Record<string, unknown>): Promise<Buffer> {
	const resp = await fetch(`${HOST_API_URL}/api/render/screenshot`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

	if (!resp.ok) {
		const detail = await resp.text().catch(() => "");
		throw new Error(`Screenshot failed (${resp.status}): ${detail.slice(0, 300)}`);
	}

	return Buffer.from(await resp.arrayBuffer());
}

export async function screenshotTarget(target: string): Promise<Buffer> {
	return requestScreenshot({ target, projectId: PROJECT_ID });
}

export async function screenshotHtml(html: string): Promise<Buffer> {
	return requestScreenshot({ html });
}
