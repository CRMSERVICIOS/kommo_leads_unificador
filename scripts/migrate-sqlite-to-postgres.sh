#!/usr/bin/env bash
# Copia los datos del SQLite viejo a Postgres (una sola vez, al migrar).
# Uso: scripts/migrate-sqlite-to-postgres.sh ./data/dedup.sqlite "postgresql://..."
# Requiere los CLIs sqlite3 y psql. Las tablas destino tienen que existir
# (npm run db:migrate) y estar vacias: el script aborta si no lo estan.
set -euo pipefail

SQLITE_PATH="${1:?ruta al archivo sqlite}"
PG_URL="${2:?connection string de Postgres}"
TABLES=(phone_index duplicate_detections processed_webhook_events)

for t in "${TABLES[@]}"; do
  n=$(psql "$PG_URL" -tAc "SELECT count(*) FROM $t")
  if [ "$n" != "0" ]; then
    echo "La tabla $t ya tiene $n filas en Postgres; aborto para no duplicar datos." >&2
    exit 1
  fi
done

copy_table() {
  local table="$1" columns="$2"
  sqlite3 -csv "$SQLITE_PATH" "SELECT $columns FROM $table ORDER BY id" \
    | psql "$PG_URL" -v ON_ERROR_STOP=1 -c "\copy $table ($columns) FROM STDIN WITH (FORMAT csv)"
  # Los ids se copian tal cual: se adelanta la secuencia para que los nuevos no choquen.
  psql "$PG_URL" -v ON_ERROR_STOP=1 -tAc \
    "SELECT setval(pg_get_serial_sequence('$table', 'id'), COALESCE((SELECT max(id) FROM $table), 0) + 1, false)" >/dev/null
  echo "$table: $(psql "$PG_URL" -tAc "SELECT count(*) FROM $table") filas"
}

copy_table phone_index "id, phone_normalized, kommo_contact_id, kommo_lead_id, source, created_at"
copy_table duplicate_detections "id, phone_normalized, existing_contact_id, existing_lead_id, new_contact_id, new_lead_id, status, detected_at, notes"
copy_table processed_webhook_events "id, event_key, processed_at"
