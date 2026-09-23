import { getDb } from "./index";

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
  detected_at: string;
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

export function insertDuplicateDetection(
  input: InsertDuplicateDetectionInput
): DuplicateDetectionRow {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO duplicate_detections
        (phone_normalized, existing_contact_id, existing_lead_id, new_contact_id, new_lead_id, notes)
       VALUES (@phoneNormalized, @existingContactId, @existingLeadId, @newContactId, @newLeadId, @notes)`
    )
    .run({ ...input, notes: input.notes ?? null });

  return db
    .prepare(`SELECT * FROM duplicate_detections WHERE id = ?`)
    .get(result.lastInsertRowid) as DuplicateDetectionRow;
}

/**
 * Evita registrar el mismo par (telefono, entidad nueva, entidad existente)
 * mas de una vez, para el caso de reintentos de webhook que no fueron
 * atajados por la tabla de idempotencia (defensa en profundidad).
 */
export function findExistingPendingDetection(
  phoneNormalized: string,
  newContactId: string | null,
  newLeadId: string | null
): DuplicateDetectionRow | undefined {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM duplicate_detections
       WHERE phone_normalized = ?
         AND status = 'pending_review'
         AND ((new_contact_id IS ? OR new_contact_id = ?))
         AND ((new_lead_id IS ? OR new_lead_id = ?))`
    )
    .get(
      phoneNormalized,
      newContactId,
      newContactId,
      newLeadId,
      newLeadId
    ) as DuplicateDetectionRow | undefined;
}

export function listDetectionsByStatus(
  status: DuplicateDetectionStatus | undefined
): DuplicateDetectionRow[] {
  const db = getDb();
  if (!status) {
    return db
      .prepare(`SELECT * FROM duplicate_detections ORDER BY detected_at DESC`)
      .all() as DuplicateDetectionRow[];
  }
  return db
    .prepare(
      `SELECT * FROM duplicate_detections WHERE status = ? ORDER BY detected_at DESC`
    )
    .all(status) as DuplicateDetectionRow[];
}
