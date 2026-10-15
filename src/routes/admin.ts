import crypto from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { config } from "../config";
import { getPool } from "../db";
import { logger } from "../logger";
import { normalizePhone } from "../services/phoneNormalizer";
import { resolveWinner, unifyDuplicate } from "../services/duplicateUnifier";

const AUDIT_PIPELINE_ID = 14362171;
const KOMMO_BASE = () => `https://${config.kommoSubdomain}.kommo.com/api/v4`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function kommoGetAudit<T>(path: string): Promise<T | null> {
  const url = `${KOMMO_BASE()}${path}`;
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) await sleep(1000 * attempt);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.kommoLongLivedToken}` },
    });
    if (res.status === 204) return null;
    if ((res.status === 403 || res.status === 429 || res.status >= 500) && attempt < 3) {
      await res.text().catch(() => "");
      continue;
    }
    if (!res.ok) return null;
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  }
  return null;
}

export const adminRouter = Router();

/**
 * Proteccion simple por token: header `Authorization: Bearer <ADMIN_TOKEN>`.
 * Si ADMIN_TOKEN no esta configurado, las rutas de admin quedan deshabilitadas.
 */
export function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  if (!config.adminToken) {
    res.status(503).json({ error: "admin_disabled", reason: "ADMIN_TOKEN no configurado" });
    return;
  }

  const header = req.header("authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  const expected = Buffer.from(config.adminToken);
  const actual = Buffer.from(provided);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    logger.warn("admin_unauthorized", { path: req.path, ip: req.ip });
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  next();
}

adminRouter.use(requireAdminToken);

const ID_PATTERN = /^\d+$/;

function readId(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && ID_PATTERN.test(value.trim())) return value.trim();
  return null;
}

/**
 * POST /admin/unify-test
 * { winnerContactId, winnerLeadId, loserContactId, loserLeadId, dryRun? }
 *
 * Disparo MANUAL de la resolucion contra un caso puntual (la misma que el
 * detector corre automaticamente). Es independiente de DRY_RUN
 * del .env (que sigue gobernando solo al detector): llamar a este endpoint
 * escribe en Kommo, salvo que se mande `dryRun: true` en el body.
 * Rechaza el pedido si el ganador no es el de ids mas altos (misma regla
 * que el detector).
 */
adminRouter.post("/unify-test", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const fields = ["winnerContactId", "winnerLeadId", "loserContactId", "loserLeadId"] as const;
  const ids = Object.fromEntries(fields.map((f) => [f, readId(body[f])])) as Record<
    (typeof fields)[number],
    string | null
  >;

  const invalid = fields.filter((f) => !ids[f]);
  if (invalid.length > 0) {
    res.status(400).json({ error: "invalid_ids", fields: invalid });
    return;
  }

  const winner = { contactId: ids.winnerContactId!, leadId: ids.winnerLeadId! };
  const loser = { contactId: ids.loserContactId!, leadId: ids.loserLeadId! };
  if (resolveWinner(winner, loser)?.winner !== winner) {
    res.status(400).json({
      error: "invalid_winner",
      reason: "el ganador tiene que tener el id de contacto Y el id de lead mas altos que el perdedor",
    });
    return;
  }

  const result = await unifyDuplicate(
    {
      winnerContactId: winner.contactId,
      winnerLeadId: winner.leadId,
      loserContactId: loser.contactId,
      loserLeadId: loser.leadId,
    },
    { dryRun: body.dryRun === true || body.dryRun === "true" }
  );

  res.status(result.ok ? 200 : 502).json(result);
});

/**
 * GET /admin/audit-pipeline
 *
 * Auditoría de solo lectura de los leads actualmente en el pipeline 14362171,
 * etapa "Contacto inicial". Clasifica cada lead en:
 *   A1 — duplicado con bug 403 conocido (en duplicate_detections, pending_review con error 403)
 *   A2 — duplicado detectado con otro status
 *   A3 — duplicado NO detectado por el sistema (bug nuevo — prioridad máxima)
 *   B  — lead legítimo
 *   no_phone — sin teléfono normalizable
 *
 * No escribe nada en Kommo ni en la DB.
 */
adminRouter.get("/audit-pipeline", async (_req, res) => {
  logger.info("audit_pipeline_started", { pipelineId: AUDIT_PIPELINE_ID });

  try {
    // 1. Status id de "Contacto inicial"
    const stagesData = await kommoGetAudit<{
      _embedded?: { statuses?: Array<{ id: number; name: string }> };
    }>(`/leads/pipelines/${AUDIT_PIPELINE_ID}/statuses`);

    const statuses = stagesData?._embedded?.statuses ?? [];
    const contactoInicial = statuses.find((s) =>
      s.name.toLowerCase().includes("contacto inicial")
    );
    if (!contactoInicial) {
      res.status(502).json({
        error: "stage_not_found",
        available: statuses.map((s) => ({ id: s.id, name: s.name })),
      });
      return;
    }
    const statusId = contactoInicial.id;

    // 2. Todos los leads en esa etapa
    const leads: Array<{
      id: number;
      pipeline_id: number;
      status_id: number;
      created_at: number;
      _embedded?: { contacts?: Array<{ id: number; is_main?: boolean }> };
    }> = [];

    let page = 1;
    while (true) {
      const path =
        `/leads?filter[pipeline_id][0]=${AUDIT_PIPELINE_ID}&filter[status_id][0]=${statusId}` +
        `&with=contacts&limit=250&page=${page}`;
      const data = await kommoGetAudit<{
        _embedded?: { leads?: typeof leads };
        _links?: { next?: { href?: string } };
      }>(path);
      const batch = data?._embedded?.leads ?? [];
      leads.push(...batch);
      if (!data?._links?.next?.href || batch.length === 0) break;
      page++;
      await sleep(200);
    }

    // 3. Analizar cada lead
    type LeadGroup = "A1" | "A2" | "A3" | "B" | "no_phone";
    interface LeadResult {
      leadId: number;
      contactId: number | null;
      rawPhone: string | null;
      phoneNormalized: string | null;
      ageHours: number;
      createdAt: string;
      group: LeadGroup;
      notes: string;
      duplicateIndexEntries?: Array<{ contactId: string | null; leadId: string | null; source: string | null }>;
      detections?: Array<{ id: number; status: string; detectedAt: string; notes: string | null }>;
      webhookEvents?: string[];
    }

    const now = Date.now();
    const results: LeadResult[] = [];

    for (const lead of leads) {
      await sleep(150);
      const contactId =
        lead._embedded?.contacts?.find((c) => c.is_main)?.id ??
        lead._embedded?.contacts?.[0]?.id ??
        null;

      let rawPhone: string | null = null;
      if (contactId) {
        const cdata = await kommoGetAudit<{
          custom_fields_values?: Array<{ field_code?: string | null; values?: Array<{ value?: string }> }> | null;
        }>(`/contacts/${contactId}`);
        rawPhone =
          (cdata?.custom_fields_values ?? [])
            .filter((f) => f.field_code === "PHONE")
            .flatMap((f) => f.values ?? [])
            .map((v) => v.value)
            .find((v): v is string => !!v) ?? null;
      }

      const phoneNormalized = rawPhone ? normalizePhone(rawPhone) : null;
      const ageHours = (now - lead.created_at * 1000) / 3600000;

      if (!phoneNormalized) {
        results.push({
          leadId: lead.id,
          contactId,
          rawPhone,
          phoneNormalized: null,
          ageHours: Math.round(ageHours),
          createdAt: new Date(lead.created_at * 1000).toISOString().slice(0, 10),
          group: "no_phone",
          notes: `Sin teléfono normalizable (raw: "${rawPhone ?? ""}")`,
        });
        continue;
      }

      const [indexRows, detectionRows, webhookRows] = await Promise.all([
        getPool()
          .query<{ kommo_contact_id: string | null; kommo_lead_id: string | null; source: string | null }>(
            `SELECT kommo_contact_id, kommo_lead_id, source FROM phone_index WHERE phone_normalized = $1`,
            [phoneNormalized]
          )
          .then((r) => r.rows),
        getPool()
          .query<{ id: number; status: string; detected_at: Date; notes: string | null }>(
            `SELECT id, status, detected_at, notes FROM duplicate_detections WHERE phone_normalized = $1 ORDER BY detected_at DESC`,
            [phoneNormalized]
          )
          .then((r) => r.rows),
        getPool()
          .query<{ event_key: string }>(
            `SELECT event_key FROM processed_webhook_events WHERE event_key LIKE $1 ORDER BY processed_at DESC LIMIT 10`,
            [`%:${lead.id}:%`]
          )
          .then((r) => r.rows.map((row) => row.event_key)),
      ]);

      const otherIndexEntries = indexRows.filter(
        (row) =>
          row.kommo_contact_id !== String(contactId) &&
          row.kommo_lead_id !== String(lead.id)
      );

      let group: LeadGroup;
      let notes: string;

      if (otherIndexEntries.length === 0) {
        group = "B";
        notes =
          ageHours > 72
            ? `Lead legítimo sin duplicado en phone_index. ATENCIÓN: lleva ${Math.round(ageHours)}h en esta etapa.`
            : "Lead legítimo, sin duplicado conocido.";
      } else if (detectionRows.length === 0) {
        group = "A3";
        notes = `DUPLICADO NO DETECTADO — ${otherIndexEntries.length} entrada(s) en phone_index para otros contactos/leads, pero CERO filas en duplicate_detections.`;
      } else {
        const has403 = detectionRows.some((d) => d.notes?.includes("403"));
        const hasPending = detectionRows.some((d) => d.status === "pending_review");
        if (has403 && hasPending) {
          group = "A1";
          notes = `Duplicado conocido, fallo de fusión por 403 (bug activo). ${detectionRows.length} detección(es).`;
        } else {
          group = "A2";
          const statStr = [...new Set(detectionRows.map((d) => d.status))].join(", ");
          notes = `Duplicado detectado, status: ${statStr}. ${detectionRows.length} detección(es).`;
        }
      }

      results.push({
        leadId: lead.id,
        contactId,
        rawPhone,
        phoneNormalized,
        ageHours: Math.round(ageHours),
        createdAt: new Date(lead.created_at * 1000).toISOString().slice(0, 10),
        group,
        notes,
        duplicateIndexEntries: otherIndexEntries.map((r) => ({ contactId: r.kommo_contact_id, leadId: r.kommo_lead_id, source: r.source })),
        detections: detectionRows.map((d) => ({
          id: d.id,
          status: d.status,
          detectedAt: new Date(d.detected_at).toISOString().slice(0, 16),
          notes: d.notes,
        })),
        ...(group === "A3" ? { webhookEvents: webhookRows } : {}),
      });
    }

    const counts = results.reduce(
      (acc, r) => { acc[r.group] = (acc[r.group] ?? 0) + 1; return acc; },
      {} as Record<string, number>
    );

    const byGroup = (g: LeadGroup) => results.filter((r) => r.group === g);

    logger.info("audit_pipeline_done", {
      pipelineId: AUDIT_PIPELINE_ID,
      statusId,
      total: results.length,
      ...counts,
    });

    res.json({
      auditedAt: new Date().toISOString(),
      pipelineId: AUDIT_PIPELINE_ID,
      stageName: "Contacto inicial",
      statusId,
      summary: {
        total: results.length,
        A1_dup_bug403: counts["A1"] ?? 0,
        A2_dup_other: counts["A2"] ?? 0,
        A3_dup_never_detected: counts["A3"] ?? 0,
        B_legitimate: counts["B"] ?? 0,
        no_phone: counts["no_phone"] ?? 0,
      },
      alertNewBug: (counts["A3"] ?? 0) > 0,
      groups: {
        A3_never_detected: byGroup("A3"),
        A1_bug403: byGroup("A1"),
        A2_other: byGroup("A2"),
        B_legitimate: byGroup("B"),
        no_phone: byGroup("no_phone"),
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("audit_pipeline_failed", { detail });
    res.status(500).json({ error: "audit_failed", detail });
  }
});
