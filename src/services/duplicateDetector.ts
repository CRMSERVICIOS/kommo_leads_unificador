import { config } from "../config";
import { logger } from "../logger";
import { normalizePhone } from "./phoneNormalizer";
import { findContactsByPhoneQuery, getContactLeadIds, getLead } from "./kommoClient";
import {
  DUPLICATES_PIPELINE_ID,
  DUPLICATES_STATUS_ID,
  resolveWinner,
  unifyDuplicate,
} from "./duplicateUnifier";
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
 *    `duplicate_detections` (pending_review; ahi existing_* = el lado ya
 *    indexado y new_* = el del evento, sin importar quien gana) y se
 *    resuelve automaticamente con unifyDuplicate() -- ver `autoUnify` para
 *    quien gana y cuando se deja pendiente.
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

    let indexedRows = await findByPhone(normalized);
    if (indexedRows.length === 0) {
      indexedRows = await indexUnseenContactsFromKommo(normalized, input);
    }
    // Se compara contra el contacto indexado mas reciente (id de Kommo mas
    // alto): despues de una fusion es el ganador vigente.
    const conflicting = indexedRows
      .filter((row) => belongsToDifferentEntity(row, input.contactId, input.leadId))
      .sort((a, b) => compareIdsDesc(a.kommo_contact_id, b.kommo_contact_id));

    const indexed = await findFirstNotYetMerged(conflicting, indexedRows, input, normalized);

    if (indexed) {
      const alreadyRecorded = await findExistingPendingDetection(
        normalized,
        input.contactId,
        input.leadId
      );

      if (!alreadyRecorded) {
        const detection = await insertDuplicateDetection({
          phoneNormalized: normalized,
          existingContactId: indexed.kommo_contact_id,
          existingLeadId: indexed.kommo_lead_id,
          newContactId: input.contactId,
          newLeadId: input.leadId,
          notes: `Detectado via webhook de ${input.entityType} (fuente: ${input.source})`,
        });

        duplicatesDetected += 1;

        const pendingReason = await autoUnify(input, indexed, normalized);
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
        indexedContactId: row.kommo_contact_id,
        incomingContactId: input.contactId,
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

/**
 * Tope de leads del contacto indexado que se consultan. Si tiene mas, queda
 * para revision manual: con un corte arbitrario se podria elegir mal cual
 * es su lead abierto.
 */
const MAX_INDEXED_LEADS_TO_CHECK = 10;

/**
 * Resuelve automaticamente un duplicado recien registrado. Gana el lado con
 * ids de contacto y de lead MAS ALTOS (el mas reciente), venga del indice o
 * del evento; el perdedor se vincula al contacto ganador y va al embudo
 * Duplicados (ver unifyDuplicate). Siempre loguea la decision explicita
 * ("Ganador: ... Perdedor: ...") o el motivo de la revision manual, con los
 * ids de ambos lados. Deja la deteccion en pending_review (para revision
 * manual, sin reintentos) cuando:
 *  - DRY_RUN=true (freno de emergencia: decide y loguea, sin escribir).
 *  - el evento no trae exactamente UN lead del contacto (ej: eventos
 *    "unsorted", cuyo lead todavia no fue aceptado, o contactos con varios
 *    leads: no sabemos cual comparar).
 *  - el contacto indexado no tiene exactamente un lead abierto (ninguno:
 *    cliente que vuelve; varios: no sabemos cual comparar).
 *  - el contacto y el lead no coinciden en cual lado es mas nuevo.
 *  - el lead perdedor ya esta cerrado (142/143) o en Duplicados.
 *  - falla cualquier paso de unifyDuplicate (que ya loguea el detalle).
 *
 * Devuelve el motivo por el que quedo pendiente, o null si se resolvio.
 */
async function autoUnify(
  input: ProcessIncomingEntityInput,
  indexed: PhoneIndexRow,
  phoneNormalized: string
): Promise<string | null> {
  const indexedContactId = indexed.kommo_contact_id;
  const incomingContactId = input.contactId;
  const incomingLeadIds = input.linkedLeadIds ?? [];
  const dryRun = config.dryRun;
  const prefix = dryRun ? "[DRY RUN] " : "";
  const detectedVia = indexed.source === "kommo_lookup" ? "fallback_kommo" : "indice_local";
  const detectedViaText = detectedVia === "fallback_kommo" ? "fallback a la API de Kommo" : "indice local";

  // Que se sabe del lead del lado indexado: el de phone_index hasta que se
  // consultan sus leads abiertos en Kommo.
  let indexedLeadsText = `lead en indice ${indexed.kommo_lead_id ?? "-"}`;
  let indexedLeadIds: string[] = indexed.kommo_lead_id ? [indexed.kommo_lead_id] : [];

  const baseFields = () => ({
    dryRun,
    detectedVia,
    phoneNormalized,
    indexedContactId,
    indexedLeadIds,
    incomingContactId,
    incomingLeadIds,
  });

  /** Log explicito de por que queda en revision manual, con los ids de ambos lados. */
  const pending = (reason: string, level: "warn" | "error" = "warn", extra: Record<string, unknown> = {}): string => {
    logger[level](
      `${prefix}Revision manual (pending_review): ${reason}. ` +
        `Lado indexado: contacto ${indexedContactId ?? "-"} / ${indexedLeadsText}. ` +
        `Lado del evento: contacto ${incomingContactId ?? "-"} / lead(s) ${incomingLeadIds.join(", ") || "-"}. ` +
        `Telefono ${phoneNormalized}, detectado via ${detectedViaText}. No se mueve nada.`,
      { event: "duplicate_pending_review", reason, ...baseFields(), ...extra }
    );
    return reason;
  };

  if (!indexedContactId || !incomingContactId) {
    return pending("falta el contacto indexado o el del evento");
  }
  if (incomingLeadIds.length !== 1) {
    return pending(
      incomingLeadIds.length === 0
        ? "el evento no trae lead del contacto (ej: unsorted)"
        : "el contacto del evento tiene varios leads vinculados"
    );
  }
  const incoming = { contactId: incomingContactId, leadId: incomingLeadIds[0] };

  try {
    // Solo lecturas a Kommo: corren tambien con DRY_RUN=true para poder
    // loguear la decision real.
    const indexedOpenLeads = await findOpenLeadsOf(indexed, incomingLeadIds);
    if (indexedOpenLeads === null) {
      return pending("el contacto indexado tiene demasiados leads, revisar a mano");
    }
    indexedLeadIds = indexedOpenLeads;
    indexedLeadsText = `lead(s) abierto(s) ${indexedOpenLeads.join(", ") || "ninguno"}`;
    if (indexedOpenLeads.length !== 1) {
      return pending(
        indexedOpenLeads.length === 0
          ? "el contacto indexado no tiene leads abiertos"
          : "el contacto indexado tiene varios leads abiertos"
      );
    }

    const pair = resolveWinner(incoming, { contactId: indexedContactId, leadId: indexedOpenLeads[0] });
    if (!pair) {
      return pending("los ids de contacto y de lead no coinciden en cual es mas nuevo, revisar a mano");
    }
    // El lead indexado ya se filtro por abierto; el del evento se verifica
    // solo si es el que se va a mover.
    if (pair.loser === incoming && !isOpenLead(await getLead(incoming.leadId))) {
      return pending("el lead perdedor ya esta cerrado o en Duplicados");
    }

    const { winner, loser } = pair;
    logger.info(
      `${prefix}Ganador: lead ${winner.leadId} / contacto ${winner.contactId} (queda intacto). ` +
        `Perdedor: lead ${loser.leadId} / contacto ${loser.contactId} -> ` +
        `${dryRun ? "se moveria" : "se mueve"} a pipeline ${DUPLICATES_PIPELINE_ID} status ${DUPLICATES_STATUS_ID} ` +
        `y queda vinculado al contacto ${winner.contactId} como principal. ` +
        `Telefono ${phoneNormalized}, detectado via ${detectedViaText}. ` +
        (dryRun ? "No se ejecuta (DRY_RUN=true)." : "Se ejecuta."),
      {
        event: "duplicate_decision",
        dryRun,
        detectedVia,
        phoneNormalized,
        winnerLeadId: winner.leadId,
        winnerContactId: winner.contactId,
        loserLeadId: loser.leadId,
        loserContactId: loser.contactId,
        targetPipelineId: DUPLICATES_PIPELINE_ID,
        targetStatusId: DUPLICATES_STATUS_ID,
      }
    );

    if (dryRun) return "DRY_RUN=true";

    const result = await unifyDuplicate({
      winnerContactId: winner.contactId,
      winnerLeadId: winner.leadId,
      loserContactId: loser.contactId,
      loserLeadId: loser.leadId,
    });

    if (!result.ok) {
      const failed = result.steps.find((s) => s.status === "failed");
      return pending(
        `fallo la fusion en el paso ${failed?.step ?? "?"}: ${failed?.error ?? "sin detalle"}`,
        "error",
        { steps: result.steps.map((s) => ({ step: s.step, status: s.status, error: s.error })) }
      );
    }
    return null;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return pending(`fallo la fusion: ${error}`, "error");
  }
}

/** Orden descendente por id numerico de Kommo (el mas reciente primero; no numericos al final). */
function compareIdsDesc(a: string | null, b: string | null): number {
  const na = a != null && /^\d+$/.test(a) ? Number(a) : Number.NEGATIVE_INFINITY;
  const nb = b != null && /^\d+$/.test(b) ? Number(b) : Number.NEGATIVE_INFINITY;
  if (na === nb) return 0;
  return na > nb ? -1 : 1;
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
    .sort((a, b) => compareIdsDesc(a.id, b.id));

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

/** Etapas de sistema de Kommo, iguales en todos los embudos. */
const CLOSED_WON_STATUS_ID = 142;
const CLOSED_LOST_STATUS_ID = 143;

/**
 * Abierto = no cerrado (142/143) y no movido ya al embudo Duplicados (un
 * perdedor anterior sigue vinculado a su contacto original como secundario).
 */
function isOpenLead(lead: { pipeline_id: number; status_id: number }): boolean {
  return (
    lead.status_id !== CLOSED_WON_STATUS_ID &&
    lead.status_id !== CLOSED_LOST_STATUS_ID &&
    lead.pipeline_id !== DUPLICATES_PIPELINE_ID
  );
}

/**
 * Leads abiertos del contacto indexado: el que tiene en phone_index y los
 * que Kommo tiene vinculados, sin los del evento. null si son demasiados
 * para revisarlos todos.
 */
async function findOpenLeadsOf(
  indexed: PhoneIndexRow,
  excludeLeadIds: string[]
): Promise<string[] | null> {
  const fromKommo = indexed.kommo_contact_id
    ? await getContactLeadIds(indexed.kommo_contact_id)
    : [];
  const candidates = [...new Set([indexed.kommo_lead_id, ...fromKommo])].filter(
    (id): id is string => !!id && !excludeLeadIds.includes(id)
  );
  if (candidates.length > MAX_INDEXED_LEADS_TO_CHECK) return null;

  const open: string[] = [];
  for (const leadId of candidates) {
    if (isOpenLead(await getLead(leadId))) open.push(leadId);
  }
  return open;
}
