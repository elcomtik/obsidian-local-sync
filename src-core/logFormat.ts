export type LogSeverity = "INFO" | "WARN" | "ERROR" | "DEBUG";
export type LogFormatter = (severity: LogSeverity, message: string, data?: unknown) => string;

export function formatLogLine(severity: LogSeverity, message: string, data?: unknown): string {
  const base = `[obsidian-local-sync] ${new Date().toISOString()} ${severity}: ${message}`;
  if (data === undefined || data === "") return base;
  return `${base} ${formatLogData(data)}`;
}

export function createDaemonLogFormatter(component: string, context: Record<string, string>): LogFormatter {
  return (severity, message, data) => {
    const contextText = Object.entries(context)
      .filter(([, value]) => value.length > 0)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    const prefix = contextText
      ? `${new Date().toISOString()} [${component}] ${contextText} ${severity}: ${message}`
      : `${new Date().toISOString()} [${component}] ${severity}: ${message}`;
    if (data === undefined || data === "") return prefix;
    return `${prefix} ${formatLogData(data)}`;
  };
}

function formatLogData(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof Error) {
    return JSON.stringify({
      name: data.name,
      message: data.message,
      stack: data.stack,
    });
  }

  try {
    return JSON.stringify(data, getCircularReplacer());
  } catch {
    return String(data);
  }
}

function getCircularReplacer() {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown) => {
    if (typeof value === "bigint") return value.toString();

    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }

    return value;
  };
}
