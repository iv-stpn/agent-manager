import { describe, expect, it } from "bun:test";

import { UpdateCategorySchema } from "./guideline-categories";
import { UpdateGuidelineSchema } from "./guidelines";
import { UpdateLlmClientSchema } from "./llm-clients";
import { UpdateTechStackSchema } from "./tech-stacks";

/**
 * Regression guard for the `.partial()` + `.default()` footgun. The create
 * schemas define fields with `.default("")` / `.default([])`; if an Update
 * schema were built as `CreateSchema.partial()`, zod would keep the ZodDefault
 * wrapper, so a PATCH that omits a key would re-inject the default and silently
 * wipe the stored value. These schemas are hand-written with `.optional()`
 * instead — parsing an empty patch must therefore yield an empty object (no
 * defaulted keys), and a single-field patch must contain only that field.
 */

const cases = [
	{ name: "UpdateTechStackSchema", schema: UpdateTechStackSchema, onlyKey: { name: "x" } },
	{ name: "UpdateGuidelineSchema", schema: UpdateGuidelineSchema, onlyKey: { name: "x" } },
	{ name: "UpdateCategorySchema", schema: UpdateCategorySchema, onlyKey: { name: "x" } },
	{ name: "UpdateLlmClientSchema", schema: UpdateLlmClientSchema, onlyKey: { name: "x" } },
] as const;

for (const { name, schema, onlyKey } of cases) {
	describe(name, () => {
		it("parses an empty patch to an empty object (no defaults injected)", () => {
			const parsed = schema.parse({});
			expect(Object.keys(parsed)).toHaveLength(0);
		});

		it("keeps only the provided key in a single-field patch", () => {
			const parsed = schema.parse(onlyKey) as Record<string, unknown>;
			expect(Object.keys(parsed)).toEqual(Object.keys(onlyKey));
		});
	});
}
