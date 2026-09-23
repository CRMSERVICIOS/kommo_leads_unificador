import { getPool } from "./index";

export type DuplicateDetectionStatus =
  | "pending_review"
  | "reviewed_merged"
  | "reviewed_ignored";

export interface DuplicateDetectionRow {
  id: number;
  phone_normalized: string;
  existing_contact_id: string | null;
  existing_lead_id: string | null;
  new_contact_id: string | null;
  new_lead_id: string | null;
  status: DuplicateDetectionStatus;
  detected_at: Date | string;
  notes: string | null;
}

export interface InsertDuplicateDetectionInput {
  phoneNormalized: string;
  existingContactId: string | null;
  existingLeadId: string | null;
  newContactId: string | null;
  newLeadId: string | null;
  notes?: string;
}

export async function insertDuplicateDetection(
  input: InsertDuplicateDetectionInput
): Promise<DuplicateDetectionRow> {
  const result = await getPool().query<DuplicateDetectionRow>(
    `INSERT INTO duplicate_detections
      (phone_normalized, existing_contact_id, existing_lead_id, new_contact_id, new_lead_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.phoneNormalized,
      input.existingContactId,
      input.existingLeadId,
      input.newContactId,
      input.newLeadId,
      input.notes ?? null,
    ]
  );
  return result.rows[0];
}

/** Agrega un texto a `notes` (ej: por que una deteccion quedo sin fusionar). */
export async function appendDetectionNote(id: number, note: string): Promise<void> {
  await getPool().query(
    `UPDATE duplicate_detections
     SET notes = CASE WHEN notes IS NULL OR notes = '' THEN $2 ELSE notes || ' | ' || $2 END
     WHERE id = $1`,
    [id, note]
  );
}

/**
 * Evita registrar el mismo par (telefono, entidad nueva, entidad existente)
 * mas de una vez, para el caso de reintentos de webhook que no fueron
 * atajados por la tabla de idempotencia (defensa en profundidad).
 */
export async function findExistingPendingDetection(
  phoneNormalized: string,
  newContactId: string | null,
  newLeadId: string | null
): Promise<DuplicateDetectionRow | undefined> {
  const result = await getPool().query<DuplicateDetectionRow>(
    `SELECT * FROM duplicate_detections
     WHERE phone_normalized = $1
       AND status = 'pending_review'
       AND new_contact_id IS NOT DISTINCT FROM $2
       AND new_lead_id IS NOT DISTINCT FROM $3
     LIMIT 1`,
    [phoneNormalized, newContactId, newLeadId]
  );
  return result.rows[0];
}

/**
 * Marca como `reviewed_merged` las detecciones pendientes entre dos
 * contactos, en cualquier sentido (existente->nuevo o al reves: el "eco" que
 * genera la propia fusion queda registrado con los roles invertidos).
 * Devuelve cuantas filas se actualizaron.
 */
export async function markDetectionsMergedForContacts(
  contactIdA: string,
  contactIdB: string
): Promise<number> {
  const result = await getPool().query(
    `UPDATE duplicate_detections
     SET status = 'reviewed_merged'
     WHERE status = 'pending_review'
       AND ((existing_contact_id = $1 AND new_contact_id = $2)
         OR (existing_contact_id = $2 AND new_contact_id = $1))`,
    [contactIdA, contactIdB]
  );
  return result.rowCount ?? 0;
}

export async function listDetectionsByStatus(
  status: DuplicateDetectionStatus | undefined
): Promise<DuplicateDetectionRow[]> {
  const result = status
    ? await getPool().query<DuplicateDetectionRow>(
        `SELECT * FROM duplicate_detections WHERE status = $1 ORDER BY detected_at DESC`,
        [status]
      )
    : await getPool().query<DuplicateDetectionRow>(
        `SELECT * FROM duplicate_detections ORDER BY detected_at DESC`
      );
  return result.rows;
}
