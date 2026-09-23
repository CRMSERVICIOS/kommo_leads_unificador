import { config } from "../config";
import { logger } from "../logger";
import { normalizePhone } from "./phoneNormalizer";
import { notifyDuplicateDetected } from "./notifier";
import { addNote, addTag } from "./kommoClient";
import {
  belongsToDifferentEntity,
  findByPhone,
  insertPhoneIndex,
} from "../db/phoneIndex";
import {
  findExistingPendingDetection,
  insertDuplicateDetection,
} from "../db/duplicateDetections";
import { buildEventKey, markEventProcessedIfNew } from "../db/webhookEvents";
import type { LeadSource } from "../types/kommo";

export const DUPLICATE_TAG_NAME = "duplicado-potencial";

export interface ProcessIncomingEntityInput {
  /** 'lead' o 'contact': que tipo de entidad disparo el webhook. */
  entityType: "lead" | "contact";
  /** id de la entidad en Kommo (el mismo que entityId de arriba, solo para logging). */
  entityId: string;
  /** contact_id asociado al evento, si se conoce. */
  contactId: string | null;
  /** lead_id asociado al evento, si se conoce. */
  leadId: string | null;
  /** telefonos crudos extraidos del payload (un contacto puede tener varios). */
  phonesRaw: string[];
  source: LeadSource;
  /** payload completo, usado solo para el hash de idempotencia. */
  rawPayload: unknown;
}

export interface ProcessIncomingEntityResult {
  skippedAsRetry: boolean;
  duplicatesDetected: number;
  phonesIndexed: number;
  phonesUnableToNormalize: number;
}

/**
 * Logica central de deteccion de duplicados (Fase 1: deteccion + aviso).
 *
 * Por cada telefono del payload:
 *  - Si no esta en `phone_index`: se indexa y no pasa nada mas.
 *  - Si esta en `phone_index` asociado a OTRO contacto/lead: se considera
 *    duplicado potencial -> nota en Kommo + tag opcional + notificacion +
 *    registro en `duplicate_detections` con estado `pending_review`.
 *
 * NO se fusiona nada automaticamente (fuera de alcance de Fase 1, ver TODOs
 * en el README).
 */
export async function processIncomingEntity(
  input: ProcessIncomingEntityInput
): Promise<ProcessIncomingEntityResult> {
  const eventKey = buildEventKey(input.entityType, input.entityId, input.rawPayload);
  const isNewEvent = markEventProcessedIfNew(eventKey);

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

    const existingRows = findByPhone(normalized);
    const conflicting = existingRows.filter((row) =>
      belongsToDifferentEntity(row, input.contactId, input.leadId)
    );

    if (conflicting.length > 0) {
      const existing = conflicting[0];

      const alreadyRecorded = findExistingPendingDetection(
        normalized,
        input.contactId,
        input.leadId
      );

      if (!alreadyRecorded) {
        insertDuplicateDetection({
          phoneNormalized: normalized,
          existingContactId: existing.kommo_contact_id,
          existingLeadId: existing.kommo_lead_id,
          newContactId: input.contactId,
          newLeadId: input.leadId,
          notes: `Detectado via webhook de ${input.entityType} (fuente: ${input.source})`,
        });

        duplicatesDetected += 1;

        await notifyDuplicateDetected({
          phoneNormalized: normalized,
          existingContactId: existing.kommo_contact_id,
          existingLeadId: existing.kommo_lead_id,
          newContactId: input.contactId,
          newLeadId: input.leadId,
          source: input.source,
        });

        await annotateKommoEntity(input, existing, normalized);
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
    insertPhoneIndex({
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

async function annotateKommoEntity(
  input: ProcessIncomingEntityInput,
  existing: { kommo_contact_id: string | null; kommo_lead_id: string | null },
  phoneNormalized: string
): Promise<void> {
  const noteText =
    `Posible duplicado de telefono con ` +
    `${existing.kommo_lead_id ? `lead #${existing.kommo_lead_id}` : `contacto #${existing.kommo_contact_id}`}. ` +
    `Fuente del nuevo registro: ${input.source}. Revisar manualmente antes de fusionar ` +
    `(este servicio no fusiona automaticamente en Fase 1).`;

  const targetEntityType: "leads" | "contacts" =
    input.entityType === "lead" ? "leads" : "contacts";
  const targetId = input.entityType === "lead" ? input.leadId : input.contactId;

  if (!targetId) {
    logger.warn("annotate_kommo_entity_skipped_no_id", { input });
    return;
  }

  const existingId = existing.kommo_lead_id ?? existing.kommo_contact_id;

  if (config.dryRun) {
    logger.info(
      `[DRY RUN] Duplicado detectado: telefono ${phoneNormalized} coincide con lead/contacto existente ${existingId}. ` +
        `Se agregaria nota + tag a ${targetId}, pero no se ejecuta (DRY_RUN=true).`,
      {
        phoneNormalized,
        existingContactId: existing.kommo_contact_id,
        existingLeadId: existing.kommo_lead_id,
        targetEntityType,
        targetId,
        tagName: DUPLICATE_TAG_NAME,
      }
    );
    return;
  }

  await addNote(targetEntityType, targetId, noteText);
  await addTag(targetEntityType, targetId, DUPLICATE_TAG_NAME);
}
