/**
 * Docker-compose environment encoding/decoding.
 *
 * User-controlled values (project name, model, API keys, ...) are written into
 * a generated `docker-compose.yml`. A naive `KEY: value` line lets a value
 * containing a quote, newline or `:` break out of its scalar and inject sibling
 * compose keys — a compose-injection vector. `yamlScalar` encodes every such
 * value as a YAML double-quoted scalar; `parseComposeEnvironment` reverses it.
 *
 * Extracted from manager.ts so the encode/decode round-trip can be unit-tested
 * in isolation (it's the security-critical half of compose generation).
 */

/**
 * Encode a string as a YAML double-quoted scalar. JSON string syntax is a
 * subset of YAML's double-quoted style, so `JSON.stringify` produces a valid,
 * fully-escaped scalar: embedded quotes, backslashes and newlines can't break
 * out of the value or inject sibling compose keys. `parseComposeEnvironment`
 * reverses this with `JSON.parse` for any value that starts with `"`.
 */
export function yamlScalar(value: string): string {
	return JSON.stringify(value);
}

/**
 * Parse the `environment:` block of a generated compose file back into a
 * key→value map. Values written by `yamlScalar` (JSON-encoded, leading `"`) are
 * decoded with `JSON.parse`; bare values (legacy compose files) pass through.
 */
export function parseComposeEnvironment(compose: string): Record<string, string> {
	const vars: Record<string, string> = {};
	const envBlock = compose.match(/^\s+environment:\n((?:\s+.+\n)*)/m);
	if (!envBlock) return vars;
	for (const line of envBlock[1].split("\n")) {
		// Split on the first `:` so quoted values (which may contain `:`) survive.
		const match = line.match(/^\s+([A-Z_]+):\s*(.*?)\s*$/);
		if (!match) continue;
		const [, key, rawValue] = match;
		if (rawValue.startsWith('"')) {
			// JSON-encoded by yamlScalar — decode to recover the exact value.
			try {
				vars[key] = JSON.parse(rawValue);
				continue;
			} catch {
				// Fall through to treat it as a bare string (legacy compose files).
			}
		}
		vars[key] = rawValue;
	}
	return vars;
}
