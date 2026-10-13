import { config } from "../config";
import { closeDb, getPool, runMigrations } from "../db";
import { appendDetectionNote, type DuplicateDetectionRow } from "../db/duplicateDetections";
import { logger } from "../logger";
import { getLead } from "../services/kommoClient";
import {
  DUPLICATES_PIPELINE_ID,
  resolveWinner,
  unifyDuplicate,
  type DuplicateSide,
} from "../services/duplicateUnifier";

/** ms entre pares de operaciones de Kommo: ~1.5 req/s, bajo el límite probable. */
const DELAY_BETWEEN_MS = 650;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type ReconcileOutcome =
  | "merged"
  | "dry_run"
  | "skipped_null_ids"
  | "skipped_no_winner"
  | "skipped_loser_closed_or_dup"
  | "skipped_winner_closed_or_dup"
  | "failed";

export interface ReconcileDetectionResult {
  id: number;
  outcome: ReconcileOutcome;
  detail?: string;
}

const CLOSED_WON_STATUS_ID = 142;
const CLOSED_LOST_STATUS_ID = 143;

function isClosedOrDuplicate(lead: { pipeline_id: number; status_id: number }): boolean {
  return (
    lead.status_id === CLOSED_WON_STATUS_ID ||
    lead.status_id === CLOSED_LOST_STATUS_ID ||
    lead.pipeline_id === DUPLICATES_PIPELINE_ID
  );
}

/**
 * Procesa una detección pendiente: verifica el estado actual de ambos leads,
 * recalcula ganador/perdedor con `resolveWinner`, y llama a `unifyDuplicate`.
 * Reutiliza exactamente las mismas reglas que el flujo normal (sin reimplementar
 * nada). Distinguible del flujo normal por la nota "reconciled_by_script" en DB.
 */
export async function reconcileDetection(
  detection: DuplicateDetectionRow,
  dryRun: boolean
): Promise<ReconcileDetectionResult> {
  const id = detection.id;

  // Los campos existing_*/new_* identifican los dos lados — NO implican quién gana.
  const sideA: Partial<DuplicateSide> = {
    contactId: detection.existing_contact_id ?? undefined,
    leadId: detection.existing_lead_id ?? undefined,
  };
  const sideB: Partial<DuplicateSide> = {
    contactId: detection.new_contact_id ?? undefined,
    leadId: detection.new_lead_id ?? undefined,
  };

  if (!sideA.contactId || !sideA.leadId || !sideB.contactId || !sideB.leadId) {
    return { id, outcome: "skipped_null_ids", detail: "uno o más IDs son null" };
  }

  const a = sideA as DuplicateSide;
  const b = sideB as DuplicateSide;

  // Verificar estado actual de ambos leads en Kommo antes de decidir.
  let leadA: { pipeline_id: number; status_id: number };
  let leadB: { pipeline_id: number; status_id: number };

  try {
    [leadA, leadB] = await Promise.all([getLead(a.leadId), getLead(b.leadId)]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("reconcile_fetch_lead_failed", { detectionId: id, detail });
    return { id, outcome: "failed", detail };
  }

  // Si alguno ya se movió a Duplicados o está cerrado, probablemente ya fue
  // procesado por otro camino. Determinar cuál es y devolver skip informado.
  const aClosedOrDup = isClosedOrDuplicate(leadA);
  const bClosedOrDup = isClosedOrDuplicate(leadB);

  if (aClosedOrDup && bClosedOrDup) {
    return {
      id,
      outcome: "skipped_loser_closed_or_dup",
      detail: "ambos leads ya están cerrados o en Duplicados",
    };
  }

  const pair = resolveWinner(a, b);
  if (!pair) {
    return {
      id,
      outcome: "skipped_no_winner",
      detail: "resolveWinner no pudo determinar ganador/perdedor",
    };
  }

  const loserLead = pair.loser.leadId === a.leadId ? leadA : leadB;
  const winnerLead = pair.winner.leadId === a.leadId ? leadA : leadB;

  if (isClosedOrDuplicate(loserLead)) {
    return {
      id,
      outcome: "skipped_loser_closed_or_dup",
      detail: `lead perdedor ${pair.loser.leadId} ya está cerrado (status=${loserLead.status_id}) o en Duplicados`,
    };
  }

  if (isClosedOrDuplicate(winnerLead)) {
    return {
      id,
      outcome: "skipped_winner_closed_or_dup",
      detail: `lead ganador ${pair.winner.leadId} ya está cerrado (status=${winnerLead.status_id}) o en Duplicados`,
    };
  }

  logger.info("reconcile_decision", {
    detectionId: id,
    dryRun,
    winnerContactId: pair.winner.contactId,
    winnerLeadId: pair.winner.leadId,
    loserContactId: pair.loser.contactId,
    loserLeadId: pair.loser.leadId,
  });

  if (dryRun) {
    return { id, outcome: "dry_run", detail: `ganador=${pair.winner.leadId} perdedor=${pair.loser.leadId}` };
  }

  // Marcar la nota ANTES de llamar a unify para que quede registrado aunque falle.
  const scriptNote = `reconciled_by_script: ${new Date().toISOString()}`;
  await appendDetectionNote(id, scriptNote).catch((err) => {
    logger.warn("reconcile_note_append_failed", {
      detectionId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  const result = await unifyDuplicate({
    winnerContactId: pair.winner.contactId,
    winnerLeadId: pair.winner.leadId,
    loserContactId: pair.loser.contactId,
    loserLeadId: pair.loser.leadId,
  });

  if (!result.ok) {
    const failed = result.steps.find((s) => s.status === "failed");
    const detail = `unify falló en paso ${failed?.step ?? "?"}: ${failed?.error ?? "sin detalle"}`;
    logger.error("reconcile_unify_failed", { detectionId: id, detail });
    return { id, outcome: "failed", detail };
  }

  return { id, outcome: "merged" };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  logger.info("reconcile_started", { dryRun, defaultCountryCode: config.defaultCountryCode });

  const result = await getPool().query<DuplicateDetectionRow>(
    `SELECT * FROM duplicate_detections
     WHERE status = 'pending_review'
       AND notes LIKE '%403%'
     ORDER BY id`
  );

  const detections = result.rows;
  logger.info("reconcile_candidates", { total: detections.length, dryRun });

  if (detections.length === 0) {
    logger.info("reconcile_nothing_to_do");
    return;
  }

  // Resumen previo en dry-run: muestra IDs y lados antes de ejecutar.
  if (dryRun) {
    console.log("\n--- DRY RUN: candidates ---");
    for (const d of detections) {
      console.log(
        `  id=${d.id}  existing=${d.existing_contact_id}/${d.existing_lead_id}` +
          `  new=${d.new_contact_id}/${d.new_lead_id}  phone=${d.phone_normalized}`
      );
    }
    console.log("---\n");
  }

  const counts: Record<ReconcileOutcome, number> = {
    merged: 0,
    dry_run: 0,
    skipped_null_ids: 0,
    skipped_no_winner: 0,
    skipped_loser_closed_or_dup: 0,
    skipped_winner_closed_or_dup: 0,
    failed: 0,
  };

  for (let i = 0; i < detections.length; i++) {
    if (i > 0) await sleep(DELAY_BETWEEN_MS);

    const detection = detections[i];
    const res = await reconcileDetection(detection, dryRun);
    counts[res.outcome] += 1;

    logger.info("reconcile_detection_result", {
      detectionId: res.id,
      outcome: res.outcome,
      detail: res.detail,
      progress: `${i + 1}/${detections.length}`,
    });
  }

  logger.info("reconcile_finished", { dryRun, ...counts });
  console.log("\nFinalizado:", counts);
}

// `npm run reconcile-detections [-- --dry-run]`
if (require.main === module) {
  runMigrations()
    .then(() => main())
    .then(() => closeDb())
    .catch(async (err) => {
      logger.error("reconcile_fatal", { error: err instanceof Error ? err.message : String(err) });
      await closeDb();
      process.exit(1);
    });
}
