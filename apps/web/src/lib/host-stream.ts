export function createHostStream<T = unknown>(
	onEvent: (type: string, payload: { projectId: string; data: unknown }) => void,
	onSnapshot: (projects: T[]) => void
): EventSource {
	const eventSource = new EventSource("/api/projects/events");

	eventSource.addEventListener("projects", (event) => {
		if (!(event instanceof MessageEvent)) return;
		try {
			const parsed = JSON.parse(event.data);
			console.log("[SSE:orchestrator] projects (snapshot)", parsed);
			onSnapshot(parsed);
		} catch {
			// ignore malformed snapshot
		}
	});

	const events = ["project_status", "session_created", "message", "task_created", "task_updated"];
	for (const eventType of events) {
		eventSource.addEventListener(eventType, (event) => {
			if (!(event instanceof MessageEvent)) return;
			try {
				const parsed = JSON.parse(event.data);
				console.log(`[SSE:orchestrator] ${eventType}`, parsed);
				onEvent(eventType, parsed);
			} catch {
				// ignore malformed event
			}
		});
	}

	return eventSource;
}
