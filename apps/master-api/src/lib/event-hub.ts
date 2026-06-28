import { EventEmitter } from "node:events";
import type { ProjectDocker, ProjectManager } from "@agent-manager/projects";
import { readSSEBody } from "@agent-manager/utils";

// A master-level event: an agent-server event (tagged with its project) or a
// project lifecycle change (start/stop). master-web's project list subscribes
// to these instead of polling.
export interface MasterEvent {
	projectId: string;
	// "project_status" for lifecycle, otherwise the agent event type
	// (session_created, message, token_update, checkin_*, …).
	type: string;
	data: unknown;
}

/**
 * Fans in the per-project agent SSE streams (and project lifecycle changes)
 * into a single emitter that master-web can subscribe to once.
 *
 * For every running project the hub holds one upstream connection to that
 * project's `/api/stream`, parses the SSE frames, and re-broadcasts each event
 * tagged with the project id. Connections are opened/closed as projects start
 * and stop (driven by the lifecycle hooks the projects router calls), so there
 * is no polling anywhere in the chain.
 */
export class EventHub {
	private readonly emitter = new EventEmitter();
	private readonly upstreams = new Map<string, AbortController>();
	private started = false;

	constructor(
		private readonly manager: ProjectManager,
		private readonly docker: ProjectDocker
	) {
		this.emitter.setMaxListeners(0);
	}

	/** Re-broadcast an event to every subscribed master-web client. */
	broadcast(event: MasterEvent): void {
		this.emitter.emit("event", event);
	}

	/** Subscribe a client; returns an unsubscribe fn. Lazily wires upstreams. */
	subscribe(listener: (event: MasterEvent) => void): () => void {
		this.emitter.on("event", listener);
		void this.ensureStarted();
		return () => this.emitter.off("event", listener);
	}

	// ---- lifecycle hooks, called by the projects router ----

	projectStarted(projectId: string): void {
		this.broadcast({ projectId, type: "project_status", data: { running: true } });
		this.connect(projectId);
	}

	projectStopped(projectId: string): void {
		this.broadcast({ projectId, type: "project_status", data: { running: false } });
		this.disconnect(projectId);
	}

	projectRestarted(projectId: string): void {
		// Reconnect to the fresh server; it stays running, so report running:true.
		this.disconnect(projectId);
		this.broadcast({ projectId, type: "project_status", data: { running: true } });
		this.connect(projectId);
	}

	// On first subscriber, open upstreams for whatever is already running.
	private async ensureStarted(): Promise<void> {
		if (this.started) return;
		this.started = true;
		try {
			const projects = await this.manager.listProjects();
			await Promise.all(
				projects.map(async (p) => {
					const status = await this.docker.getProjectStatus(p.id);
					if (status.running) this.connect(p.id);
				})
			);
		} catch {
			// best effort — lifecycle hooks will still wire things as they happen
		}
	}

	private connect(projectId: string): void {
		if (this.upstreams.has(projectId)) return;
		const controller = new AbortController();
		this.upstreams.set(projectId, controller);
		void this.pump(projectId, controller);
	}

	private disconnect(projectId: string): void {
		const controller = this.upstreams.get(projectId);
		if (controller) {
			controller.abort();
			this.upstreams.delete(projectId);
		}
	}

	// Hold an upstream connection to one project's global stream, reconnecting
	// (with a small backoff) while the project is meant to be running.
	private async pump(projectId: string, controller: AbortController): Promise<void> {
		while (!controller.signal.aborted) {
			try {
				const project = await this.manager.getProject(projectId);
				const url = `http://localhost:${project.ports.server}/api/stream`;
				const res = await fetch(url, {
					signal: controller.signal,
					headers: { accept: "text/event-stream" },
				});
				if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
				await this.read(res.body, projectId, controller.signal);
			} catch {
				// connection failed or dropped — fall through to backoff + retry
			}
			if (controller.signal.aborted) break;
			await new Promise((resolve) => setTimeout(resolve, 3000));
		}
	}

	private async read(body: ReadableStream<Uint8Array>, projectId: string, signal: AbortSignal): Promise<void> {
		await readSSEBody(body, (event: string, data: unknown) => {
			this.broadcast({ projectId, type: event, data });
		}, signal);
	}
}
