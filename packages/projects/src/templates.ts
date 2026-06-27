import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type TemplateCategory = "tech-stack" | "ui-design" | "best-practices" | "system-prompt";

export interface Template {
	id: string;
	name: string;
	description: string;
	category: TemplateCategory;
	content: string;
	createdAt: number;
	updatedAt: number;
}

export class TemplateManager {
	private readonly filePath: string;

	constructor(rootDir: string) {
		this.filePath = join(rootDir, "templates.json");
	}

	private read(): Template[] {
		if (!existsSync(this.filePath)) return [];
		try {
			return JSON.parse(readFileSync(this.filePath, "utf8"));
		} catch {
			return [];
		}
	}

	private write(templates: Template[]) {
		writeFileSync(this.filePath, JSON.stringify(templates, null, 2));
	}

	list(): Template[] {
		return this.read();
	}

	get(id: string): Template | undefined {
		return this.read().find((t) => t.id === id);
	}

	create(data: Omit<Template, "id" | "createdAt" | "updatedAt">): Template {
		const templates = this.read();
		const template: Template = { ...data, id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now() };
		templates.push(template);
		this.write(templates);
		return template;
	}

	update(id: string, data: Partial<Omit<Template, "id" | "createdAt">>): Template {
		const templates = this.read();
		const idx = templates.findIndex((t) => t.id === id);
		if (idx === -1) throw new Error(`Template ${id} not found`);
		templates[idx] = { ...templates[idx], ...data, updatedAt: Date.now() };
		this.write(templates);
		return templates[idx];
	}

	delete(id: string) {
		this.write(this.read().filter((t) => t.id !== id));
	}
}
