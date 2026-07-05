// Generic reader for a `text/event-stream` response body that wasn't opened
// via `EventSource` — used when the stream needs a POST body (e.g. one that
// carries a secret that shouldn't go in a URL/query string), which native
// `EventSource` can't send.
export async function readSSEStream(response: Response, onEvent: (event: string, data: string) => void): Promise<void> {
	if (!response.body) throw new Error("Response has no body to stream");

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });

		const frames = buffer.split("\n\n");
		buffer = frames.pop() ?? "";

		for (const frame of frames) {
			let event = "message";
			const dataLines: string[] = [];
			for (const rawLine of frame.split("\n")) {
				if (rawLine.startsWith("event:")) event = rawLine.slice(6).trim();
				else if (rawLine.startsWith("data:")) dataLines.push(rawLine.slice(5).trim());
			}
			if (dataLines.length > 0) onEvent(event, dataLines.join("\n"));
		}
	}
}
