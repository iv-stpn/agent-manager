export type LogLevel = "debug" | "info" | "warn" | "error";

type LogEntry = {
	level: LogLevel;
	message: string;
	timestamp: string;
	data?: unknown;
	error?: { name: string; message: string; stack?: string | undefined };
	requestId?: string;
	userId?: string;
	path?: string;
	method?: string;
	statusCode?: number;
};

interface LogTransport {
	log(entry: LogEntry): void | Promise<void>;
}

class ConsoleTransport implements LogTransport {
	log(entry: LogEntry): void {
		const parts: unknown[] = [`[${entry.level.toUpperCase()}]`, entry.message];
		if (entry.data !== undefined) parts.push(entry.data);
		if (entry.error) {
			parts.push(entry.error.stack ? `\n${entry.error.stack}` : entry.error.message);
		}
		switch (entry.level) {
			case "error":
				console.error(...parts);
				break;
			case "warn":
				console.warn(...parts);
				break;
			default:
				console.info(...parts);
		}
	}
}

class DiscordTransport implements LogTransport {
	constructor(private readonly webhookUrl: string) {}

	log(entry: LogEntry): Promise<void> | void {
		if (entry.level !== "error") return;
		return this.send(entry);
	}

	private async send(entry: LogEntry): Promise<void> {
		const fields: { name: string; value: string; inline?: boolean }[] = [];

		if (entry.method) fields.push({ name: "Method", value: entry.method, inline: true });
		if (entry.path) fields.push({ name: "Path", value: entry.path, inline: true });
		if (entry.statusCode) fields.push({ name: "Status", value: String(entry.statusCode), inline: true });
		if (entry.requestId) fields.push({ name: "Request ID", value: entry.requestId, inline: true });
		if (entry.userId) fields.push({ name: "User ID", value: entry.userId, inline: true });

		if (entry.data !== undefined) {
			const dataStr = JSON.stringify(entry.data, null, 2);
			fields.push({ name: "Context", value: `\`\`\`json\n${dataStr.slice(0, 900)}\n\`\`\`` });
		}

		if (entry.error?.stack) {
			fields.push({
				name: "Stack Trace",
				value: `\`\`\`\n${entry.error.stack.slice(0, 900)}\n\`\`\``,
			});
		} else if (entry.error?.message) {
			fields.push({ name: "Error", value: entry.error.message });
		}

		const color =
			!entry.statusCode || entry.statusCode < 502
				? 0xff0000
				: entry.statusCode === 502
					? 0xff4500
					: entry.statusCode === 503
						? 0xffa500
						: 0xff8c00;

		const embed = {
			title: `🚨 ${entry.statusCode ? `${entry.statusCode} ` : ""}${entry.message}`,
			description: entry.error ? `**${entry.error.name}**: ${entry.error.message}` : undefined,
			color,
			fields,
			timestamp: entry.timestamp,
			footer: { text: "Backend Error" },
		};

		await fetch(this.webhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ embeds: [embed] }),
		});
	}
}

type LogContext = Partial<Omit<LogEntry, "level" | "message" | "timestamp">>;

export class Logger {
	constructor(
		private readonly transports: LogTransport[],
		private readonly baseContext: LogContext = {}
	) {}

	private async emit(level: LogLevel, message: string, extra: LogContext = {}): Promise<void> {
		const entry: LogEntry = {
			level,
			message,
			timestamp: new Date().toISOString(),
			...this.baseContext,
			...extra,
		};
		await Promise.all(this.transports.map((transport) => transport.log(entry)));
	}

	debug(message: string, data?: unknown): void {
		void this.emit("debug", message, { data });
	}

	info(message: string, data?: unknown): void {
		void this.emit("info", message, { data });
	}

	warn(message: string, errorOrData?: Error | unknown): void {
		if (errorOrData instanceof Error) {
			void this.emit("warn", message, {
				error: { name: errorOrData.name, message: errorOrData.message, stack: errorOrData.stack },
			});
		} else {
			void this.emit("warn", message, { data: errorOrData });
		}
	}

	error(message: string, errorOrData?: Error | unknown, extra?: LogContext): Promise<void> {
		const entryExtra: LogContext = { ...extra };
		if (errorOrData instanceof Error) {
			entryExtra.error = {
				name: errorOrData.name,
				message: errorOrData.message,
				stack: errorOrData.stack,
			};
		} else if (errorOrData !== undefined) {
			entryExtra.data = errorOrData;
		}
		return this.emit("error", message, entryExtra);
	}

	child(context: LogContext): Logger {
		return new Logger(this.transports, { ...this.baseContext, ...context });
	}
}

export function createLogger(env: { DISCORD_WEBHOOK_URL?: string | undefined }): Logger {
	const transports: LogTransport[] = [new ConsoleTransport()];
	if (env.DISCORD_WEBHOOK_URL) {
		transports.push(new DiscordTransport(env.DISCORD_WEBHOOK_URL));
	}
	return new Logger(transports);
}
