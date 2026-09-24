# Kommo Dedup Service — Control de duplicados (Fase 1)

Servicio backend independiente que detecta contactos/leads duplicados en
Kommo CRM cuando la misma persona entra por dos canales distintos —
**Facebook Lead Ads** y **WhatsApp Business Cloud API** — y el numero de
telefono llega con formato distinto entre canales.

## Alcance de esta fase (Fase 1: deteccion + aviso)

Este servicio **detecta y avisa**. **NO fusiona nada automaticamente.**

Cuando detecta un posible duplicado de telefono:
1. Agrega una nota interna en el lead/contacto nuevo en Kommo.
2. Agrega el tag `duplicado-potencial` (opcional, best-effort).
3. Envia una notificacion (Slack si esta configurado, log siempre).
4. Registra el evento en la tabla `duplicate_detections` con estado
   `pending_review`, para que un humano lo revise y decida manualmente en la
   UI de Kommo si fusiona los registros.

### Fuera de alcance (TODO explicito para Fase 2, no implementado)

- Fusion automatica de contactos/leads duplicados.
- Mover conversaciones, notas o tareas entre leads.
- Borrar o cerrar leads automaticamente.

Estas capacidades se evaluaran recien despues de validar, con datos reales,
que la deteccion (Fase 1) funciona bien y no genera falsos positivos.

## Como funciona

1. Kommo dispara un webhook cuando se crea un lead o un contacto.
2. El servicio normaliza el/los telefono(s) del payload a un formato
   canonico (ver `src/services/phoneNormalizer.ts` para el detalle de las
   reglas argentinas: codigo de pais, "9" de celular, "15" viejo, "0" de
   area).
3. Busca ese telefono normalizado en su propio indice (`phone_index`, Postgres).
4. Si es nuevo: lo guarda en el indice y no hace nada mas.
5. Si ya existe asociado a OTRO contacto/lead: dispara el flujo de aviso
   descripto arriba y lo registra en `duplicate_detections`.

## Requisitos

- Node.js >= 18.

## Instalacion y uso local

```bash
npm install
cp .env.example .env   # completar con las variables reales cuando las tengas
npm run dev            # levanta con recarga automatica (tsx watch)
```

Otros comandos:

```bash
npm run build       # compila TypeScript a dist/
npm start           # corre la version compilada
npm run test:db:up  # levanta Postgres local (docker compose, puerto 5433, bases dedup y dedup_test)
npm test            # corre los tests (vitest); los de tests/db.postgres.test.ts usan dedup_test
npm run typecheck   # chequeo de tipos sin emitir output
npm run db:migrate  # crea las tablas en DATABASE_URL (tambien se corre solo al arrancar)
```

El servidor levanta por defecto en `http://localhost:3000` (configurable con
`PORT`). Las tablas se crean automaticamente en el Postgres de `DATABASE_URL`
al arrancar (`schema.sql` es idempotente).

### Carga inicial del indice (backfill)

Una sola vez, antes de activar el modo automatico en produccion, cargar en
`phone_index` los telefonos de todos los contactos que ya existen en Kommo
(solo indexa: no registra detecciones ni fusiona):

```bash
npm run backfill-index -- --dry-run   # solo cuenta, no escribe
npm run backfill-index                # local
node dist/jobs/backfillIndex.js       # en produccion (imagen compilada)
```

Se puede correr mas de una vez sin duplicar filas. Ademas, si llega un
telefono que no esta en el indice, el detector lo busca en Kommo antes de
darlo por nuevo (webhooks perdidos). El ganador de una fusion es siempre el
contacto con id de Kommo mas bajo (el mas viejo); si el orden no cierra, la
deteccion queda en `pending_review` con el motivo en `notes`.

Para pasar datos de una instalacion vieja con SQLite:
`scripts/migrate-sqlite-to-postgres.sh ./data/dedup.sqlite "$DATABASE_URL"`.

### Con Docker

```bash
docker compose up --build
```

## Variables de entorno

Ver `.env.example`. Resumen:

| Variable | Descripcion |
|---|---|
| `KOMMO_SUBDOMAIN` | Subdominio de la cuenta Kommo (ej: `miempresa` de `miempresa.kommo.com`). **Pendiente de completar.** |
| `KOMMO_LONG_LIVED_TOKEN` | Token de integracion privada (long-lived token) de Kommo. **Pendiente de completar.** |
| `KOMMO_WEBHOOK_SECRET` | Secreto para validar la firma del webhook, si Kommo la provee. **Pendiente de confirmar si aplica** (ver TODO en `src/middleware/verifyKommoWebhook.ts`). |
| `SLACK_WEBHOOK_URL` | URL de un Incoming Webhook de Slack. Opcional: si no esta seteado, solo se loguea. |
| `DATABASE_URL` | Connection string de Postgres, ej. `postgresql://user:pass@host:25060/db?sslmode=require`. Obligatoria. |
| `DATABASE_CA_CERT` | CA del Postgres administrado (en DO App Platform: `${<db>.CA_CERT}`). Opcional: sin ella la conexion va cifrada pero sin verificar la CA. |
| `DRY_RUN` | Freno de emergencia. `true` = solo loguea los duplicados, sin resolverlos. Default `false`. |
| `ADMIN_TOKEN` | Token para `POST /admin/unify-test`. Vacio = deshabilitado. |
| `PORT` | Puerto HTTP. Default `3000`. |
| `DEFAULT_COUNTRY_CODE` | Codigo de pais por defecto para telefonos sin codigo explicito. Default `54` (Argentina). |

## Endpoints

- `GET /health` — healthcheck.
- `POST /webhooks/kommo/lead` — webhook de creacion de leads. Body
  `application/x-www-form-urlencoded` (formato clasico de Kommo) o JSON.
- `POST /webhooks/kommo/contact` — webhook de creacion de contactos. Mismo
  formato.
- `GET /duplicates?status=pending_review` — lista las detecciones
  registradas (`status` opcional: `pending_review` | `reviewed_merged` |
  `reviewed_ignored`; sin filtro devuelve todas).

## Pendiente de completar cuando tengamos credenciales reales de Kommo

Este scaffold se construyo **sin acceso a una cuenta real de Kommo**, asi que
hay puntos marcados explicitamente con `TODO` en el codigo que hay que
verificar apenas se tengan credenciales:

- **Formato exacto del webhook entrante**: los webhooks "clasicos" de Kommo
  historicamente se mandan como `application/x-www-form-urlencoded` con
  claves anidadas estilo PHP (`leads[add][0][id]=...`). El servidor ya
  soporta ese parseo (`express.urlencoded({ extended: true })`, que usa `qs`
  para reconstruir la estructura anidada) y tambien acepta JSON por las
  dudas. **Falta capturar un payload crudo real** (loguear el body sin
  parsear) para confirmar que el shape en `src/types/kommo.ts` coincide
  exactamente, sobre todo:
  - El `code`/`id`/`name` del campo custom de telefono (asumimos `code: "PHONE"`).
  - Si el evento de lead trae el/los `contact_id` asociados directamente, o
    hay que resolverlo con un GET adicional a `/api/v4/leads/{id}?with=contacts`.
  - Que campos permiten distinguir de forma confiable un lead creado por
    Facebook Lead Ads de uno creado por la integracion de WhatsApp (hoy
    `inferSource()` en `src/routes/webhooks.ts` es una heuristica best-effort
    sobre `utm_source` / nombres de campo; se puede overridear pasando
    `?source=facebook_ads` o `?source=whatsapp` en la URL del webhook si se
    registran endpoints separados por integracion).

- **Validacion de origen del webhook**: `src/middleware/verifyKommoWebhook.ts`
  valida hoy que `account.subdomain` del payload coincida con
  `KOMMO_SUBDOMAIN`. Si Kommo provee algun mecanismo de firma para webhooks
  salientes, hay que agregarlo ahi usando `KOMMO_WEBHOOK_SECRET`.

## Registrar los webhooks en Kommo (pendiente hasta tener credenciales)

1. Entrar a **Ajustes > Integraciones > Webhooks** (o **Webhooks V2** segun
   la version de la cuenta) en la cuenta de Kommo.
2. Registrar una URL apuntando a este servicio, por ejemplo:
   - `https://tu-servidor.com/webhooks/kommo/lead`
   - `https://tu-servidor.com/webhooks/kommo/contact`
3. Eventos a suscribir (nombres exactos a confirmar contra la UI real de la
   cuenta, pueden variar segun version):
   - **Creacion de leads** (`Add lead` / "Lead agregado").
   - **Creacion de contactos** (`Add contact` / "Contacto agregado").
   - Si la cuenta usa la bandeja de **"Unsorted" / "Incoming leads"**
     (leads sin clasificar que llegan de integraciones como Facebook o
     WhatsApp antes de convertirse en lead formal), evaluar si tambien hay
     que suscribirse a esos eventos para no perder deduplicacion en esa
     etapa — **pendiente de confirmar si aplica al flujo real de la cuenta**.
4. Si la cuenta esta dividida en varios pipelines (uno para Facebook Ads,
   otro para WhatsApp), considerar usar el query param `?source=` en la URL
   del webhook para que el servicio no dependa de heuristicas para inferir
   la fuente.

## Normalizacion de telefono (Argentina)

La logica completa, con la justificacion de cada regla (codigo de pais,
"9" de celular, "0" de larga distancia, "15" viejo de celular, longitud de
codigo de area segun plan de numeracion de ENACOM), esta documentada como
comentario de cabecera en `src/services/phoneNormalizer.ts`. Los tests en
`tests/phoneNormalizer.test.ts` cubren los casos reales mencionados: con/sin
`9`, con/sin `15`, con/sin `0` de area, con/sin `+54`, Buenos Aires (area 11,
2 digitos) y otras provincias (areas de 3 y 4 digitos).

Filosofia: si un numero no se puede normalizar con confianza, la funcion
devuelve `null` y loguea un warning — **preferimos un falso negativo (no
detectar un duplicado real) a un falso positivo** (avisar de un duplicado
que no existe) en esta fase.

## Idempotencia

Kommo puede reintentar el envio de un webhook. Cada evento se identifica por
`tipo de entidad + id de Kommo + hash del payload` (`src/db/webhookEvents.ts`)
y se guarda en `processed_webhook_events`; un reintento exacto del mismo
evento se ignora sin volver a notificar ni a registrar una fila nueva en
`duplicate_detections`.

## Estructura del proyecto

```
src/
  server.ts                    # bootstrap del servidor
  config.ts                    # carga de variables de entorno
  logger.ts                    # logger JSON estructurado
  routes/
    webhooks.ts                # POST /webhooks/kommo/lead, /webhooks/kommo/contact
    duplicates.ts               # GET /duplicates
    health.ts                  # GET /health
  services/
    kommoClient.ts              # wrapper de la API de Kommo
    phoneNormalizer.ts          # normalizacion de telefono (Argentina)
    duplicateDetector.ts        # logica central de deteccion
    notifier.ts                 # notificaciones (Slack + log)
  db/
    schema.sql                  # DDL de phone_index, duplicate_detections, processed_webhook_events
    index.ts                    # pool de Postgres (pg) + migraciones
    phoneIndex.ts                # acceso a phone_index
    duplicateDetections.ts      # acceso a duplicate_detections
    webhookEvents.ts             # idempotencia de eventos de webhook
  middleware/
    verifyKommoWebhook.ts        # validacion de origen del webhook
  types/
    kommo.ts                    # tipos de los payloads de Kommo
tests/
  phoneNormalizer.test.ts
  duplicateDetector.test.ts
```
