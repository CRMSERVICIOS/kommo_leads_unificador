import { config } from "../config";
import { closeDb, runMigrations } from "../db";
import { insertPhoneIndexIfMissing } from "../db/phoneIndex";
import { logger } from "../logger";
import { listContactsPage } from "../services/kommoClient";
import { normalizePhone } from "../services/phoneNormalizer";

export interface BackfillStats {
  pages: number;
  contacts: number;
  contactsWithoutPhone: number;
  phonesIndexed: number;
  phonesAlreadyIndexed: number;
  phonesUnableToNormalize: number;
}

export interface BackfillOptions {
  /** Solo cuenta, no escribe en phone_index. */
  dryRun?: boolean;
  /** Pausa entre paginas, para no pasarse del limite de Kommo (7 req/s). */
  delayMs?: number;
  /** Intentos por pagina ante errores de red o de Kommo (429, 5xx). */
  maxAttempts?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pide una pagina reintentando con espera creciente (1s, 2s, 4s...). */
async function fetchPageWithRetry(page: number, maxAttempts: number, baseDelayMs: number) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await listContactsPage(page);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (attempt >= maxAttempts) throw new Error(`pagina ${page}: ${error} (despues de ${attempt} intentos)`);
      const waitMs = baseDelayMs * 2 ** (attempt - 1);
      logger.warn("backfill_page_retry", { page, attempt, waitMs, error });
      await sleep(waitMs);
    }
  }
}

/**
 * Carga inicial de phone_index con todos los contactos de Kommo. Solo indexa:
 * no registra detecciones ni fusiona nada, aunque haya telefonos repetidos.
 * Se puede correr mas de una vez (no duplica filas telefono + contacto).
 */
export async function backfillPhoneIndex(options: BackfillOptions = {}): Promise<BackfillStats> {
  const { dryRun = false, delayMs = 200, maxAttempts = 5 } = options;
  const stats: BackfillStats = {
    pages: 0,
    contacts: 0,
    contactsWithoutPhone: 0,
    phonesIndexed: 0,
    phonesAlreadyIndexed: 0,
    phonesUnableToNormalize: 0,
  };

  for (let page = 1; ; page += 1) {
    const { contacts, hasMore } = await fetchPageWithRetry(page, maxAttempts, delayMs > 0 ? 1000 : 0);
    stats.pages += 1;

    for (const contact of contacts) {
      stats.contacts += 1;
      if (contact.phones.length === 0) {
        stats.contactsWithoutPhone += 1;
        continue;
      }

      const normalizedPhones = new Set<string>();
      for (const raw of contact.phones) {
        const normalized = normalizePhone(raw, config.defaultCountryCode);
        if (normalized) normalizedPhones.add(normalized);
        else stats.phonesUnableToNormalize += 1;
      }

      for (const phoneNormalized of normalizedPhones) {
        if (dryRun) {
          stats.phonesIndexed += 1;
          continue;
        }
        const inserted = await insertPhoneIndexIfMissing({
          phoneNormalized,
          kommoContactId: contact.id,
          kommoLeadId: contact.leadIds[0] ?? null,
          source: "backfill",
        });
        if (inserted) stats.phonesIndexed += 1;
        else stats.phonesAlreadyIndexed += 1;
      }
    }

    logger.info("backfill_page_done", { page, contactsInPage: contacts.length, ...stats });
    if (!hasMore || contacts.length === 0) break;
    if (delayMs > 0) await sleep(delayMs);
  }

  logger.info("backfill_finished", { dryRun, ...stats });
  return stats;
}

// `npm run backfill-index [-- --dry-run]` (en produccion: node dist/jobs/backfillIndex.js)
if (require.main === module) {
  const dryRun = process.argv.includes("--dry-run");
  runMigrations()
    .then(() => backfillPhoneIndex({ dryRun }))
    .then(() => closeDb())
    .catch(async (err) => {
      logger.error("backfill_failed", { error: err instanceof Error ? err.message : String(err) });
      await closeDb();
      process.exit(1);
    });
}
