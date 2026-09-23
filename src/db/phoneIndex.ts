import { getPool } from "./index";

export interface PhoneIndexRow {
  id: number;
  phone_normalized: string;
  kommo_contact_id: string | null;
  kommo_lead_id: string | null;
  source: string | null;
  created_at: Date | string;
}

/**
 * Busca todas las entradas del indice para un telefono normalizado dado.
 * Puede haber mas de una fila (ej: el mismo telefono asociado a distintos
 * leads del mismo contacto).
 */
export async function findByPhone(phoneNormalized: string): Promise<PhoneIndexRow[]> {
  const result = await getPool().query<PhoneIndexRow>(
    `SELECT * FROM phone_index WHERE phone_normalized = $1 ORDER BY id`,
    [phoneNormalized]
  );
  return result.rows;
}

export interface InsertPhoneIndexInput {
  phoneNormalized: string;
  kommoContactId: string | null;
  kommoLeadId: string | null;
  source: string | null;
}

export async function insertPhoneIndex(input: InsertPhoneIndexInput): Promise<PhoneIndexRow> {
  const result = await getPool().query<PhoneIndexRow>(
    `INSERT INTO phone_index (phone_normalized, kommo_contact_id, kommo_lead_id, source)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.phoneNormalized, input.kommoContactId, input.kommoLeadId, input.source]
  );
  return result.rows[0];
}

/**
 * Inserta solo si todavia no hay una fila para ese telefono + contacto (para
 * el backfill, que se puede correr mas de una vez). Devuelve true si inserto.
 */
export async function insertPhoneIndexIfMissing(input: InsertPhoneIndexInput): Promise<boolean> {
  const result = await getPool().query(
    `INSERT INTO phone_index (phone_normalized, kommo_contact_id, kommo_lead_id, source)
     SELECT $1, $2, $3, $4
     WHERE NOT EXISTS (
       SELECT 1 FROM phone_index WHERE phone_normalized = $1 AND kommo_contact_id IS NOT DISTINCT FROM $2
     )`,
    [input.phoneNormalized, input.kommoContactId, input.kommoLeadId, input.source]
  );
  return result.rowCount === 1;
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
