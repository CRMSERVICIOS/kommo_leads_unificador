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

export interface KommoContactSearchResult {
  id: number;
  name: string;
  // TODO: completar con los campos que realmente necesitemos una vez que
  // verifiquemos la respuesta real de GET /api/v4/contacts?query=...
  [key: string]: unknown;
}

/**
 * Busca contactos en Kommo por texto libre (Kommo permite buscar por
 * telefono/email usando el parametro `query`). Se usa solo como
 * enriquecimiento/validacion manual; la deteccion principal de duplicados
 * se apoya en nuestro propio `phone_index`, no en este buscador.
 *
 * TODO: verificar contra la cuenta real si `query` matchea telefonos en
 * cualquier formato o si hay que mandarlo en un formato especifico.
 */
export async function searchContactsByPhone(
  phone: string
): Promise<KommoContactSearchResult[]> {
  const path = `/contacts?query=${encodeURIComponent(phone)}`;
  try {
    const data = await kommoFetch<{ _embedded?: { contacts?: KommoContactSearchResult[] } }>(
      path
    );
    return data._embedded?.contacts ?? [];
  } catch (err) {
    logger.error("kommo_search_contacts_failed", {
      phone,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export type KommoEntityType = "leads" | "contacts";

/**
 * Agrega una nota de texto simple a un lead o contacto.
 *
 * TODO: verificar el shape exacto contra la API real. Segun la doc v4,
 * el endpoint espera un ARRAY de notas en el body, ej:
 *   POST /api/v4/leads/{id}/notes
 *   [{ "note_type": "common", "params": { "text": "..." } }]
 * Ajustar si la cuenta real requiere otro `note_type` o estructura de
 * `params` distinta.
 */
export async function addNote(
  entityType: KommoEntityType,
  entityId: string,
  text: string
): Promise<void> {
  const path = `/${entityType}/${entityId}/notes`;
  const body = [
    {
      note_type: "common",
      params: { text },
    },
  ];

  try {
    await kommoFetch(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
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
 * Agrega un tag a un lead (Kommo tambien soporta tags en contactos con el
 * mismo shape).
 *
 * TODO: verificar contra la API real. Segun doc v4, se actualiza via
 *   PATCH /api/v4/leads/{id}
 *   { "_embedded": { "tags": [{ "name": "duplicado-potencial" }] } }
 * OJO: esto podria PISAR los tags existentes en vez de agregar, dependiendo
 * de como Kommo interprete el PATCH parcial. Confirmar con la cuenta real
 * si hace falta primero hacer GET del lead para mergear los tags actuales
 * antes de mandar el PATCH.
 */
export async function addTag(
  entityType: KommoEntityType,
  entityId: string,
  tagName: string
): Promise<void> {
  const path = `/${entityType}/${entityId}`;
  const body = {
    _embedded: {
      tags: [{ name: tagName }],
    },
  };

  try {
    await kommoFetch(path, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
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
