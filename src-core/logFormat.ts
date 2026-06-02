export type LogSeverity = "INFO" | "WARN" | "ERROR";

export function formatLogLine(severity: LogSeverity, message: string, data?: unknown): string {
  const base = `[obsidian-local-sync] ${new Date().toISOString()} ${severity}: ${message}`;
  if (data === undefined || data === "") return base;
  return `${base} ${formatLogData(data)}`;
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
