/**
 * Logger minimo en JSON estructurado (una linea por evento) para poder
 * auditar despues via cualquier agregador de logs (journalctl, Docker logs,
 * CloudWatch, etc.) sin depender de una libreria externa.
 */

type LogFields = Record<string, unknown>;

function log(level: "info" | "warn" | "error", msg: string, fields?: LogFields): void {
  const entry = {
    level,
    msg,
    timestamp: new Date().toISOString(),
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    // eslint-disable-next-line no-console
    console.error(line);
  } else if (level === "warn") {
    // eslint-disable-next-line no-console
    console.warn(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

export const logger = {
  info: (msg: string, fields?: LogFields) => log("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => log("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => log("error", msg, fields),
};
