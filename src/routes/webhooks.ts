import fs from "fs";
import path from "path";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { verifyKommoWebhook } from "../middleware/verifyKommoWebhook";
import { processIncomingEntity } from "../services/duplicateDetector";
import { logger } from "../logger";
import type {
  KommoClassicWebhookBody,
  KommoContactEventPayload,
  KommoCustomField,
  KommoLeadEventPayload,
  KommoUnsortedEventPayload,
  LeadSource,
} from "../types/kommo";

export const webhooksRouter = Router();

// TODO: diagnostico temporal para capturar el shape real de los webhooks de
// Kommo (lead/contacto nuevo). Sacar este middleware una vez validado contra
// una cuenta real; captured-payloads/ esta en .gitignore asi que no se
// commitean datos de clientes.
const CAPTURE_DIR = path.join(process.cwd(), "captured-payloads");

/**
 * Identifica de un vistazo que tipo de evento clasico de Kommo llego
 * (leads.add / leads.update / contacts.add / contacts.update / etc.), para
 * poder escanear rapido una tanda de capturas sin tener que abrir cada JSON.
 * Un mismo body puede traer mas de una clave a la vez; devolvemos todas las
 * que tengan al menos un elemento.
 */
export function detectEventTypes(body: KommoClassicWebhookBody): string[] {
  const types: string[] = [];
  if (body.leads?.add?.length) types.push("leads.add");
  if (body.leads?.update?.length) types.push("leads.update");
  if (body.leads?.status?.length) types.push("leads.status");
  if (body.contacts?.add?.length) types.push("contacts.add");
  if (body.contacts?.update?.length) types.push("contacts.update");
  if (body.unsorted?.add?.length) types.push("unsorted.add");
  if (body.unsorted?.update?.length) types.push("unsorted.update");
  return types.length > 0 ? types : ["unknown"];
}

function captureRawPayload(req: Request, _res: Response, next: NextFunction): void {
  const eventTypes = detectEventTypes(req.body as KommoClassicWebhookBody);

  logger.info("webhook_event_type_detected", {
    path: req.path,
    eventTypes,
  });

  logger.info("webhook_raw_payload_captured", {
    path: req.path,
    eventTypes,
    headers: req.headers,
    body: req.body,
  });

  try {
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    const safeRoute = req.path.replace(/[^a-zA-Z0-9_-]+/g, "_");
    const safeEventTypes = eventTypes.join("+").replace(/[^a-zA-Z0-9_+-]+/g, "_");
    const filename = `${Date.now()}-${safeRoute || "root"}-${safeEventTypes}.json`;
    fs.writeFileSync(
      path.join(CAPTURE_DIR, filename),
      JSON.stringify(
        { eventTypes, headers: req.headers, query: req.query, body: req.body },
        null,
        2
      )
    );
  } catch (err) {
    logger.error("webhook_raw_payload_capture_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  next();
}

webhooksRouter.use(captureRawPayload);

webhooksRouter.use(verifyKommoWebhook);

/**
 * Extrae los valores crudos de telefono de la lista de custom_fields de un
 * lead/contacto.
 *
 * Confirmado contra un payload real de produccion (contacts.update, cuenta
 * rudas.kommo.com): el campo de telefono estandar siempre trae
 * `code: "PHONE"` (ej: name "Telefono", values[0].value "+5493456255001").
 * Matcheamos solo por `code === "PHONE"` — se saco el fallback por nombre
 * (regex tel|phone|celular|whatsapp) que usabamos antes por no tener
 * confirmacion; era mas ruidoso y ya no hace falta.
 */
export function extractPhonesFromCustomFields(
  customFields: KommoCustomField[] | undefined
): string[] {
  if (!customFields || !Array.isArray(customFields)) return [];

  const phones: string[] = [];

  for (const field of customFields) {
    if (field.code !== "PHONE") continue;

    for (const v of field.values || []) {
      if (v?.value) phones.push(v.value);
    }
  }

  return phones;
}

/**
 * Extrae el telefono de un evento "unsorted" (chat nuevo, ej. WhatsApp
 * Business via Kommo). Confirmado contra payload real de produccion: el
 * telefono del prospecto viaja en `source_data.client.id`
 * (ej: "+5493886558615"). Devuelve `null` si no esta presente.
 */
export function extractPhoneFromUnsorted(
  entry: KommoUnsortedEventPayload
): string | null {
  return entry.source_data?.client?.id || null;
}

/**
 * Best-effort para inferir la fuente del lead/contacto a partir del
 * payload. Se puede sobreescribir explicitamente pasando `?source=` en la
 * URL del webhook (util si se registran URLs de webhook distintas por
 * integracion en Kommo).
 *
 * TODO: verificar con datos reales que campos distinguen efectivamente un
 * lead de Facebook Lead Ads de uno creado por la integracion de WhatsApp
 * Business Cloud API (ej: pipeline_id especifico, presencia de un campo de
 * "chat_id", tags automaticos que pone Kommo, etc.) y afinar esta funcion.
 */
function inferSource(
  querySource: unknown,
  customFields: KommoCustomField[] | undefined
): LeadSource {
  if (querySource === "facebook_ads" || querySource === "whatsapp") {
    return querySource;
  }

  const utmField = customFields?.find((f) => /utm_source/i.test(f.name || ""));
  const utmValue = utmField?.values?.[0]?.value?.toLowerCase();
  if (utmValue?.includes("facebook") || utmValue?.includes("fb")) {
    return "facebook_ads";
  }

  const hasWhatsappField = customFields?.some((f) =>
    /whatsapp|chat_id/i.test(f.name || "")
  );
  if (hasWhatsappField) {
    return "whatsapp";
  }

  return "unknown";
}

/**
 * Los eventos de leads (add/update) confirmados contra 206 payloads reales de
 * produccion NUNCA traen un custom_field de telefono -- no disparan el
 * detector de duplicados, serian puro ruido para ese proposito (y de hecho la
 * mayoria del volumen real es leads.update, cambios de estado del pipeline
 * de ventas). Solo los logueamos para poder correlacionar pipeline_id/status
 * con un lead si hace falta debuggear algo mas adelante.
 */
function logLeadEventsForCorrelation(leads: KommoLeadEventPayload[], changeType: "add" | "update"): void {
  for (const lead of leads) {
    logger.info("webhook_lead_event_no_phone_trigger", {
      changeType,
      leadId: lead.id,
      pipelineId: lead.pipeline_id ?? null,
      statusId: lead.status_id ?? null,
    });
  }
}

/**
 * Dispara el detector de duplicados por cada contacto con telefono en
 * `custom_fields` (code "PHONE"). Se procesan tanto `add` como `update`:
 * confirmado contra datos reales que un contacto originado por WhatsApp
 * llega como `contacts.update`, no como `contacts.add` -- si solo
 * escuchabamos "add" nos perdiamos esos casos por completo. La idempotencia
 * de `processIncomingEntity` (hash de payload en `processed_webhook_events`)
 * evita reprocesar el mismo evento si Kommo reintenta o si el mismo contacto
 * dispara varios "update" seguidos con el mismo contenido.
 */
async function processContactEvents(
  contacts: KommoContactEventPayload[],
  changeType: "add" | "update",
  querySource: unknown
): Promise<number> {
  let processed = 0;

  for (const contact of contacts) {
    const phones = extractPhonesFromCustomFields(contact.custom_fields);
    const source = inferSource(querySource, contact.custom_fields);

    if (phones.length === 0) {
      // Esperado para algunos contactos de Facebook, que no siempre traen un
      // custom_field de telefono -- se loguea y se saltea sin romper nada.
      logger.info("webhook_contact_no_phone_found", { changeType, contactId: contact.id });
      continue;
    }

    await processIncomingEntity({
      entityType: "contact",
      entityId: contact.id,
      contactId: contact.id,
      leadId: null,
      phonesRaw: phones,
      source,
      rawPayload: contact,
    });
    processed += 1;
  }

  return processed;
}

/**
 * Dispara el detector de duplicados por cada evento "unsorted" (chat nuevo
 * de un canal como WhatsApp Business) que traiga telefono. El origen se
 * marca directamente como "whatsapp" -- category "chats" + source "waba:..."
 * ya lo confirma, no hace falta heuristica de custom_fields como en
 * `inferSource`.
 */
async function processUnsortedEvents(
  entries: KommoUnsortedEventPayload[],
  changeType: "add" | "update"
): Promise<number> {
  let processed = 0;

  for (const entry of entries) {
    const phone = extractPhoneFromUnsorted(entry);
    const contactId = entry.data?.contacts?.id ?? null;
    const leadId = entry.data?.leads?.id ?? null;

    if (!phone) {
      logger.info("webhook_unsorted_no_phone_found", { changeType, uid: entry.uid });
      continue;
    }

    await processIncomingEntity({
      entityType: "contact",
      entityId: contactId ?? entry.uid,
      contactId,
      leadId,
      phonesRaw: [phone],
      source: "whatsapp",
      rawPayload: entry,
    });
    processed += 1;
  }

  return processed;
}

/**
 * Kommo esta configurado con una sola URL de webhook registrada (confirmado:
 * vimos eventos de "contacts" y "unsorted" llegar a la ruta "/kommo/lead"),
 * asi que ambas rutas procesan el body completo -- si en algun momento Kommo
 * SI manda el mismo body a ambas rutas, la idempotencia por hash de payload
 * en `processed_webhook_events` evita procesarlo dos veces.
 */
async function handleKommoWebhookBody(
  body: KommoClassicWebhookBody,
  querySource: unknown
): Promise<number> {
  logLeadEventsForCorrelation(body.leads?.add || [], "add");
  logLeadEventsForCorrelation(body.leads?.update || [], "update");

  let processed = 0;
  processed += await processContactEvents(body.contacts?.add || [], "add", querySource);
  processed += await processContactEvents(body.contacts?.update || [], "update", querySource);
  processed += await processUnsortedEvents(body.unsorted?.add || [], "add");
  processed += await processUnsortedEvents(body.unsorted?.update || [], "update");

  return processed;
}

webhooksRouter.post("/kommo/lead", async (req, res) => {
  const body = req.body as KommoClassicWebhookBody;
  const processed = await handleKommoWebhookBody(body, req.query.source);
  res.status(200).json({ ok: true, processed });
});

webhooksRouter.post("/kommo/contact", async (req, res) => {
  const body = req.body as KommoClassicWebhookBody;
  const processed = await handleKommoWebhookBody(body, req.query.source);
  res.status(200).json({ ok: true, processed });
});
