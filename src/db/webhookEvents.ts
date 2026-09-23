import crypto from "node:crypto";
import { getDb } from "./index";

/**
 * Construye una clave de idempotencia a partir del tipo de entidad, su id en
 * Kommo, y un hash del payload completo. Usamos el hash (y no solo
 * entityType+entityId) porque Kommo puede mandar varios eventos legitimos
 * distintos para la misma entidad (ej: "add" y despues "update"); lo que
 * queremos evitar es reprocesar EXACTAMENTE el mismo evento reintentado.
 */
export function buildEventKey(
  entityType: string,
  entityId: string,
  payload: unknown
): string {
  const payloadHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  return `${entityType}:${entityId}:${payloadHash}`;
}

/**
 * Intenta marcar un evento como procesado. Devuelve `true` si es la primera
 * vez que se ve (hay que procesarlo), o `false` si ya se proceso antes
 * (reintento de Kommo, hay que ignorarlo).
 */
export function markEventProcessedIfNew(eventKey: string): boolean {
  const db = getDb();
  try {
    db.prepare(
      `INSERT INTO processed_webhook_events (event_key) VALUES (?)`
    ).run(eventKey);
    return true;
  } catch (err) {
    // Violacion de UNIQUE constraint => ya estaba procesado.
    return false;
  }
}
