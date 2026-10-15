/**
 * Auditoría de leads en pipeline 14362171, etapa "Contacto inicial".
 *
 * Para cada lead activo en esa etapa:
 *   - Obtiene el contacto y teléfono asociado
 *   - Normaliza el teléfono con la misma función del backend
 *   - Cruza con phone_index para detectar duplicados reales
 *   - Cruza con duplicate_detections para ver si ya fue detectado
 *   - Cruza con processed_webhook_events para ver si el webhook llegó
 *
 * Clasifica en:
 *   Grupo A1 — duplicado CONOCIDO: está en duplicate_detections con error 403 (bug activo)
 *   Grupo A2 — duplicado CONOCIDO: está en duplicate_detections sin el error 403
 *   Grupo A3 — duplicado NO DETECTADO: hay otro teléfono en phone_index pero CERO filas en duplicate_detections
 *   Grupo B  — lead legítimo (sin duplicado conocido)
 *
 * Uso:
 *   DATABASE_URL=postgresql://... npx tsx scripts/audit-pipeline-14362171.ts
 *   o simplemente:
 *   npm run audit-pipeline   (si agregás el script a package.json)
 */

import { config } from "../src/config";
import { closeDb, getPool, runMigrations } from "../src/db";
import { normalizePhone } from "../src/services/phoneNormalizer";

const PIPELINE_ID = 14362171;
const DUPLICATES_PIPELINE_ID = 14517971;

const KOMMO_BASE = `https://${config.kommoSubdomain}.kommo.com/api/v4`;
const KOMMO_TOKEN = config.kommoLongLivedToken;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── helpers API ────────────────────────────────────────────────────────────

async function kommoGet<T>(path: string): Promise<T | null> {
  const url = `${KOMMO_BASE}${path}`;
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) await sleep(1000 * attempt);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${KOMMO_TOKEN}` },
    });
    if (res.status === 204) return null;
    if (res.status === 403 || res.status === 429 || res.status >= 500) {
      console.warn(`  [WARN] ${res.status} en ${path} (intento ${attempt + 1}/4)`);
      if (attempt < 3) continue;
      return null;
    }
    if (!res.ok) {
      console.warn(`  [WARN] ${res.status} definitivo en ${path}`);
      return null;
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  }
  return null;
}

// ─── paso 1: obtener status_id de "Contacto inicial" ────────────────────────

interface KommoStatus {
  id: number;
  name: string;
  pipeline_id: number;
}

interface KommoPipelineStatusesResponse {
  _embedded?: { statuses?: KommoStatus[] };
}

async function getContactoInicialStatusId(): Promise<number> {
  const data = await kommoGet<KommoPipelineStatusesResponse>(
    `/leads/pipelines/${PIPELINE_ID}/statuses`
  );
  const statuses = data?._embedded?.statuses ?? [];
  console.log(
    "Etapas del pipeline:",
    statuses.map((s) => `${s.id}="${s.name}"`).join(", ")
  );
  const match = statuses.find((s) =>
    s.name.toLowerCase().includes("contacto inicial")
  );
  if (!match) {
    throw new Error(
      `No encontré etapa "Contacto inicial" en pipeline ${PIPELINE_ID}. Etapas: ${statuses.map((s) => s.name).join(", ")}`
    );
  }
  return match.id;
}

// ─── paso 2: obtener todos los leads de esa etapa ───────────────────────────

interface KommoLead {
  id: number;
  pipeline_id: number;
  status_id: number;
  created_at: number;
  _embedded?: {
    contacts?: Array<{ id: number; is_main?: boolean }>;
  };
}

interface KommoLeadsPage {
  _embedded?: { leads?: KommoLead[] };
  _links?: { next?: { href?: string } };
}

async function fetchLeadsInStage(statusId: number): Promise<KommoLead[]> {
  const leads: KommoLead[] = [];
  let page = 1;
  while (true) {
    const path =
      `/leads?filter[pipeline_id][0]=${PIPELINE_ID}&filter[status_id][0]=${statusId}` +
      `&with=contacts&limit=250&page=${page}`;
    const data = await kommoGet<KommoLeadsPage>(path);
    const batch = data?._embedded?.leads ?? [];
    leads.push(...batch);
    if (!data?._links?.next?.href || batch.length === 0) break;
    page++;
    await sleep(200);
  }
  return leads;
}

// ─── paso 3: obtener teléfono de un contacto ────────────────────────────────

interface KommoContactDetail {
  id: number;
  custom_fields_values?: Array<{
    field_code?: string | null;
    values?: Array<{ value?: string }>;
  }> | null;
}

async function getContactPhones(contactId: number): Promise<string[]> {
  const data = await kommoGet<KommoContactDetail>(`/contacts/${contactId}`);
  if (!data) return [];
  return (data.custom_fields_values ?? [])
    .filter((f) => f.field_code === "PHONE")
    .flatMap((f) => f.values ?? [])
    .map((v) => v.value)
    .filter((v): v is string => !!v);
}

// ─── paso 4: consultas DB ────────────────────────────────────────────────────

interface PhoneIndexRow {
  id: number;
  phone_normalized: string;
  kommo_contact_id: string | null;
  kommo_lead_id: string | null;
  source: string | null;
}

interface DetectionRow {
  id: number;
  phone_normalized: string;
  existing_contact_id: string | null;
  existing_lead_id: string | null;
  new_contact_id: string | null;
  new_lead_id: string | null;
  status: string;
  detected_at: Date;
  notes: string | null;
}

async function findPhoneInIndex(phone: string): Promise<PhoneIndexRow[]> {
  const r = await getPool().query<PhoneIndexRow>(
    `SELECT * FROM phone_index WHERE phone_normalized = $1 ORDER BY id`,
    [phone]
  );
  return r.rows;
}

async function findDetections(phone: string): Promise<DetectionRow[]> {
  const r = await getPool().query<DetectionRow>(
    `SELECT * FROM duplicate_detections WHERE phone_normalized = $1 ORDER BY detected_at DESC`,
    [phone]
  );
  return r.rows;
}

async function findWebhookEvents(leadId: number): Promise<string[]> {
  const r = await getPool().query<{ event_key: string }>(
    `SELECT event_key FROM processed_webhook_events WHERE event_key LIKE $1 ORDER BY processed_at DESC`,
    [`%:${leadId}:%`]
  );
  return r.rows.map((row) => row.event_key);
}

// ─── paso 5: clasificar y reportar ──────────────────────────────────────────

interface LeadAudit {
  leadId: number;
  pipelineId: number;
  statusId: number;
  createdAt: Date;
  ageHours: number;
  contactId: number | null;
  rawPhones: string[];
  normalizedPhone: string | null;
  indexRows: PhoneIndexRow[];
  detections: DetectionRow[];
  webhookEvents: string[];
  group: "A1" | "A2" | "A3" | "B" | "no_phone";
  notes: string;
}

function classifyLead(audit: LeadAudit): void {
  if (!audit.normalizedPhone) {
    audit.group = "no_phone";
    audit.notes = `Sin teléfono normalizable (raw: [${audit.rawPhones.join(", ")}])`;
    return;
  }

  // ¿Hay filas en phone_index para OTROS contactos/leads?
  const duplicateIndexRows = audit.indexRows.filter(
    (row) =>
      row.kommo_contact_id !== String(audit.contactId) &&
      row.kommo_lead_id !== String(audit.leadId)
  );

  if (duplicateIndexRows.length === 0) {
    audit.group = "B";
    audit.notes =
      audit.ageHours > 72
        ? `Lead legítimo, SIN duplicado en phone_index. ATENCIÓN: lleva ${Math.round(audit.ageHours)}h en esta etapa sin moverse.`
        : `Lead legítimo, sin duplicado conocido.`;
    return;
  }

  // Hay duplicado real — ¿está en duplicate_detections?
  if (audit.detections.length === 0) {
    audit.group = "A3";
    audit.notes =
      `DUPLICADO NO DETECTADO — hay ${duplicateIndexRows.length} fila(s) en phone_index para otros leads/contactos, ` +
      `pero CERO filas en duplicate_detections. El sistema nunca lo procesó.`;
    return;
  }

  const has403 = audit.detections.some((d) => d.notes?.includes("403"));
  const hasPending = audit.detections.some((d) => d.status === "pending_review");

  if (has403 && hasPending) {
    audit.group = "A1";
    audit.notes = `Duplicado conocido — fallo de fusión por 403 (bug activo). ${audit.detections.length} detección(es).`;
  } else {
    audit.group = "A2";
    const statuses = [...new Set(audit.detections.map((d) => d.status))].join(", ");
    audit.notes = `Duplicado detectado, status(es): ${statuses}. ${has403 ? "Contiene 403 pero no pending_review." : "Sin error 403."} ${audit.detections.length} detección(es).`;
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== AUDITORÍA PIPELINE 14362171 — Contacto inicial ===");
  console.log(`Fecha: ${new Date().toISOString()}`);
  console.log(`Kommo subdomain: ${config.kommoSubdomain}`);
  console.log(`DB: ${config.databaseUrl.replace(/:[^:@]+@/, ":***@")}\n`);

  await runMigrations();

  // 1. Resolución del status_id
  console.log("1. Obteniendo etapas del pipeline...");
  const statusId = await getContactoInicialStatusId();
  console.log(`   → status_id "Contacto inicial": ${statusId}\n`);

  // 2. Leads en esa etapa
  console.log("2. Obteniendo leads en Contacto inicial...");
  const leads = await fetchLeadsInStage(statusId);
  console.log(`   → ${leads.length} lead(s) encontrados\n`);

  if (leads.length === 0) {
    console.log("No hay leads en esa etapa. Nada que auditar.");
    return;
  }

  // 3. Para cada lead, recopilar datos
  console.log("3. Analizando cada lead (API + DB)...\n");
  const audits: LeadAudit[] = [];
  const now = Date.now();

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const contactId = lead._embedded?.contacts?.find((c) => c.is_main)?.id
      ?? lead._embedded?.contacts?.[0]?.id
      ?? null;

    process.stdout.write(`   [${i + 1}/${leads.length}] lead=${lead.id} contact=${contactId ?? "?"}...`);

    let rawPhones: string[] = [];
    if (contactId) {
      await sleep(150); // evitar rate-limit
      rawPhones = await getContactPhones(contactId);
    }

    const normalizedPhone = rawPhones.length > 0 ? normalizePhone(rawPhones[0]) : null;

    let indexRows: PhoneIndexRow[] = [];
    let detections: DetectionRow[] = [];
    let webhookEvents: string[] = [];

    if (normalizedPhone) {
      [indexRows, detections, webhookEvents] = await Promise.all([
        findPhoneInIndex(normalizedPhone),
        findDetections(normalizedPhone),
        findWebhookEvents(lead.id),
      ]);
    }

    const ageHours = (now - lead.created_at * 1000) / 3600000;

    const audit: LeadAudit = {
      leadId: lead.id,
      pipelineId: lead.pipeline_id,
      statusId: lead.status_id,
      createdAt: new Date(lead.created_at * 1000),
      ageHours,
      contactId: contactId ?? null,
      rawPhones,
      normalizedPhone,
      indexRows,
      detections,
      webhookEvents,
      group: "B",
      notes: "",
    };

    classifyLead(audit);
    audits.push(audit);
    console.log(` → ${audit.group}`);
  }

  // ─── 4. Resumen ─────────────────────────────────────────────────────────

  const a3 = audits.filter((a) => a.group === "A3");
  const a1 = audits.filter((a) => a.group === "A1");
  const a2 = audits.filter((a) => a.group === "A2");
  const b = audits.filter((a) => a.group === "B");
  const noPhone = audits.filter((a) => a.group === "no_phone");

  console.log("\n" + "=".repeat(60));
  console.log("RESUMEN");
  console.log("=".repeat(60));
  console.log(`Total leads auditados:         ${audits.length}`);
  console.log(`Grupo B  — Legítimos:          ${b.length}`);
  console.log(`Grupo A1 — Dup. con bug 403:   ${a1.length}`);
  console.log(`Grupo A2 — Dup. otro status:   ${a2.length}`);
  console.log(`Grupo A3 — DUP. NO DETECTADOS: ${a3.length}  ← PRIORIDAD MÁXIMA`);
  console.log(`Sin teléfono:                  ${noPhone.length}`);

  if (a3.length > 0) {
    console.log("\n⚠️  ALERTA: HAY DUPLICADOS QUE EL SISTEMA NUNCA DETECTÓ");
    console.log("   Estos casos no están en duplicate_detections — bug DISTINTO al 403.");
  }

  // ─── 5. Detalle por grupo ────────────────────────────────────────────────

  const printGroup = (label: string, items: LeadAudit[]) => {
    if (items.length === 0) return;
    console.log(`\n${"─".repeat(60)}`);
    console.log(label);
    console.log("─".repeat(60));
    for (const a of items) {
      console.log(`  lead_id=${a.leadId} contact=${a.contactId ?? "?"} phone_raw="${a.rawPhones[0] ?? ""}" phone_norm="${a.normalizedPhone ?? ""}" age=${Math.round(a.ageHours)}h created=${a.createdAt.toISOString().slice(0, 10)}`);
      console.log(`    → ${a.notes}`);
      if (a.indexRows.length > 0) {
        console.log(`    phone_index (${a.indexRows.length} fila[s]):`);
        for (const row of a.indexRows) {
          console.log(`      id=${row.id} contact=${row.kommo_contact_id} lead=${row.kommo_lead_id} source=${row.source}`);
        }
      }
      if (a.detections.length > 0) {
        console.log(`    duplicate_detections (${a.detections.length} fila[s]):`);
        for (const d of a.detections) {
          console.log(`      id=${d.id} status=${d.status} detected_at=${new Date(d.detected_at).toISOString().slice(0, 16)} notes="${d.notes ?? ""}"`);
        }
      }
      if (a.group === "A3" && a.webhookEvents.length > 0) {
        console.log(`    processed_webhook_events: ${a.webhookEvents.join(", ")}`);
      } else if (a.group === "A3") {
        console.log(`    processed_webhook_events: (ninguno — el webhook de este lead no llegó al sistema)`);
      }
    }
  };

  printGroup("GRUPO A3 — Duplicados NO detectados (BUG NUEVO)", a3);
  printGroup("GRUPO A1 — Duplicados con bug 403 conocido", a1);
  printGroup("GRUPO A2 — Duplicados detectados (otro status)", a2);
  printGroup("GRUPO B — Leads legítimos", b);
  printGroup("SIN TELÉFONO", noPhone);

  // ─── 6. Lista plana de IDs para cruzar con reconciliación ───────────────

  console.log("\n" + "=".repeat(60));
  console.log("IDs PARA CRUZAR CON RECONCILIACIÓN");
  console.log("=".repeat(60));

  const idLine = (group: string, items: LeadAudit[]) => {
    if (items.length === 0) return;
    const ids = items.map((a) => a.leadId).join(", ");
    console.log(`${group}: [${ids}]`);
  };
  idLine("A3 (nuevo bug)", a3);
  idLine("A1 (bug 403)", a1);
  idLine("A2 (otro)", a2);
  idLine("B (legítimos)", b);
  idLine("sin_telefono", noPhone);

  console.log("\nAuditoría completada.");
}

if (require.main === module) {
  main()
    .then(() => closeDb())
    .catch(async (err) => {
      console.error("FATAL:", err instanceof Error ? err.message : String(err));
      await closeDb();
      process.exit(1);
    });
}
