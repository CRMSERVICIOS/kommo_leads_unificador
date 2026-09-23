import { getDb } from "./index";

export interface PhoneIndexRow {
  id: number;
  phone_normalized: string;
  kommo_contact_id: string | null;
  kommo_lead_id: string | null;
  source: string | null;
  created_at: string;
}

/**
 * Busca todas las entradas del indice para un telefono normalizado dado.
 * Puede haber mas de una fila (ej: el mismo telefono asociado a distintos
 * leads del mismo contacto).
 */
export function findByPhone(phoneNormalized: string): PhoneIndexRow[] {
  const db = getDb();
  return db
    .prepare(`SELECT * FROM phone_index WHERE phone_normalized = ?`)
    .all(phoneNormalized) as PhoneIndexRow[];
}

export interface InsertPhoneIndexInput {
  phoneNormalized: string;
  kommoContactId: string | null;
  kommoLeadId: string | null;
  source: string | null;
}

export function insertPhoneIndex(input: InsertPhoneIndexInput): PhoneIndexRow {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO phone_index (phone_normalized, kommo_contact_id, kommo_lead_id, source)
       VALUES (@phoneNormalized, @kommoContactId, @kommoLeadId, @source)`
    )
    .run(input);

  return db
    .prepare(`SELECT * FROM phone_index WHERE id = ?`)
    .get(result.lastInsertRowid) as PhoneIndexRow;
}

/**
 * Determina si una fila existente del indice pertenece a "otra" entidad
 * distinta de la del evento actual (criterio para considerarlo duplicado
 * potencial en vez de un re-procesamiento del mismo lead/contacto).
 */
export function belongsToDifferentEntity(
  row: PhoneIndexRow,
  currentContactId: string | null,
  currentLeadId: string | null
): boolean {
  const sameContact =
    currentContactId != null && row.kommo_contact_id === currentContactId;
  const sameLead = currentLeadId != null && row.kommo_lead_id === currentLeadId;
  return !sameContact && !sameLead;
}
