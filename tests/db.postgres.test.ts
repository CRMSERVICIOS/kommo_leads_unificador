import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests de la capa de datos contra un Postgres real (no mocks).
 * Levantar la base con `npm run test:db:up` (docker compose, puerto 5433,
 * base dedup_test). Se puede apuntar a otra con TEST_DATABASE_URL.
 */
const { TEST_DATABASE_URL } = vi.hoisted(() => ({
  TEST_DATABASE_URL:
    process.env.TEST_DATABASE_URL ?? "postgresql://dedup:dedup@localhost:5433/dedup_test",
}));

// Los tests hacen TRUNCATE: nunca correrlos contra una base que no sea de test.
if (!/test/i.test(new URL(TEST_DATABASE_URL).pathname)) {
  throw new Error(`TEST_DATABASE_URL tiene que apuntar a una base de test (recibido: ${TEST_DATABASE_URL})`);
}

const mocks = vi.hoisted(() => ({
  getContactLeadIds: vi.fn(),
  getLead: vi.fn(),
  findContactsByPhoneQuery: vi.fn(),
  listContactsPage: vi.fn(),
  unifyDuplicate: vi.fn(),
}));

vi.mock("../src/config", () => ({
  config: {
    databaseUrl: TEST_DATABASE_URL,
    databaseCaCert: "",
    defaultCountryCode: "54",
    dryRun: false,
  },
}));

vi.mock("../src/services/kommoClient", () => ({
  findContactsByPhoneQuery: mocks.findContactsByPhoneQuery,
  getContactLeadIds: mocks.getContactLeadIds,
  getLead: mocks.getLead,
  listContactsPage: mocks.listContactsPage,
}));

vi.mock("../src/services/duplicateUnifier", async () => {
  const actual = await vi.importActual<typeof import("../src/services/duplicateUnifier")>(
    "../src/services/duplicateUnifier"
  );
  return {
    DUPLICATES_PIPELINE_ID: actual.DUPLICATES_PIPELINE_ID,
    DUPLICATES_STATUS_ID: actual.DUPLICATES_STATUS_ID,
    resolveWinner: actual.resolveWinner,
    unifyDuplicate: mocks.unifyDuplicate,
  };
});

import { closeDb, getPool, runMigrations } from "../src/db";
import {
  findExistingPendingDetection,
  insertDuplicateDetection,
  listDetectionsByStatus,
  markDetectionsMergedForContacts,
} from "../src/db/duplicateDetections";
import { findByPhone, insertPhoneIndex } from "../src/db/phoneIndex";
import { buildEventKey, markEventProcessedIfNew } from "../src/db/webhookEvents";
import { backfillPhoneIndex } from "../src/jobs/backfillIndex";
import { processIncomingEntity } from "../src/services/duplicateDetector";

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await getPool().query(
    "TRUNCATE phone_index, duplicate_detections, processed_webhook_events RESTART IDENTITY"
  );
  mocks.getContactLeadIds.mockResolvedValue([]);
  mocks.findContactsByPhoneQuery.mockResolvedValue([]);
  mocks.getLead.mockResolvedValue({ id: 1, pipeline_id: 14491207, status_id: 111934987 });
  mocks.unifyDuplicate.mockResolvedValue({ ok: true, dryRun: false, steps: [], detectionsMarkedMerged: 1 });
});

afterAll(async () => {
  await closeDb();
});

describe("schema", () => {
  it("las migraciones son idempotentes (se corren en cada arranque)", async () => {
    await runMigrations();
    await runMigrations();

    const tables = await getPool().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(["duplicate_detections", "phone_index", "processed_webhook_events"])
    );
  });

  it("mantiene los nombres de columna del schema SQLite original", async () => {
    const cols = await getPool().query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`
    );
    const byTable = (t: string) => cols.rows.filter((r) => r.table_name === t).map((r) => r.column_name);

    expect(byTable("phone_index")).toEqual([
      "id", "phone_normalized", "kommo_contact_id", "kommo_lead_id", "source", "created_at",
    ]);
    expect(byTable("duplicate_detections")).toEqual([
      "id", "phone_normalized", "existing_contact_id", "existing_lead_id",
      "new_contact_id", "new_lead_id", "status", "detected_at", "notes",
    ]);
    expect(byTable("processed_webhook_events")).toEqual(["id", "event_key", "processed_at"]);
  });
});

describe("phone_index", () => {
  it("inserta y busca por telefono, en orden de llegada, con ids numericos", async () => {
    const first = await insertPhoneIndex({
      phoneNormalized: "5491100000009",
      kommoContactId: "1",
      kommoLeadId: "10",
      source: "whatsapp",
    });
    await insertPhoneIndex({ phoneNormalized: "5491100000009", kommoContactId: "2", kommoLeadId: null, source: null });
    await insertPhoneIndex({ phoneNormalized: "5490000000000", kommoContactId: "3", kommoLeadId: null, source: null });

    expect(first).toMatchObject({ id: 1, kommo_contact_id: "1", kommo_lead_id: "10", source: "whatsapp" });
    const rows = await findByPhone("5491100000009");
    expect(rows.map((r) => r.kommo_contact_id)).toEqual(["1", "2"]);
    expect(typeof rows[0].id).toBe("number");
  });
});

describe("processed_webhook_events", () => {
  it("devuelve true la primera vez y false en el reintento", async () => {
    const key = buildEventKey("contact", "40487830", { a: 1 });

    expect(await markEventProcessedIfNew(key)).toBe(true);
    expect(await markEventProcessedIfNew(key)).toBe(false);
  });
});

describe("duplicate_detections", () => {
  it("findExistingPendingDetection matchea NULLs (IS NOT DISTINCT FROM)", async () => {
    await insertDuplicateDetection({
      phoneNormalized: "5491100000009",
      existingContactId: "1",
      existingLeadId: null,
      newContactId: "2",
      newLeadId: null,
    });

    expect(await findExistingPendingDetection("5491100000009", "2", null)).toMatchObject({ new_contact_id: "2" });
    expect(await findExistingPendingDetection("5491100000009", "2", "99")).toBeUndefined();
  });

  it("markDetectionsMergedForContacts cierra el par en ambos sentidos y solo pendientes", async () => {
    const base = { phoneNormalized: "5491100000009", existingLeadId: null, newLeadId: null };
    await insertDuplicateDetection({ ...base, existingContactId: "A", newContactId: "B" });
    await insertDuplicateDetection({ ...base, existingContactId: "B", newContactId: "A" }); // eco
    await insertDuplicateDetection({ ...base, existingContactId: "A", newContactId: "C" }); // otro par

    expect(await markDetectionsMergedForContacts("A", "B")).toBe(2);
    expect(await markDetectionsMergedForContacts("A", "B")).toBe(0);

    const pending = await listDetectionsByStatus("pending_review");
    expect(pending.map((d) => d.new_contact_id)).toEqual(["C"]);
    expect(await listDetectionsByStatus("reviewed_merged")).toHaveLength(2);
    expect(await listDetectionsByStatus(undefined)).toHaveLength(3);
  });
});

describe("detector contra Postgres real", () => {
  const contactEvent = (contactId: string, leadId: string, payload: unknown = { contactId, leadId }) => ({
    entityType: "contact" as const,
    entityId: contactId,
    contactId,
    leadId,
    linkedLeadIds: [leadId],
    phonesRaw: ["+5491100000009"],
    source: "unknown" as const,
    rawPayload: payload,
  });

  it("indexa, detecta el duplicado, lo persiste y fusiona; el reintento no hace nada", async () => {
    await processIncomingEntity(contactEvent("40490001", "22630001"));
    const result = await processIncomingEntity(contactEvent("40490002", "22630002"));
    const retry = await processIncomingEntity(contactEvent("40490002", "22630002"));

    expect(result.duplicatesDetected).toBe(1);
    expect(retry.skippedAsRetry).toBe(true);

    const detections = await listDetectionsByStatus(undefined);
    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({
      phone_normalized: "5491100000009",
      existing_contact_id: "40490001",
      existing_lead_id: "22630001",
      new_contact_id: "40490002",
      new_lead_id: "22630002",
      status: "pending_review", // el unifier esta mockeado; el real lo pasa a reviewed_merged
    });
    expect(mocks.unifyDuplicate).toHaveBeenCalledTimes(1);
    expect(mocks.unifyDuplicate).toHaveBeenCalledWith({
      winnerContactId: "40490002",
      winnerLeadId: "22630002",
      loserContactId: "40490001",
      loserLeadId: "22630001",
    });
    expect(await findByPhone("5491100000009")).toHaveLength(2);
  });

  it("los datos persisten entre conexiones (cerrar y reabrir el pool)", async () => {
    await insertPhoneIndex({ phoneNormalized: "5491100000009", kommoContactId: "1", kommoLeadId: null, source: null });

    await closeDb();

    expect(await findByPhone("5491100000009")).toHaveLength(1);
  });
});

describe("detector + fallback a Kommo contra Postgres real", () => {
  it("telefono no indexado que existe en Kommo en un contacto mas viejo: lo indexa, registra y ese pierde", async () => {
    mocks.findContactsByPhoneQuery.mockResolvedValue([
      { id: "40400000", phones: ["+541100000009"], leadIds: ["22600000"] },
    ]);

    const result = await processIncomingEntity({
      entityType: "contact",
      entityId: "40490002",
      contactId: "40490002",
      leadId: "22630002",
      linkedLeadIds: ["22630002"],
      phonesRaw: ["+5491100000009"],
      source: "unknown",
      rawPayload: { id: "40490002" },
    });

    expect(result.duplicatesDetected).toBe(1);
    const rows = await findByPhone("5491100000009");
    expect(rows.map((r) => [r.kommo_contact_id, r.source])).toEqual([
      ["40400000", "kommo_lookup"],
      ["40490002", "unknown"],
    ]);
    expect(mocks.unifyDuplicate).toHaveBeenCalledWith({
      winnerContactId: "40490002",
      winnerLeadId: "22630002",
      loserContactId: "40400000",
      loserLeadId: "22600000",
    });
  });

  it("contacto y lead no coinciden en cual es mas nuevo: queda pending_review con el motivo en notes", async () => {
    // Contacto de Kommo mas nuevo que el del evento, pero con un lead mas viejo.
    mocks.findContactsByPhoneQuery.mockResolvedValue([
      { id: "40499999", phones: ["+5491100000009"], leadIds: ["22620000"] },
    ]);

    await processIncomingEntity({
      entityType: "contact",
      entityId: "40490002",
      contactId: "40490002",
      leadId: "22630002",
      linkedLeadIds: ["22630002"],
      phonesRaw: ["+5491100000009"],
      source: "unknown",
      rawPayload: { id: "40490002" },
    });

    const [detection] = await listDetectionsByStatus("pending_review");
    expect(detection.notes).toContain(
      "Sin fusion automatica: los ids de contacto y de lead no coinciden en cual es mas nuevo, revisar a mano"
    );
    expect(mocks.unifyDuplicate).not.toHaveBeenCalled();
  });
});

describe("backfill del indice", () => {
  const page1 = {
    contacts: [
      { id: "100", phones: ["+5491100000001"], leadIds: ["900"] },
      { id: "101", phones: ["+541100000001"], leadIds: [] }, // mismo telefono, otro formato
      { id: "102", phones: [], leadIds: ["902"] }, // sin telefono
    ],
    hasMore: true,
  };
  const page2 = {
    contacts: [
      { id: "103", phones: ["abc", "+5491100000003", "+54 9 11 0000-0003"], leadIds: ["903"] },
    ],
    hasMore: false,
  };

  it("indexa todos los contactos paginando, sin generar detecciones", async () => {
    mocks.listContactsPage.mockImplementation(async (page: number) => (page === 1 ? page1 : page2));

    const stats = await backfillPhoneIndex({ delayMs: 0 });

    expect(mocks.listContactsPage.mock.calls.map((c) => c[0])).toEqual([1, 2]);
    expect(stats).toEqual({
      pages: 2,
      contacts: 4,
      contactsWithoutPhone: 1,
      phonesIndexed: 3,
      phonesAlreadyIndexed: 0,
      phonesUnableToNormalize: 1,
    });

    const phone1 = await findByPhone("5491100000001");
    expect(phone1.map((r) => [r.kommo_contact_id, r.kommo_lead_id, r.source])).toEqual([
      ["100", "900", "backfill"],
      ["101", null, "backfill"],
    ]);
    expect(await findByPhone("5491100000003")).toHaveLength(1); // dos formatos del mismo telefono = una fila
    expect(await listDetectionsByStatus(undefined)).toHaveLength(0);
    expect(mocks.unifyDuplicate).not.toHaveBeenCalled();
  });

  it("es re-ejecutable: la segunda corrida no duplica filas", async () => {
    mocks.listContactsPage.mockImplementation(async (page: number) => (page === 1 ? page1 : page2));

    await backfillPhoneIndex({ delayMs: 0 });
    const second = await backfillPhoneIndex({ delayMs: 0 });

    expect(second.phonesIndexed).toBe(0);
    expect(second.phonesAlreadyIndexed).toBe(3);
    const total = await getPool().query("SELECT count(*)::int AS n FROM phone_index");
    expect(total.rows[0].n).toBe(3);
  });

  it("reintenta una pagina que falla (error de red) y sigue", async () => {
    let failures = 0;
    mocks.listContactsPage.mockImplementation(async (page: number) => {
      if (page === 2 && failures < 2) {
        failures += 1;
        throw new Error("fetch failed");
      }
      return page === 1 ? page1 : page2;
    });

    const stats = await backfillPhoneIndex({ delayMs: 0 });

    expect(failures).toBe(2);
    expect(stats.pages).toBe(2);
    expect(stats.phonesIndexed).toBe(3);
  });

  it("si una pagina falla todos los intentos, corta con un error claro", async () => {
    mocks.listContactsPage.mockRejectedValue(new Error("Kommo API error 500"));

    await expect(backfillPhoneIndex({ delayMs: 0, maxAttempts: 3 })).rejects.toThrow(
      "pagina 1: Kommo API error 500 (despues de 3 intentos)"
    );
  });

  it("dry-run: cuenta pero no escribe", async () => {
    mocks.listContactsPage.mockImplementation(async (page: number) => (page === 1 ? page1 : page2));

    const stats = await backfillPhoneIndex({ delayMs: 0, dryRun: true });

    expect(stats.phonesIndexed).toBe(3);
    const total = await getPool().query("SELECT count(*)::int AS n FROM phone_index");
    expect(total.rows[0].n).toBe(0);
  });
});
