import { config, getKommoBaseUrl } from "../config";
import { logger } from "../logger";

// 403/429/5xx pueden ser transitorios (rate limiting de Kommo/nginx).
// 400/401/404 son errores permanentes del cliente: no se reintenta.
const RETRYABLE_STATUSES = new Set([403, 429, 500, 502, 503, 504]);

// 3 reintentos = 4 intentos totales. Delays aprox: 1s, 2s, 4s.
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Backoff exponencial con ±25% de jitter para no sincronizar reintentos. */
function backoffMs(retryIndex: number): number {
  const base = BASE_DELAY_MS * Math.pow(2, retryIndex);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}

/**
 * Wrapper minimo sobre la API v4 de Kommo (https://developers.kommo.com/reference).
 * Reintenta automáticamente en errores transitorios (403/429/5xx) con backoff
 * exponencial. En cada fallo loguea los response headers completos (clave para
 * diagnosticar si es rate limiting de Kommo, Cloudflare, o un 403 de nginx).
 */
async function kommoFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const url = `${getKommoBaseUrl()}${path}`;
  const options: RequestInit = {
    ...init,
    headers: {
      Authorization: `Bearer ${config.kommoLongLivedToken}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(backoffMs(attempt - 1));
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const responseHeaders = Object.fromEntries(response.headers.entries());
      const isRetryable = RETRYABLE_STATUSES.has(response.status);

      if (isRetryable && attempt < MAX_RETRIES) {
        // Drenar el body para liberar la conexión, pero no lo usamos todavía.
        await response.text().catch(() => "");
        logger.warn("kommo_api_error_retrying", {
          url,
          status: response.status,
          responseHeaders,
          attempt: attempt + 1,
          maxAttempts: MAX_RETRIES + 1,
        });
        continue;
      }

      // Último intento o error no reintentable: loguear con headers + body y lanzar.
      const bodyText = await response.text().catch(() => "");
      logger.error("kommo_api_error", {
        url,
        status: response.status,
        statusText: response.statusText,
        responseHeaders,
        body: bodyText,
        totalAttempts: attempt + 1,
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

  // Inalcanzable (el loop siempre sale por return o throw), pero TypeScript lo exige.
  throw new Error(`Kommo API: se agotaron los reintentos para ${path}`);
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
 * Mueve un lead a una etapa (y embudo) y le cambia el responsable, en una
 * sola llamada. Devuelve la respuesta cruda de Kommo; relanza si Kommo
 * responde error. Ningun otro campo del lead se toca.
 *   PATCH /api/v4/leads/{id}  { "pipeline_id": 123, "status_id": 456, "responsible_user_id": 789 }
 */
export async function moveLeadToStage(
  leadId: string,
  pipelineId: number,
  statusId: number,
  responsibleUserId: number
): Promise<unknown> {
  return kommoFetch(`/leads/${leadId}`, {
    method: "PATCH",
    body: JSON.stringify({
      pipeline_id: pipelineId,
      status_id: statusId,
      responsible_user_id: responsibleUserId,
    }),
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
