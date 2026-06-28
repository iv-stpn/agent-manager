import type { MiddlewareHandler } from "hono";
import { getErrorMessage } from "../lib/errors";
import { createLogger } from "../lib/logger";
import type { HonoHostEnv } from "../types";

const red = "\x1b[31m";
const green = "\x1b[32m";
const yellow = "\x1b[33m";
const blue = "\x1b[34m";
const white = "\x1b[37m";
const grey = "\x1b[90m";
const bold = "\x1b[1m";
const reset = "\x1b[0m";

const specialKeywords = new Set(["cf", "id", "ip", "url", "ua"]);
const redactedQueryKeys = new Set(["access_token", "token", "refresh_token"]);

type HeaderMap = Record<string, string | string[]>;
type LogBody = { body: string; data?: unknown };

function generateId(): string {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function formatClockTime(): string {
	return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function getClientIp(request: Request): string {
	const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
	return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip") ?? forwardedFor ?? "unknown";
}

function jsonStringify(value: unknown): string {
	try {
		return (
			JSON.stringify(
				value,
				(_key, currentValue) => {
					if (currentValue instanceof Error) {
						return {
							name: currentValue.name,
							message: currentValue.message,
							stack: currentValue.stack,
						};
					}

					return typeof currentValue === "bigint" ? currentValue.toString() : currentValue;
				},
				2
			) ?? "null"
		);
	} catch (error) {
		return `"[Unserializable: ${getErrorMessage(error)}]"`;
	}
}

function capitalizeHeader(header: string): string {
	return header
		.split("-")
		.map((part) => {
			if (specialKeywords.has(part.toLowerCase())) {
				return part.toUpperCase();
			}
			return part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join("-");
}

function logHeaders(headers: HeaderMap): void {
	if (Object.keys(headers).length === 0) {
		console.info(`${yellow}(no headers)${reset}`);
		return;
	}

	console.info();
	for (const [key, value] of Object.entries(headers)) {
		console.info(`${blue}${capitalizeHeader(key)}:${reset} ${value}`);
	}
	console.info();
}

function processBody(body: string | undefined, contentType: string | null): LogBody {
	if (!body) {
		return { body: "empty" };
	}

	if (!contentType || contentType === "application/octet-stream") {
		return {
			body: contentType === "application/octet-stream" ? "raw" : "none",
			data: `(${body.length} bytes)`,
		};
	}

	if (contentType.includes("application/json")) {
		try {
			return { body: "json", data: JSON.parse(body) };
		} catch {
			return { body: "json (invalid)", data: body };
		}
	}

	if (contentType.includes("application/x-www-form-urlencoded")) {
		return { body: "form", data: body };
	}

	return { body: "raw", data: body };
}

function sanitizeQuery(query: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(query).map(([key, value]) => [key, redactedQueryKeys.has(key.toLowerCase()) ? "[REDACTED]" : value])
	);
}

function colorStatus(status: number, statusText: string): string {
	const category = (status / 100) | 0;
	const coloredStatus =
		category === 5
			? `${red}${bold}${status}${reset}`
			: category === 4
				? `${yellow}${bold}${status}${reset}`
				: category === 3
					? `${blue}${bold}${status}${reset}`
					: category === 2
						? `${green}${bold}${status}${reset}`
						: `${white}${bold}${status}${reset}`;

	if (!statusText) {
		return coloredStatus;
	}

	switch (category) {
		case 5:
			return `${coloredStatus} ${red}${statusText}${reset}`;
		case 4:
			return `${coloredStatus} ${yellow}${statusText}${reset}`;
		case 3:
			return `${coloredStatus} ${blue}${statusText}${reset}`;
		case 2:
			return `${coloredStatus} ${green}${statusText}${reset}`;
		default:
			return `${coloredStatus} ${white}${statusText}${reset}`;
	}
}

function colorMethod(method: string): string {
	return method === "GET" ? `${bold}${method}${reset}` : `${bold}${yellow}${method}${reset}`;
}

function colorResponseTime(responseTime: number): string {
	if (responseTime < 200) {
		return `${grey}(${responseTime}ms)${reset}`;
	}
	if (responseTime < 1_000) {
		return `${yellow}(${responseTime}ms)${reset}`;
	}
	return `${bold}${red}(${responseTime}ms)${reset}`;
}

function isWebSocketHandshake(request: Request, response: Response): boolean {
	if (response.status !== 101) {
		return false;
	}
	const requestUpgrade = request.headers.get("upgrade")?.toLowerCase();
	const responseUpgrade = response.headers.get("upgrade")?.toLowerCase();
	return requestUpgrade === "websocket" || responseUpgrade === "websocket";
}

export const requestLogger: MiddlewareHandler<HonoHostEnv> = async (context, next) => {
	const requestId = generateId();
	const logger = createLogger({ DISCORD_WEBHOOK_URL: context.env.DISCORD_WEBHOOK_URL }).child({
		requestId,
		path: context.req.path,
		method: context.req.method,
	});
	context.set("logger", logger);
	context.set("requestId", requestId);
	context.header("X-Request-Id", requestId);

	const headers = Object.fromEntries(context.req.raw.headers.entries());
	const logData = [
		`${grey}[${formatClockTime()}]${reset}`,
		`[${getClientIp(context.req.raw)}]`,
		colorMethod(context.req.method),
		context.req.path,
	];

	try {
		const clonedRequest = context.req.raw.clone();
		const contentType = context.req.raw.headers.get("content-type");
		let body: LogBody;

		try {
			body = processBody(await clonedRequest.text(), contentType);
		} catch {
			body = { body: contentType ?? "none", data: "(could not parse body)" };
		}

		console.info("-->", ...logData, { ...body, query: sanitizeQuery(context.req.query()) });
	} catch (error) {
		console.error("-->", ...logData, jsonStringify(error));
	}

	logHeaders(headers);
	await next();
};

export const responseLogger: MiddlewareHandler<HonoHostEnv> = async (context, next) => {
	const executionStart = Date.now();

	await next();

	const headers = Object.fromEntries(context.res.headers.entries());
	const statusColor = colorStatus(context.res.status, context.res.statusText);
	const logData = [
		`${grey}[${formatClockTime()}]${reset}`,
		`[${getClientIp(context.req.raw)}]`,
		colorMethod(context.req.method),
		context.req.path,
		statusColor,
	];

	try {
		const contentType = context.res.headers.get("content-type");
		const isStream = contentType?.includes("text/event-stream") || contentType?.includes("application/octet-stream");
		const body = isWebSocketHandshake(context.req.raw, context.res)
			? { body: "websocket-handshake" }
			: isStream
				? { body: "stream" }
				: processBody(await context.res.clone().text(), contentType);

		console.info("<--", ...logData, colorResponseTime(Date.now() - executionStart), body);
	} catch (error) {
		console.error("<--", ...logData, jsonStringify(error));
	}

	logHeaders(headers);

	// Log errors to transports (including Discord)
	if (context.res.status >= 500) {
		const logger = context.get("logger");
		if (logger) {
			void logger.error(`${context.req.method} ${context.req.path} failed`, undefined, {
				statusCode: context.res.status,
			});
		}
	}
};
