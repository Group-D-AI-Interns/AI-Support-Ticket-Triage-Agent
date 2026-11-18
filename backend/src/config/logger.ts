import type { Environment } from "./env.js";

const rank = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export function createLogger(level: Environment["logLevel"]) {
  function write(severity: keyof typeof rank, message: string, fields: Record<string, unknown> = {}) {
    if (rank[severity] < rank[level]) return;
    const line = JSON.stringify({ timestamp: new Date().toISOString(), severity, message, ...fields });
    if (severity === "error") console.error(line);
    else if (severity === "warn") console.warn(line);
    else console.log(line);
  }

  return {
    debug: (message: string, fields?: Record<string, unknown>) => write("debug", message, fields),
    info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
    error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields),
  };
}
