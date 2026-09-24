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
 * Mueve un lead a una etapa (y embudo) y devuelve la respuesta cruda de
 * Kommo. Relanza si Kommo responde error. Solo manda `pipeline_id` +
 * `status_id`: ningun otro campo del lead se toca.
 *   PATCH /api/v4/leads/{id}  { "pipeline_id": 123, "status_id": 456 }
 */
export async function moveLeadToStage(
  leadId: string,
  pipelineId: number,
  statusId: number
): Promise<unknown> {
  return kommoFetch(`/leads/${leadId}`, {
    method: "PATCH",
    body: JSON.stringify({ pipeline_id: pipelineId, status_id: statusId }),
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
