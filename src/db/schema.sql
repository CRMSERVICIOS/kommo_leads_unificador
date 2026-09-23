-- Indice propio de telefono -> contacto/lead de Kommo.
-- Es la fuente de verdad para detectar duplicados (no confiamos en el
-- buscador nativo de Kommo porque no cruza formatos de telefono distintos).
CREATE TABLE IF NOT EXISTS phone_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_normalized TEXT NOT NULL,
  kommo_contact_id TEXT,
  kommo_lead_id TEXT,
  source TEXT,                 -- 'facebook_ads', 'whatsapp', etc.
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_phone_index_phone ON phone_index(phone_normalized);

-- Auditoria de cada deteccion de posible duplicado. Fase 1: siempre queda
-- en 'pending_review', un humano decide manualmente en la UI de Kommo si
-- fusiona o no. Fase 2 (futura, no implementada) podria automatizar esto.
CREATE TABLE IF NOT EXISTS duplicate_detections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_normalized TEXT NOT NULL,
  existing_contact_id TEXT,
  existing_lead_id TEXT,
  new_contact_id TEXT,
  new_lead_id TEXT,
  status TEXT DEFAULT 'pending_review',  -- pending_review | reviewed_merged | reviewed_ignored
  detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_duplicate_detections_status ON duplicate_detections(status);

-- Idempotencia de webhooks: Kommo puede reintentar el envio de un mismo
-- evento. Guardamos un hash del payload + el id de entidad para no
-- reprocesar (y por lo tanto no re-notificar / no duplicar filas en
-- duplicate_detections) el mismo evento dos veces.
CREATE TABLE IF NOT EXISTS processed_webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,   -- ej: `${entityType}:${entityId}:${payloadHash}`
  processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
