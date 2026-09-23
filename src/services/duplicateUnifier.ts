import { markDetectionsMergedForContacts } from "../db/duplicateDetections";
import { logger } from "../logger";
import {
  addTagsToEntity,
  createNote,
  getLead,
  linkContactToLead,
  updateLeadStatus,
} from "./kommoClient";

export const MERGED_TAG_NAME = "duplicado-fusionado";

/**
 * Etapa de sistema "Cerrado - perdido". Confirmado en la doc de Kommo ("Each
 * Pipeline has 3 system Stage: ... Closed – Lost (ID = 143)") y contra la
 * cuenta rudas: los 16 embudos la tienen, no editable.
 */
export const CLOSED_LOST_STATUS_ID = 143;

/** Etapa de sistema "Cerrado - ganado" (misma fuente que la de arriba). */
export const CLOSED_WON_STATUS_ID = 142;

export interface UnifyDuplicateInput {
  /** Contacto ganador: el que ya estaba en phone_index antes. */
  existingContactId: string;
  /** Lead del contacto ganador, si se conoce (recibe una nota informativa). */
  existingLeadId: string | null;
  /** Contacto perdedor. NO se borra, archiva ni desvincula en esta version. */
  newContactId: string;
  /** Lead nuevo (perdedor): se vincula al contacto ganador, se marca y se cierra como perdido. */
  newLeadId: string;
}

export interface UnifyDuplicateOptions {
  /** Si es true, loguea que haria cada paso pero no llama a Kommo. */
  dryRun?: boolean;
  /** Motivo de perdida para el cierre del lead nuevo (ej: "Dato duplicado"). */
  lossReasonId?: number | null;
}

export type UnifyStepName =
  | "link_new_lead_to_existing_contact"
  | "note_on_new_lead"
  | "tag_new_lead"
  | "note_on_existing_lead"
  | "close_new_lead";

export interface UnifyStepResult {
  step: UnifyStepName;
  status: "ok" | "failed" | "skipped" | "dry_run";
  request?: { method: string; path: string; body: unknown };
  response?: unknown;
  error?: string;
  reason?: string;
}

export interface UnifyDuplicateResult {
  ok: boolean;
  dryRun: boolean;
  steps: UnifyStepResult[];
  /** Filas pending_review de duplicate_detections pasadas a reviewed_merged. */
  detectionsMarkedMerged: number;
}

export function buildNewLeadNote(input: UnifyDuplicateInput): string {
  return (
    `[DUPLICADO] Posible duplicado vinculado automáticamente con el contacto #${input.existingContactId} ` +
    `(mismo teléfono). Verificar.`
  );
}

export function buildExistingLeadNote(input: UnifyDuplicateInput): string {
  return (
    `[DUPLICADO] Se vinculó a este contacto (#${input.existingContactId}) el lead #${input.newLeadId}, ` +
    `que era un duplicado por mismo teléfono (venía del contacto #${input.newContactId}). Verificar.`
  );
}

/**
 * Fusion (Fase 2, primera version, disparo manual): el ganador es siempre el
 * contacto/lead EXISTENTE.
 *
 * Pasos:
 *  1. Vincula el lead nuevo al contacto ganador, como contacto principal.
 *  2. Nota + tag "duplicado-fusionado" en el lead nuevo.
 *  3. Nota en el lead ganador (si se conoce).
 *  4. Cierra el lead nuevo como perdido (etapa 143), en su mismo embudo, con
 *     el motivo de perdida `lossReasonId` si se pasa.
 *
 * A proposito NO hace: borrar o archivar el contacto perdedor, ni
 * desvincular el contacto perdedor del lead nuevo (la conversacion de
 * WhatsApp vive en ese contacto; se mantiene vinculado hasta confirmar que no
 * se pierde nada).
 *
 * Si falla la vinculacion (paso 1) no se marca nada: una nota diciendo
 * "vinculado" seria falsa. Los pasos 2 y 3 son independientes entre si. El
 * cierre (paso 4) solo corre si todos los anteriores salieron bien: no se
 * cierra un lead sin la nota/tag que explican por que.
 */
export async function unifyDuplicate(
  input: UnifyDuplicateInput,
  options: UnifyDuplicateOptions = {}
): Promise<UnifyDuplicateResult> {
  const dryRun = options.dryRun ?? false;
  const steps: UnifyStepResult[] = [];

  logger.info("unify_duplicate_started", { ...input, dryRun });

  const linkStep = await runStep(
    "link_new_lead_to_existing_contact",
    {
      method: "POST",
      path: `/leads/${input.newLeadId}/link`,
      body: [
        {
          to_entity_id: Number(input.existingContactId),
          to_entity_type: "contacts",
          metadata: { is_main: true },
        },
      ],
    },
    dryRun,
    () => linkContactToLead(input.newLeadId, input.existingContactId, { isMain: true })
  );
  steps.push(linkStep);

  if (linkStep.status === "failed") {
    for (const step of ["note_on_new_lead", "tag_new_lead", "note_on_existing_lead", "close_new_lead"] as const) {
      steps.push({ step, status: "skipped", reason: "fallo la vinculacion del lead nuevo" });
    }
    return finish(input, dryRun, steps);
  }

  const newLeadNote = buildNewLeadNote(input);
  steps.push(
    await runStep(
      "note_on_new_lead",
      {
        method: "POST",
        path: "/leads/notes",
        body: [{ entity_id: Number(input.newLeadId), note_type: "common", params: { text: newLeadNote } }],
      },
      dryRun,
      () => createNote("leads", input.newLeadId, newLeadNote)
    )
  );

  steps.push(
    await runStep(
      "tag_new_lead",
      {
        method: "PATCH",
        path: `/leads/${input.newLeadId}`,
        body: { tags_to_add: [{ name: MERGED_TAG_NAME }] },
      },
      dryRun,
      () => addTagsToEntity("leads", input.newLeadId, [MERGED_TAG_NAME])
    )
  );

  if (input.existingLeadId) {
    const existingLeadId = input.existingLeadId;
    const existingLeadNote = buildExistingLeadNote(input);
    steps.push(
      await runStep(
        "note_on_existing_lead",
        {
          method: "POST",
          path: "/leads/notes",
          body: [{ entity_id: Number(existingLeadId), note_type: "common", params: { text: existingLeadNote } }],
        },
        dryRun,
        () => createNote("leads", existingLeadId, existingLeadNote)
      )
    );
  } else {
    const skipped: UnifyStepResult = {
      step: "note_on_existing_lead",
      status: "skipped",
      reason: "existingLeadId no informado",
    };
    logger.info("unify_step_skipped", { step: skipped.step, reason: skipped.reason });
    steps.push(skipped);
  }

  if (steps.some((s) => s.status === "failed")) {
    steps.push({ step: "close_new_lead", status: "skipped", reason: "fallo un paso anterior" });
    return finish(input, dryRun, steps);
  }

  steps.push(await closeNewLead(input.newLeadId, options.lossReasonId ?? null, dryRun));

  return finish(input, dryRun, steps);
}

/**
 * Lee el lead para saber su embudo actual (lectura, corre tambien en dryRun
 * para que la vista previa muestre el request real) y lo mueve a 143.
 */
async function closeNewLead(
  newLeadId: string,
  lossReasonId: number | null,
  dryRun: boolean
): Promise<UnifyStepResult> {
  let pipelineId: number;
  try {
    const lead = await getLead(newLeadId);
    pipelineId = lead.pipeline_id;
    logger.info("unify_close_lead_current_state", {
      leadId: newLeadId,
      pipelineId: lead.pipeline_id,
      statusId: lead.status_id,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("unify_step_failed", { step: "close_new_lead", error, phase: "get_lead" });
    return { step: "close_new_lead", status: "failed", error };
  }

  return runStep(
    "close_new_lead",
    {
      method: "PATCH",
      path: `/leads/${newLeadId}`,
      body: {
        pipeline_id: pipelineId,
        status_id: CLOSED_LOST_STATUS_ID,
        ...(lossReasonId ? { loss_reason_id: lossReasonId } : {}),
      },
    },
    dryRun,
    () => updateLeadStatus(newLeadId, pipelineId, CLOSED_LOST_STATUS_ID, lossReasonId)
  );
}

async function runStep(
  step: UnifyStepName,
  request: { method: string; path: string; body: unknown },
  dryRun: boolean,
  call: () => Promise<unknown>
): Promise<UnifyStepResult> {
  if (dryRun) {
    logger.info("unify_step_dry_run", { step, request });
    return { step, status: "dry_run", request };
  }

  logger.info("unify_step_request", { step, request });

  try {
    const response = await call();
    logger.info("unify_step_ok", { step, response: response ?? null });
    return { step, status: "ok", request, response };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error("unify_step_failed", { step, request, error });
    return { step, status: "failed", request, error };
  }
}

async function finish(
  input: UnifyDuplicateInput,
  dryRun: boolean,
  steps: UnifyStepResult[]
): Promise<UnifyDuplicateResult> {
  const ok = steps.every((s) => s.status !== "failed");

  let detectionsMarkedMerged = 0;
  if (ok && !dryRun) {
    detectionsMarkedMerged = await markDetectionsMergedForContacts(
      input.existingContactId,
      input.newContactId
    );
  }

  logger.info("unify_duplicate_finished", {
    ...input,
    dryRun,
    ok,
    detectionsMarkedMerged,
    steps: steps.map((s) => ({ step: s.step, status: s.status })),
  });
  return { ok, dryRun, steps, detectionsMarkedMerged };
}
