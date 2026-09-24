import { markDetectionsMergedForContacts } from "../db/duplicateDetections";
import { logger } from "../logger";
import { linkContactToLead, moveLeadToStage } from "./kommoClient";

/** Embudo "Duplicados" de la cuenta rudas, a donde va el lead perdedor. */
export const DUPLICATES_PIPELINE_ID = 14517971;

/**
 * Etapa del embudo Duplicados donde cae el lead perdedor: "Contacto inicial".
 * Leido con GET /leads/pipelines/14517971 (2026-09-24). La primera etapa del
 * embudo es "Leads Entrantes" (112145355), pero es type 1: la etapa de
 * entrantes/unsorted, a la que no se puede mover un lead existente. Esta es
 * la primera etapa comun (type 0, sort 20).
 */
export const DUPLICATES_STATUS_ID = 112145359;

/** Un lado del duplicado: un contacto y el lead suyo que se compara. */
export interface DuplicateSide {
  contactId: string;
  leadId: string;
}

export interface WinnerLoser {
  winner: DuplicateSide;
  loser: DuplicateSide;
}

const NUMERIC_ID = /^\d+$/;

/**
 * Regla de quien gana: el lado con ids MAS ALTOS (en Kommo los ids son
 * secuenciales, el mas alto es el mas reciente). Devuelve null si no se
 * puede decidir sin ambiguedad: ids no numericos, iguales, o el contacto y
 * el lead de un mismo lado no coinciden en cual es mas nuevo.
 */
export function resolveWinner(a: DuplicateSide, b: DuplicateSide): WinnerLoser | null {
  const ids = [a.contactId, a.leadId, b.contactId, b.leadId];
  if (!ids.every((id) => NUMERIC_ID.test(id))) return null;

  const contactCmp = Math.sign(Number(a.contactId) - Number(b.contactId));
  const leadCmp = Math.sign(Number(a.leadId) - Number(b.leadId));
  if (contactCmp === 0 || contactCmp !== leadCmp) return null;

  return contactCmp > 0 ? { winner: a, loser: b } : { winner: b, loser: a };
}

export interface UnifyDuplicateInput {
  /** Contacto ganador (ids mas altos). No se toca. */
  winnerContactId: string;
  /** Lead ganador. No se toca; solo va a los logs. */
  winnerLeadId: string | null;
  /** Contacto perdedor. No se toca ni se desvincula: queda como secundario del lead perdedor. */
  loserContactId: string;
  /** Lead perdedor: se vincula al contacto ganador y se mueve al embudo Duplicados. */
  loserLeadId: string;
}

export interface UnifyDuplicateOptions {
  /** Si es true, loguea que haria cada paso pero no llama a Kommo. */
  dryRun?: boolean;
}

export type UnifyStepName = "link_loser_lead_to_winner_contact" | "move_loser_lead_to_duplicates";

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

/**
 * Resuelve un duplicado. El lead/contacto ganador queda exactamente como
 * esta. Sobre el lead perdedor:
 *  1. Vincula el contacto ganador como contacto principal. Su contacto
 *     original NO se desvincula: queda como secundario, asi la conversacion
 *     de WhatsApp vieja sigue accesible.
 *  2. Lo mueve al embudo Duplicados (DUPLICATES_PIPELINE_ID /
 *     DUPLICATES_STATUS_ID).
 *
 * Si falla la vinculacion no se mueve el lead: quedaria en Duplicados sin
 * colgar del contacto ganador.
 */
export async function unifyDuplicate(
  input: UnifyDuplicateInput,
  options: UnifyDuplicateOptions = {}
): Promise<UnifyDuplicateResult> {
  const dryRun = options.dryRun ?? false;
  const steps: UnifyStepResult[] = [];

  logger.info("unify_duplicate_started", { ...input, dryRun });

  const linkStep = await runStep(
    "link_loser_lead_to_winner_contact",
    {
      method: "POST",
      path: `/leads/${input.loserLeadId}/link`,
      body: [
        {
          to_entity_id: Number(input.winnerContactId),
          to_entity_type: "contacts",
          metadata: { is_main: true },
        },
      ],
    },
    dryRun,
    () => linkContactToLead(input.loserLeadId, input.winnerContactId, { isMain: true })
  );
  steps.push(linkStep);

  if (linkStep.status === "failed") {
    steps.push({
      step: "move_loser_lead_to_duplicates",
      status: "skipped",
      reason: "fallo la vinculacion del lead perdedor",
    });
    return finish(input, dryRun, steps);
  }

  steps.push(
    await runStep(
      "move_loser_lead_to_duplicates",
      {
        method: "PATCH",
        path: `/leads/${input.loserLeadId}`,
        body: { pipeline_id: DUPLICATES_PIPELINE_ID, status_id: DUPLICATES_STATUS_ID },
      },
      dryRun,
      () => moveLeadToStage(input.loserLeadId, DUPLICATES_PIPELINE_ID, DUPLICATES_STATUS_ID)
    )
  );

  return finish(input, dryRun, steps);
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
      input.winnerContactId,
      input.loserContactId
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
