import { env } from "../env";

const ORCHESTRATOR_API_URL = env.ORCHESTRATOR_API_URL;

/**
 * Render a Mermaid definition to a PNG. Rendering is delegated to orchestrator-api
 * (the single orchestrator that has Chromium + mermaid-cli installed), so project
 * containers no longer bundle a browser. The `title` argument is accepted for
 * call-site compatibility but is not used by the renderer.
 */
export async function renderMermaid(definition: string): Promise<Buffer> {
	const resp = await fetch(`${ORCHESTRATOR_API_URL}/api/render/mermaid`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ definition }),
	});

	if (!resp.ok) {
		const detail = await resp.text().catch(() => "");
		throw new Error(`Mermaid render failed (${resp.status}): ${detail.slice(0, 300)}`);
	}

	return Buffer.from(await resp.arrayBuffer());
}
