export function createHostStream<T = unknown>(
	onEvent: (type: string, payload: { projectId: string; data: unknown }) => void,
	onSnapshot: (projects: T[]) => void
): EventSource {
	const es = new EventSource("/api/projects/events");

	es.addEventListener("projects", (e) => {
		if (!(e instanceof MessageEvent)) return;
		try {
			const parsed = JSON.parse(e.data);
			console.log("[SSE:host] projects (snapshot)", parsed);
			onSnapshot(parsed);
		} catch {
			// ignore malformed snapshot
		}
	});

	const events = ["project_status", "session_created", "message"];
	for (const event of events) {
		es.addEventListener(event, (e) => {
			if (!(e instanceof MessageEvent)) return;
			try {
				const parsed = JSON.parse(e.data);
				console.log(`[SSE:host] ${event}`, parsed);
				onEvent(event, parsed);
			} catch {
				// ignore malformed event
			}
		});
	}

	return es;
}
