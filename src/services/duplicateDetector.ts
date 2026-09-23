import { config } from "../config";
import { logger } from "../logger";
import { normalizePhone } from "./phoneNormalizer";
import { findContactsByPhoneQuery, getContactLeadIds, getLead } from "./kommoClient";
import { CLOSED_LOST_STATUS_ID, CLOSED_WON_STATUS_ID, unifyDuplicate } from "./duplicateUnifier";
import {
  belongsToDifferentEntity,
  findByPhone,
  insertPhoneIndex,
  type PhoneIndexRow,
} from "../db/phoneIndex";
import {
  appendDetectionNote,
  findExistingPendingDetection,
  insertDuplicateDetection,
} from "../db/duplicateDetections";
import { buildEventKey, markEventProcessedIfNew } from "../db/webhookEvents";
import type { LeadSource } from "../types/kommo";

export interface ProcessIncomingEntityInput {
  /** 'lead' o 'contact': que tipo de entidad disparo el webhook. */
  entityType: "lead" | "contact";
  /** id de la entidad en Kommo (el mismo que entityId de arriba, solo para logging). */
  entityId: string;
  /** contact_id asociado al evento, si se conoce. */
  contactId: string | null;
  /** lead_id asociado al evento, si se conoce. */
  leadId: string | null;
  /**
   * Todos los leads vinculados al contacto (de `linked_leads_id` en eventos
   * contacts.add/update). Si viene con al menos un id, la nota + tag de
   * duplicado se aplican a cada uno de estos leads en vez de al contacto,
   * para que el vendedor lo vea en el lead que esta trabajando.
   */
  linkedLeadIds?: string[];
  /** telefonos crudos extraidos del payload (un contacto puede tener varios). */
  phonesRaw: string[];
  source: LeadSource;
  /** payload completo, usado solo para el hash de idempotencia. */
  rawPayload: unknown;
}

/**
 * Extrae los ids de lead de `linked_leads_id` de un contacto. Forma real
 * confirmada (payload de "test 22", contacts.update):
 * `{ "22627634": { "ID": "22627634" } }`. Un contacto puede tener varios
 * leads vinculados; se devuelven todos, sin repetir.
 */
export function extractLinkedLeadIds(
  linkedLeadsId: Record<string, { ID?: string }> | undefined | null
): string[] {
  if (!linkedLeadsId || typeof linkedLeadsId !== "object") return [];

  const ids = Object.entries(linkedLeadsId)
    .map(([key, value]) => String(value?.ID ?? key))
    .filter((id) => id !== "" && id !== "0");

  return [...new Set(ids)];
}

export interface ProcessIncomingEntityResult {
  skippedAsRetry: boolean;
  duplicatesDetected: number;
  phonesIndexed: number;
  phonesUnableToNormalize: number;
}

/**
 * Logica central de deteccion + fusion automatica de duplicados.
 *
 * Por cada telefono del payload:
 *  - Si no esta en `phone_index`: se indexa y no pasa nada mas.
 *  - Si esta en `phone_index` asociado a OTRO contacto que no comparte
 *    leads con este (los que comparten ya estan fusionados): se registra en
 *    `duplicate_detections` (pending_review) y se fusiona automaticamente
 *    con unifyDuplicate() -- ver `autoUnify` para cuando se deja pendiente.
 *
 * Sin avisos externos: la unica accion es la fusion en Kommo.
 */
export async function processIncomingEntity(
  input: ProcessIncomingEntityInput
): Promise<ProcessIncomingEntityResult> {
  const eventKey = buildEventKey(input.entityType, input.entityId, input.rawPayload);
  const isNewEvent = await markEventProcessedIfNew(eventKey);

  if (!isNewEvent) {
    logger.info("webhook_event_ignored_retry", {
      entityType: input.entityType,
      entityId: input.entityId,
    });
    return {
      skippedAsRetry: true,
      duplicatesDetected: 0,
      phonesIndexed: 0,
      phonesUnableToNormalize: 0,
    };
  }

  let duplicatesDetected = 0;
  let phonesIndexed = 0;
  let phonesUnableToNormalize = 0;

  for (const rawPhone of input.phonesRaw) {
    const normalized = normalizePhone(rawPhone, config.defaultCountryCode);

    if (!normalized) {
      phonesUnableToNormalize += 1;
      continue;
    }

    let existingRows = await findByPhone(normalized);
    if (existingRows.length === 0) {
      existingRows = await indexUnseenContactsFromKommo(normalized, input);
    }
    // El ganador es siempre el contacto mas viejo (id de Kommo mas bajo),
    // no el que llego primero a nuestro indice.
    const conflicting = existingRows
      .filter((row) => belongsToDifferentEntity(row, input.contactId, input.leadId))
      .sort((a, b) => compareContactIds(a.kommo_contact_id, b.kommo_contact_id));

    const existing = await findFirstNotYetMerged(conflicting, existingRows, input, normalized);

    if (existing) {

      const alreadyRecorded = await findExistingPendingDetection(
        normalized,
        input.contactId,
        input.leadId
      );

      if (!alreadyRecorded) {
        const detection = await insertDuplicateDetection({
          phoneNormalized: normalized,
          existingContactId: existing.kommo_contact_id,
          existingLeadId: existing.kommo_lead_id,
          newContactId: input.contactId,
          newLeadId: input.leadId,
          notes: `Detectado via webhook de ${input.entityType} (fuente: ${input.source})`,
        });

        duplicatesDetected += 1;

        const pendingReason = await autoUnify(input, existing, normalized);
        if (pendingReason) {
          await appendDetectionNote(detection.id, `Sin fusion automatica: ${pendingReason}`);
        }
      } else {
        logger.info("duplicate_detection_already_recorded", {
          phoneNormalized: normalized,
          newContactId: input.contactId,
          newLeadId: input.leadId,
        });
      }
    }

    // Se indexa siempre (tanto si es nuevo como si es un duplicado
    // potencial), para que futuros eventos puedan cruzar contra esta
    // entidad tambien.
    await insertPhoneIndex({
      phoneNormalized: normalized,
      kommoContactId: input.contactId,
      kommoLeadId: input.leadId,
      source: input.source,
    });
    phonesIndexed += 1;
  }

  return {
    skippedAsRetry: false,
    duplicatesDetected,
    phonesIndexed,
    phonesUnableToNormalize,
  };
}

/**
 * Devuelve la primera fila en conflicto cuyo contacto NO comparte ningun lead
 * con la entidad del evento. Si comparten al menos un lead, ya estan
 * fusionados (ej: el `contacts.update` del contacto ganador que Kommo manda
 * como efecto secundario de unifyDuplicate) y no es un duplicado nuevo.
 */
async function findFirstNotYetMerged(
  conflicting: PhoneIndexRow[],
  allRowsForPhone: PhoneIndexRow[],
  input: ProcessIncomingEntityInput,
  phoneNormalized: string
): Promise<PhoneIndexRow | undefined> {
  const incomingLeadIds = new Set(
    [...(input.linkedLeadIds ?? []), input.leadId].filter((id): id is string => !!id)
  );

  for (const row of conflicting) {
    if (await sharesLeadWithIncoming(row, allRowsForPhone, incomingLeadIds)) {
      logger.info("duplicate_skipped_already_merged", {
        phoneNormalized,
        existingContactId: row.kommo_contact_id,
        newContactId: input.contactId,
        incomingLeadIds: [...incomingLeadIds],
      });
      continue;
    }
    return row;
  }

  return undefined;
}

async function sharesLeadWithIncoming(
  row: PhoneIndexRow,
  allRowsForPhone: PhoneIndexRow[],
  incomingLeadIds: Set<string>
): Promise<boolean> {
  if (incomingLeadIds.size === 0) return false;

  // Primero con lo que ya sabemos localmente (phone_index guarda un lead por fila).
  const knownLeadIds = allRowsForPhone
    .filter((r) => r === row || (row.kommo_contact_id && r.kommo_contact_id === row.kommo_contact_id))
    .map((r) => r.kommo_lead_id)
    .filter((id): id is string => !!id);
  if (knownLeadIds.some((id) => incomingLeadIds.has(id))) return true;

  // Las filas viejas no tienen lead y la fusion vincula leads despues de
  // indexar: se consulta a Kommo (solo lectura). Solo pasa cuando ya hay un
  // posible duplicado, no en cada evento.
  if (!row.kommo_contact_id) return false;
  try {
    const leadIds = await getContactLeadIds(row.kommo_contact_id);
    return leadIds.some((id) => incomingLeadIds.has(id));
  } catch (err) {
    // Ante la duda se reporta el duplicado: es preferible una marca de mas
    // que perder uno real.
    logger.warn("shared_lead_check_failed", {
      contactId: row.kommo_contact_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Tope de leads del contacto ganador que se consultan para elegir uno abierto. */
const MAX_WINNER_LEADS_TO_CHECK = 5;

/**
 * Fusiona automaticamente un duplicado recien registrado. El ganador es
 * siempre el contacto existente. Deja la deteccion en pending_review (para
 * revision manual, sin reintentos) cuando:
 *  - DRY_RUN=true (freno de emergencia: solo loguea).
 *  - el evento no trae exactamente UN lead del contacto nuevo (ej: eventos
 *    "unsorted", cuyo lead todavia no fue aceptado, o contactos con varios
 *    leads: no sabemos cual cerrar).
 *  - el contacto existente no tiene ningun lead abierto: seria un cliente que
 *    vuelve, y cerrar su consulta nueva la sacaria del embudo.
 *  - el contacto "nuevo" es mas viejo (id mas bajo) que el existente: el
 *    ganador deberia ser el nuevo, orden inesperado.
 *  - falla cualquier paso de unifyDuplicate (que ya loguea el detalle).
 *
 * Devuelve el motivo por el que quedo pendiente, o null si se fusiono.
 */
async function autoUnify(
  input: ProcessIncomingEntityInput,
  existing: PhoneIndexRow,
  phoneNormalized: string
): Promise<string | null> {
  const existingContactId = existing.kommo_contact_id;
  const newContactId = input.contactId;
  const newLeadIds = input.linkedLeadIds ?? [];

  const logContext = {
    phoneNormalized,
    existingContactId,
    newContactId,
    newLeadIds,
  };

  if (config.dryRun) {
    logger.info(
      `[DRY RUN] Duplicado detectado: telefono ${phoneNormalized} coincide con contacto existente ${existingContactId}. ` +
        `Se fusionaria el contacto ${newContactId} (leads ${newLeadIds.join(", ") || "-"}), pero no se ejecuta (DRY_RUN=true).`,
      logContext
    );
    return "DRY_RUN=true";
  }

  const skip = (reason: string): string => {
    logger.warn("auto_unify_skipped_pending_review", { ...logContext, reason });
    return reason;
  };

  if (!existingContactId || !newContactId) {
    return skip("falta el contacto existente o el nuevo");
  }
  if (compareContactIds(newContactId, existingContactId) < 0) {
    return skip("orden de IDs inesperado, revisar a mano");
  }
  if (newLeadIds.length !== 1) {
    return skip(
      newLeadIds.length === 0
        ? "el evento no trae lead del contacto nuevo (ej: unsorted)"
        : "el contacto nuevo tiene varios leads vinculados"
    );
  }
  const newLeadId = newLeadIds[0];

  try {
    const winnerLeadId = await findOpenWinnerLead(existing, newLeadId);
    if (!winnerLeadId) {
      return skip("el contacto existente no tiene leads abiertos");
    }

    const result = await unifyDuplicate(
      { existingContactId, existingLeadId: winnerLeadId, newContactId, newLeadId },
      { lossReasonId: config.duplicateLossReasonId }
    );

    if (!result.ok) {
      const failed = result.steps.find((s) => s.status === "failed");
      logger.error("auto_unify_failed_pending_review", {
        ...logContext,
        steps: result.steps.map((s) => ({ step: s.step, status: s.status, error: s.error })),
      });
      return `fallo la fusion en el paso ${failed?.step ?? "?"}: ${failed?.error ?? "sin detalle"}`;
    }
    return null;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("auto_unify_failed_pending_review", { ...logContext, error });
    return `fallo la fusion: ${error}`;
  }
}

/** Compara ids numericos de Kommo (los mas bajos son los mas viejos). */
function compareContactIds(a: string | null, b: string | null): number {
  const na = a != null && /^\d+$/.test(a) ? Number(a) : Number.POSITIVE_INFINITY;
  const nb = b != null && /^\d+$/.test(b) ? Number(b) : Number.POSITIVE_INFINITY;
  if (na === nb) return 0;
  return na < nb ? -1 : 1;
}

/** Cantidad de digitos finales del telefono que se mandan a la busqueda de Kommo. */
const KOMMO_PHONE_QUERY_DIGITS = 8;

/**
 * Fallback cuando el telefono no esta en phone_index: busca en Kommo otros
 * contactos con el mismo telefono que nunca indexamos (webhook perdido, o
 * contacto anterior al arranque del servicio), los indexa y los devuelve
 * como filas existentes. Si Kommo falla, no bloquea: se sigue como si el
 * telefono fuera nuevo, logueando que no se pudo verificar.
 */
async function indexUnseenContactsFromKommo(
  phoneNormalized: string,
  input: ProcessIncomingEntityInput
): Promise<PhoneIndexRow[]> {
  let contacts;
  try {
    contacts = await findContactsByPhoneQuery(phoneNormalized.slice(-KOMMO_PHONE_QUERY_DIGITS));
  } catch (err) {
    logger.error("KOMMO_LOOKUP_FAILED_PHONE_NOT_VERIFIED", {
      message:
        "No se pudo verificar en Kommo si el telefono ya existia en otro contacto; se procesa como telefono nuevo",
      phoneNormalized,
      contactId: input.contactId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  // La busqueda es por texto: se quedan solo los que normalizan al mismo telefono.
  const matches = contacts
    .filter((c) => c.id !== input.contactId)
    .filter((c) =>
      c.phones.some((raw) => normalizePhone(raw, config.defaultCountryCode) === phoneNormalized)
    )
    .sort((a, b) => compareContactIds(a.id, b.id));

  const rows: PhoneIndexRow[] = [];
  for (const contact of matches) {
    rows.push(
      await insertPhoneIndex({
        phoneNormalized,
        kommoContactId: contact.id,
        kommoLeadId: contact.leadIds[0] ?? null,
        source: "kommo_lookup",
      })
    );
  }

  if (rows.length > 0) {
    logger.info("kommo_lookup_found_unindexed_contacts", {
      phoneNormalized,
      contactId: input.contactId,
      foundContactIds: rows.map((r) => r.kommo_contact_id),
    });
  }
  return rows;
}

/**
 * Primer lead ABIERTO (no 142/143) del contacto ganador: el que tiene en
 * phone_index y, si no, los que Kommo tiene vinculados.
 */
async function findOpenWinnerLead(
  existing: PhoneIndexRow,
  newLeadId: string
): Promise<string | null> {
  const fromKommo = existing.kommo_contact_id
    ? await getContactLeadIds(existing.kommo_contact_id)
    : [];
  const candidates = [...new Set([existing.kommo_lead_id, ...fromKommo])]
    .filter((id): id is string => !!id && id !== newLeadId)
    .slice(0, MAX_WINNER_LEADS_TO_CHECK);

  for (const leadId of candidates) {
    const lead = await getLead(leadId);
    if (lead.status_id !== CLOSED_WON_STATUS_ID && lead.status_id !== CLOSED_LOST_STATUS_ID) {
      return leadId;
    }
  }
  return null;
}
