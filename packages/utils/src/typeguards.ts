/**
 * Type guard utilities for runtime type checking
 */

/**
 * Check if a value is a non-null object (excludes arrays, null, and primitives)
 */
export function isObj(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Check if a value is a non-null object and not an array
 */
export function isPlainObj(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check if a value is a string
 */
export function isString(value: unknown): value is string {
	return typeof value === "string";
}

/**
 * Check if a value is a number (excluding NaN)
 */
export function isNumber(value: unknown): value is number {
	return typeof value === "number" && !Number.isNaN(value);
}

/**
 * Check if a value is a boolean
 */
export function isBoolean(value: unknown): value is boolean {
	return typeof value === "boolean";
}
