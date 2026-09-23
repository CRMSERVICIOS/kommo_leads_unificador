import { config, getKommoBaseUrl } from "../config";
import { logger } from "../logger";

/**
 * Wrapper minimo sobre la API v4 de Kommo (https://developers.kommo.com/reference).
 *
 * IMPORTANTE: nada de esto fue probado todavia contra una cuenta real. Los
 * shapes de request/response de abajo son los que documenta Kommo v4 al
 * momento de escribir esto, pero hay TODOs puntuales donde conviene
 * verificar en cuanto tengamos credenciales (KOMMO_SUBDOMAIN +
 * KOMMO_LONG_LIVED_TOKEN reales).
 */

async function kommoFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const url = `${getKommoBaseUrl()}${path}`;

  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.kommoLongLivedToken}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    logger.error("kommo_api_error", {
      url,
      status: response.status,
      statusText: response.statusText,
      body: bodyText,
    });
    throw new Error(
      `Kommo API error ${response.status} en ${path}: ${bodyText}`
    );
  }

  // 204 No Content u otras respuestas sin body.
  const text = await response.text();
  if (!text) {
    return undefined as unknown as T;
  }
  return JSON.parse(text) as T;
}

/** Contacto de Kommo reducido a lo que usa el indice de telefonos. */
export interface KommoContactPhones {
  id: string;
  /** Valores crudos del campo PHONE (sin normalizar). */
  phones: string[];
  leadIds: string[];
}

interface KommoContactsResponse {
  _embedded?: {
    contacts?: Array<{
      id: number | string;
      custom_fields_values?: Array<{
        field_code?: string | null;
        values?: Array<{ value?: string }>;
      }> | null;
      _embedded?: { leads?: Array<{ id: number | string }> };
    }>;
  };
  _links?: { next?: { href?: string } };
}

function toContactPhones(data: KommoContactsResponse | undefined): KommoContactPhones[] {
  return (data?._embedded?.contacts ?? []).map((contact) => ({
    id: String(contact.id),
    phones: (contact.custom_fields_values ?? [])
      .filter((field) => field.field_code === "PHONE")
      .flatMap((field) => field.values ?? [])
      .map((v) => v.value)
      .filter((v): v is string => !!v),
    leadIds: (contact._embedded?.leads ?? []).map((lead) => String(lead.id)),
  }));
}

/**
 * Busca contactos en Kommo por texto (`query` busca en nombre, telefono,
 * email...). Relanza si Kommo responde error. Responde 204 sin body cuando no
 * hay resultados.
 *
 * Confirmado contra la cuenta real: buscar el telefono completo NO cruza
 * formatos ("+5493777808738" no encuentra "+543777808738"), pero buscar los
 * ultimos digitos si encuentra ambos. El que llama tiene que filtrar los
 * resultados normalizando los telefonos.
 *   GET /api/v4/contacts?query=77808738&with=leads
 */
export async function findContactsByPhoneQuery(query: string): Promise<KommoContactPhones[]> {
  const data = await kommoFetch<KommoContactsResponse | undefined>(
    `/contacts?query=${encodeURIComponent(query)}&with=leads&limit=250`
  );
  return toContactPhones(data);
}

/**
 * Una pagina del listado completo de contactos (para el backfill del
 * indice). Relanza si Kommo responde error.
 *   GET /api/v4/contacts?page=N&limit=250&with=leads
 */
export async function listContactsPage(
  page: number,
  limit = 250
): Promise<{ contacts: KommoContactPhones[]; hasMore: boolean }> {
  const data = await kommoFetch<KommoContactsResponse | undefined>(
    `/contacts?page=${page}&limit=${limit}&with=leads`
  );
  return { contacts: toContactPhones(data), hasMore: !!data?._links?.next?.href };
}

/**
 * Devuelve los ids de los leads vinculados a un contacto. Relanza si Kommo
 * responde error.
 *   GET /api/v4/contacts/{id}?with=leads -> _embedded.leads[].id
 */
export async function getContactLeadIds(contactId: string): Promise<string[]> {
  const data = await kommoFetch<{ _embedded?: { leads?: { id: number | string }[] } }>(
    `/contacts/${contactId}?with=leads`
  );
  return (data._embedded?.leads ?? []).map((lead) => String(lead.id));
}

export interface KommoLeadSummary {
  id: number;
  pipeline_id: number;
  status_id: number;
  closed_at?: number | null;
  [key: string]: unknown;
}

/** GET /api/v4/leads/{id}. Relanza si Kommo responde error. */
export async function getLead(leadId: string): Promise<KommoLeadSummary> {
  return kommoFetch<KommoLeadSummary>(`/leads/${leadId}`);
}

/**
 * Mueve un lead a una etapa y devuelve la respuesta cruda de Kommo. Relanza
 * si Kommo responde error.
 *
 * Se manda SIEMPRE `pipeline_id` junto con `status_id`: las etapas de
 * sistema 142 (ganado) y 143 (perdido) existen con el mismo id en todos los
 * embudos, y la receta de la doc ("Move a lead to another stage") manda los
 * dos. Pasando el embudo actual del lead, el lead no cambia de embudo.
 *   PATCH /api/v4/leads/{id}  { "pipeline_id": 123, "status_id": 143, "loss_reason_id": 456 }
 * `loss_reason_id` es opcional ("Lead loss reason ID" en la doc); los motivos
 * se crean desde la UI de Kommo (la API v4 solo permite listarlos).
 */
export async function updateLeadStatus(
  leadId: string,
  pipelineId: number,
  statusId: number,
  lossReasonId?: number | null
): Promise<unknown> {
  return kommoFetch(`/leads/${leadId}`, {
    method: "PATCH",
    body: JSON.stringify({
      pipeline_id: pipelineId,
      status_id: statusId,
      ...(lossReasonId ? { loss_reason_id: lossReasonId } : {}),
    }),
  });
}

export type KommoEntityType = "leads" | "contacts";

/**
 * Crea una nota de texto ("common") en un lead o contacto y devuelve la
 * respuesta cruda de Kommo. Relanza si Kommo responde error.
 *
 * Confirmado contra la doc v4 (developers.kommo.com/reference/add-notes):
 *   POST /api/v4/{leads|contacts}/notes
 *   [{ "entity_id": 123, "note_type": "common", "params": { "text": "..." } }]
 */
export async function createNote(
  entityType: KommoEntityType,
  entityId: string,
  text: string
): Promise<unknown> {
  const body = [
    {
      entity_id: Number(entityId),
      note_type: "common",
      params: { text },
    },
  ];

  return kommoFetch(`/${entityType}/notes`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Agrega tags a un lead o contacto SIN tocar los que ya tiene, y devuelve
 * la respuesta cruda de Kommo. Relanza si Kommo responde error.
 *
 * Confirmado contra la doc v4 (developers.kommo.com/reference/updating-single-lead):
 * `_embedded.tags` REEMPLAZA la lista completa de tags ("If already attached
 * tags are not passed, they will be detached"); `tags_to_add` solo agrega.
 *   PATCH /api/v4/leads/{id}
 *   { "tags_to_add": [{ "name": "duplicado-potencial" }] }
 */
export async function addTagsToEntity(
  entityType: KommoEntityType,
  entityId: string,
  tagNames: string[]
): Promise<unknown> {
  const body = {
    tags_to_add: tagNames.map((name) => ({ name })),
  };

  return kommoFetch(`/${entityType}/${entityId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/**
 * Vincula un contacto a un lead YA EXISTENTE y devuelve la respuesta cruda
 * de Kommo. Relanza si Kommo responde error.
 *
 * Confirmado contra la doc v4 (developers.kommo.com/reference/linking-entities):
 *   POST /api/v4/leads/{lead_id}/link
 *   [{ "to_entity_id": 123, "to_entity_type": "contacts", "metadata": { "is_main": true } }]
 * Responde 200 con `_embedded.links`. PATCH /leads con `_embedded.contacts`
 * NO esta soportado para leads existentes (solo acepta `_embedded.tags`).
 * Vincular NO desvincula los contactos que el lead ya tenia; para eso hay
 * un endpoint aparte (POST /api/v4/leads/{id}/unlink).
 */
export async function linkContactToLead(
  leadId: string,
  contactId: string,
  options: { isMain: boolean }
): Promise<unknown> {
  const body = [
    {
      to_entity_id: Number(contactId),
      to_entity_type: "contacts",
      metadata: { is_main: options.isMain },
    },
  ];

  return kommoFetch(`/leads/${leadId}/link`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Agrega una nota de texto simple a un lead o contacto (best-effort: loguea
 * y no relanza si falla).
 */
export async function addNote(
  entityType: KommoEntityType,
  entityId: string,
  text: string
): Promise<void> {
  try {
    await createNote(entityType, entityId, text);
    logger.info("kommo_note_added", { entityType, entityId });
  } catch (err) {
    logger.error("kommo_add_note_failed", {
      entityType,
      entityId,
      error: err instanceof Error ? err.message : String(err),
    });
    // No relanzamos: un fallo al notificar en Kommo no deberia frenar el
    // resto del flujo de deteccion (el registro en duplicate_detections y
    // la notificacion a Slack son la fuente de verdad para el humano).
  }
}

/**
 * Agrega un tag a un lead o contacto sin pisar los existentes (best-effort:
 * loguea y no relanza si falla).
 */
export async function addTag(
  entityType: KommoEntityType,
  entityId: string,
  tagName: string
): Promise<void> {
  try {
    await addTagsToEntity(entityType, entityId, [tagName]);
    logger.info("kommo_tag_added", { entityType, entityId, tagName });
  } catch (err) {
    logger.error("kommo_add_tag_failed", {
      entityType,
      entityId,
      tagName,
      error: err instanceof Error ? err.message : String(err),
    });
    // Idem addNote: no relanzamos, es un best-effort secundario.
  }
}
