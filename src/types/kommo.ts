/**
 * Tipos de los payloads de Kommo.
 *
 * IMPORTANTE — sin verificar contra una cuenta real todavia:
 * Los webhooks "clasicos" de Kommo (Ajustes > Webhooks) se envian como
 * `application/x-www-form-urlencoded` con claves anidadas estilo PHP, por
 * ejemplo (para creacion de leads):
 *
 *   leads[add][0][id]=123
 *   leads[add][0][name]=Nuevo lead
 *   leads[add][0][status_id]=1
 *   leads[add][0][custom_fields][0][id]=456
 *   leads[add][0][custom_fields][0][values][0][value]=+54 9 11 2233-4455
 *   account[subdomain]=miempresa
 *   account[id]=789
 *
 * Si se usa `express.urlencoded({ extended: true })`, la libreria `qs`
 * reconstruye automaticamente esta estructura anidada en un objeto JS
 * equivalente al de abajo. Estos tipos representan ESA forma ya parseada.
 *
 * TODO: en cuanto tengamos credenciales reales de Kommo, capturar un payload
 * crudo (loguear `req.body` sin parsear / con `express.raw()`) desde el
 * "Webhooks" clasico y desde una integracion salesbot/digital pipeline, y
 * ajustar estos tipos si difieren. La documentacion oficial
 * (https://developers.kommo.com/reference) describe el formato JSON de la
 * API v4 (para llamadas salientes nuestras), pero los webhooks ENTRANTES
 * clasicos son un formato mas viejo y menos documentado.
 */

export interface KommoCustomFieldValue {
  value: string;
  enum?: string;
}

export interface KommoCustomField {
  id: string;
  name?: string;
  code?: string; // ej: "PHONE" para el campo estandar de telefono
  values: KommoCustomFieldValue[];
}

export interface KommoAccountInfo {
  subdomain?: string;
  id?: string;
}

export interface KommoLeadEventPayload {
  id: string;
  name?: string;
  status_id?: string;
  price?: string;
  responsible_user_id?: string;
  pipeline_id?: string;
  custom_fields?: KommoCustomField[];
  // Confirmado contra payloads reales: el webhook clasico de leads NO trae
  // los contact_id asociados en el propio evento (habria que resolverlo con
  // un GET a /api/v4/leads/{id}?with=contacts si algun dia hiciera falta).
  // Tampoco confirmamos custom_fields con code "PHONE" en leads reales -- ver
  // nota en routes/webhooks.ts, leads.add/update no disparan el detector.
  contacts?: { id: string }[];
}

export interface KommoContactEventPayload {
  id: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  responsible_user_id?: string;
  custom_fields?: KommoCustomField[];
  /** ids de los leads vinculados, forma `{ "<lead_id>": { "ID": "<lead_id>" } }` (confirmado real). */
  linked_leads_id?: Record<string, { ID: string }>;
}

/**
 * Evento "unsorted" (bandeja de entrada sin clasificar): asi llega un mensaje
 * nuevo de un canal de chat (WhatsApp Business Cloud API via Kommo, u otros
 * canales "amojo") cuando el numero/cliente todavia no tenia (o no se
 * resolvio a) un lead/contacto existente. Confirmado contra payload real de
 * produccion (source: "waba:...", category: "chats").
 */
export interface KommoUnsortedClient {
  name?: string;
  /** Telefono del prospecto en formato internacional, ej "+5493886558615". */
  id?: string;
}

export interface KommoUnsortedSourceDataMessage {
  id?: string;
  text?: string;
  date?: string;
}

export interface KommoUnsortedSourceData {
  client?: KommoUnsortedClient;
  data?: KommoUnsortedSourceDataMessage[];
  service?: string;
}

export interface KommoUnsortedEventPayload {
  uid: string;
  source?: string; // ej: "waba:<phone_number_id>"
  category?: string; // ej: "chats"
  source_data?: KommoUnsortedSourceData;
  /** contacto/lead que Kommo ya vinculo a este unsorted, si aplica. */
  data?: {
    contacts?: { id?: string };
    leads?: { id?: string };
  };
  pipeline_id?: string;
}

/** Forma esperada del body ya parseado por `express.urlencoded({extended:true})`. */
export interface KommoClassicWebhookBody {
  leads?: {
    add?: KommoLeadEventPayload[];
    update?: KommoLeadEventPayload[];
    status?: KommoLeadEventPayload[];
  };
  contacts?: {
    add?: KommoContactEventPayload[];
    update?: KommoContactEventPayload[];
  };
  unsorted?: {
    add?: KommoUnsortedEventPayload[];
    update?: KommoUnsortedEventPayload[];
  };
  account?: KommoAccountInfo;
  // Permite forma libre para no romper el parseo si Kommo manda claves extra
  // que todavia no modelamos.
  [key: string]: unknown;
}

/** Fuente inferida del evento, usada para el registro en phone_index. */
export type LeadSource = "facebook_ads" | "whatsapp" | "unknown";

export interface ExtractedPhone {
  raw: string;
  normalized: string | null;
}

export interface KommoNoteRequest {
  // TODO: verificar contra la API real el shape exacto esperado por
  // POST /api/v4/leads/{id}/notes y /api/v4/contacts/{id}/notes.
  // Segun la doc de Kommo v4, el body es un ARRAY de notas, cada una con
  // note_type (ej: "common") y params.text.
  note_type: string;
  params: {
    text: string;
  };
}

export interface KommoTagRequest {
  id?: string;
  name: string;
}
