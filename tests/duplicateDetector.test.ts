import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findByPhone: vi.fn(),
  insertPhoneIndex: vi.fn(),
  findExistingPendingDetection: vi.fn(),
  insertDuplicateDetection: vi.fn(),
  buildEventKey: vi.fn(),
  markEventProcessedIfNew: vi.fn(),
  getContactLeadIds: vi.fn(),
  getLead: vi.fn(),
  findContactsByPhoneQuery: vi.fn(),
  appendDetectionNote: vi.fn(),
  loggerError: vi.fn(),
  unifyDuplicate: vi.fn(),
  config: {
    defaultCountryCode: "54",
    dryRun: false,
  },
}));

vi.mock("../src/db/phoneIndex", async () => {
  const actual = await vi.importActual<typeof import("../src/db/phoneIndex")>(
    "../src/db/phoneIndex"
  );
  return {
    ...actual,
    findByPhone: mocks.findByPhone,
    insertPhoneIndex: mocks.insertPhoneIndex,
    // belongsToDifferentEntity se mantiene real: es logica pura que queremos probar de verdad.
  };
});

vi.mock("../src/db/duplicateDetections", () => ({
  appendDetectionNote: mocks.appendDetectionNote,
  findExistingPendingDetection: mocks.findExistingPendingDetection,
  insertDuplicateDetection: mocks.insertDuplicateDetection,
}));

vi.mock("../src/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: mocks.loggerError },
}));

vi.mock("../src/db/webhookEvents", () => ({
  buildEventKey: mocks.buildEventKey,
  markEventProcessedIfNew: mocks.markEventProcessedIfNew,
}));

vi.mock("../src/services/kommoClient", () => ({
  findContactsByPhoneQuery: mocks.findContactsByPhoneQuery,
  getContactLeadIds: mocks.getContactLeadIds,
  getLead: mocks.getLead,
}));

vi.mock("../src/services/duplicateUnifier", async () => {
  const actual = await vi.importActual<typeof import("../src/services/duplicateUnifier")>(
    "../src/services/duplicateUnifier"
  );
  return {
    // resolveWinner es la regla de quien gana: se prueba la real.
    DUPLICATES_PIPELINE_ID: actual.DUPLICATES_PIPELINE_ID,
    resolveWinner: actual.resolveWinner,
    unifyDuplicate: mocks.unifyDuplicate,
  };
});

vi.mock("../src/config", () => ({
  config: mocks.config,
}));

import {
  extractLinkedLeadIds,
  processIncomingEntity,
} from "../src/services/duplicateDetector";
import type { KommoContactEventPayload } from "../src/types/kommo";

const OPEN_STATUS = 111934987;
const SALES_PIPELINE = 14491207;
const DUPLICATES_PIPELINE = 14517971;

/** Evento de contacto (contacts.add/update) con un lead vinculado. */
const BASE_INPUT = {
  entityType: "contact" as const,
  entityId: "40490002",
  contactId: "40490002",
  leadId: "22630002",
  linkedLeadIds: ["22630002"],
  phonesRaw: ["+5491122334455"],
  source: "facebook_ads" as const,
  rawPayload: { id: "40490002" },
};

/** Fila indexada de otro contacto, MAS VIEJO (ids mas bajos) que el del evento. */
const OTHER_ROW = {
  id: 1,
  phone_normalized: "5491122334455",
  kommo_contact_id: "40490001",
  kommo_lead_id: "22630001",
  source: "whatsapp",
  created_at: "2026-01-01",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.defaultCountryCode = "54";
  mocks.config.dryRun = false;
  mocks.buildEventKey.mockReturnValue("contact:contact-1:hash");
  mocks.markEventProcessedIfNew.mockReturnValue(true);
  mocks.findExistingPendingDetection.mockReturnValue(undefined);
  mocks.insertDuplicateDetection.mockResolvedValue({ id: 1 });
  mocks.insertPhoneIndex.mockImplementation(async (input: {
    phoneNormalized: string;
    kommoContactId: string | null;
    kommoLeadId: string | null;
    source: string | null;
  }) => ({
    id: 1,
    phone_normalized: input.phoneNormalized,
    kommo_contact_id: input.kommoContactId,
    kommo_lead_id: input.kommoLeadId,
    source: input.source,
    created_at: "now",
  }));
  mocks.findContactsByPhoneQuery.mockResolvedValue([]);
  mocks.appendDetectionNote.mockResolvedValue(undefined);
  mocks.getContactLeadIds.mockResolvedValue([]);
  mocks.getLead.mockImplementation(async (id: string) => ({
    id: Number(id),
    pipeline_id: SALES_PIPELINE,
    status_id: OPEN_STATUS,
  }));
  mocks.unifyDuplicate.mockResolvedValue({ ok: true, dryRun: false, steps: [], detectionsMarkedMerged: 1 });
});

/** Estados por lead para el mock de getLead (los que no estan, abiertos en ventas). */
function leadStates(states: Record<string, { pipeline_id?: number; status_id?: number }>) {
  mocks.getLead.mockImplementation(async (id: string) => ({
    id: Number(id),
    pipeline_id: states[id]?.pipeline_id ?? SALES_PIPELINE,
    status_id: states[id]?.status_id ?? OPEN_STATUS,
  }));
}

describe("processIncomingEntity - telefono nuevo", () => {
  it("indexa el telefono y no resuelve nada", async () => {
    mocks.findByPhone.mockReturnValue([]);

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.skippedAsRetry).toBe(false);
    expect(result.duplicatesDetected).toBe(0);
    expect(result.phonesIndexed).toBe(1);

    expect(mocks.insertPhoneIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNormalized: "5491122334455",
        kommoContactId: "40490002",
        kommoLeadId: "22630002",
        source: "facebook_ads",
      })
    );

    expect(mocks.insertDuplicateDetection).not.toHaveBeenCalled();
    expect(mocks.unifyDuplicate).not.toHaveBeenCalled();
  });
});

describe("processIncomingEntity - duplicado real: gana el de ids mas altos", () => {
  it("el del evento es mas nuevo: gana el, pierde el indexado", async () => {
    mocks.findByPhone.mockReturnValue([OTHER_ROW]);

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.duplicatesDetected).toBe(1);
    // La deteccion guarda indexado (existing_*) vs evento (new_*), no ganador/perdedor.
    expect(mocks.insertDuplicateDetection).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNormalized: "5491122334455",
        existingContactId: "40490001",
        existingLeadId: "22630001",
        newContactId: "40490002",
        newLeadId: "22630002",
      })
    );

    expect(mocks.unifyDuplicate).toHaveBeenCalledTimes(1);
    expect(mocks.unifyDuplicate).toHaveBeenCalledWith({
      winnerContactId: "40490002",
      winnerLeadId: "22630002",
      loserContactId: "40490001",
      loserLeadId: "22630001",
    });

    // Igual se indexa la nueva entidad para futuros cruces.
    expect(mocks.insertPhoneIndex).toHaveBeenCalledTimes(1);
  });

  it("el indexado es mas nuevo (llega un evento del contacto viejo): gana el indexado", async () => {
    mocks.findByPhone.mockReturnValue([
      { ...OTHER_ROW, kommo_contact_id: "40499999", kommo_lead_id: "22639999" },
    ]);

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.duplicatesDetected).toBe(1);
    expect(mocks.unifyDuplicate).toHaveBeenCalledWith({
      winnerContactId: "40499999",
      winnerLeadId: "22639999",
      loserContactId: "40490002",
      loserLeadId: "22630002",
    });
    // El lead del evento se verifica abierto antes de moverlo.
    expect(mocks.getLead).toHaveBeenCalledWith("22630002");
  });

  it("si la fila indexada no tiene lead, usa el lead abierto del contacto en Kommo", async () => {
    mocks.findByPhone.mockReturnValue([{ ...OTHER_ROW, kommo_lead_id: null }]);
    mocks.getContactLeadIds.mockResolvedValue(["22629999"]);

    await processIncomingEntity(BASE_INPUT);

    expect(mocks.unifyDuplicate).toHaveBeenCalledWith(
      expect.objectContaining({ loserContactId: "40490001", loserLeadId: "22629999" })
    );
  });

  it("ignora los leads cerrados del contacto indexado y usa el unico abierto", async () => {
    mocks.findByPhone.mockReturnValue([OTHER_ROW]);
    mocks.getContactLeadIds.mockResolvedValue(["22630001", "22620000", "22610000"]);
    leadStates({ "22630001": { status_id: 142 }, "22610000": { status_id: 143 } });

    await processIncomingEntity(BASE_INPUT);

    expect(mocks.unifyDuplicate).toHaveBeenCalledWith(
      expect.objectContaining({ loserLeadId: "22620000" })
    );
  });

  it("un lead que ya esta en el embudo Duplicados no cuenta como abierto", async () => {
    mocks.findByPhone.mockReturnValue([OTHER_ROW]);
    mocks.getContactLeadIds.mockResolvedValue(["22630001", "22620000"]);
    leadStates({ "22620000": { pipeline_id: DUPLICATES_PIPELINE, status_id: 112145359 } });

    await processIncomingEntity(BASE_INPUT);

    expect(mocks.unifyDuplicate).toHaveBeenCalledWith(
      expect.objectContaining({ loserLeadId: "22630001" })
    );
  });
});

describe("processIncomingEntity - duplicado que queda en pending_review", () => {
  async function expectPending(reason: string) {
    expect(mocks.insertDuplicateDetection).toHaveBeenCalledTimes(1);
    expect(mocks.unifyDuplicate).not.toHaveBeenCalled();
    expect(mocks.appendDetectionNote).toHaveBeenCalledWith(1, `Sin fusion automatica: ${reason}`);
  }

  it("DRY_RUN=true: registra la deteccion pero NO resuelve (freno de emergencia)", async () => {
    mocks.config.dryRun = true;
    mocks.findByPhone.mockReturnValue([OTHER_ROW]);

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.duplicatesDetected).toBe(1);
    expect(mocks.insertPhoneIndex).toHaveBeenCalledTimes(1);
    expect(mocks.getLead).not.toHaveBeenCalled();
    await expectPending("DRY_RUN=true");
  });

  it("el contacto indexado no tiene leads abiertos (cliente que vuelve)", async () => {
    mocks.findByPhone.mockReturnValue([OTHER_ROW]);
    mocks.getContactLeadIds.mockResolvedValue(["22630001", "22620000"]);
    leadStates({ "22630001": { status_id: 142 }, "22620000": { status_id: 143 } });

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.duplicatesDetected).toBe(1);
    await expectPending("el contacto indexado no tiene leads abiertos");
  });

  it("el contacto indexado tiene varios leads abiertos: no sabemos cual comparar", async () => {
    mocks.findByPhone.mockReturnValue([OTHER_ROW]);
    mocks.getContactLeadIds.mockResolvedValue(["22630001", "22620000"]);

    await processIncomingEntity(BASE_INPUT);

    await expectPending("el contacto indexado tiene varios leads abiertos");
  });

  it("el contacto y el lead no coinciden en cual lado es mas nuevo", async () => {
    // Contacto indexado mas viejo, pero con un lead mas nuevo que el del evento.
    mocks.findByPhone.mockReturnValue([{ ...OTHER_ROW, kommo_lead_id: "22639999" }]);

    await processIncomingEntity(BASE_INPUT);

    await expectPending("los ids de contacto y de lead no coinciden en cual es mas nuevo, revisar a mano");
  });

  it("el lead perdedor (el del evento) ya esta cerrado: no lo mueve", async () => {
    mocks.findByPhone.mockReturnValue([
      { ...OTHER_ROW, kommo_contact_id: "40499999", kommo_lead_id: "22639999" },
    ]);
    leadStates({ "22630002": { status_id: 142 } });

    await processIncomingEntity(BASE_INPUT);

    await expectPending("el lead perdedor ya esta cerrado o en Duplicados");
  });

  it("evento sin lead del contacto (ej: unsorted)", async () => {
    mocks.findByPhone.mockReturnValue([OTHER_ROW]);

    await processIncomingEntity({ ...BASE_INPUT, linkedLeadIds: undefined });

    await expectPending("el evento no trae lead del contacto (ej: unsorted)");
  });

  it("contacto del evento con varios leads", async () => {
    mocks.findByPhone.mockReturnValue([OTHER_ROW]);

    await processIncomingEntity({ ...BASE_INPUT, linkedLeadIds: ["22630002", "22630003"] });

    await expectPending("el contacto del evento tiene varios leads vinculados");
  });

  it("si la resolucion falla, no relanza y no reintenta", async () => {
    mocks.findByPhone.mockReturnValue([OTHER_ROW]);
    mocks.unifyDuplicate.mockResolvedValue({
      ok: false,
      dryRun: false,
      steps: [{ step: "link_loser_lead_to_winner_contact", status: "failed", error: "Kommo API error 400" }],
      detectionsMarkedMerged: 0,
    });

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.duplicatesDetected).toBe(1);
    expect(mocks.unifyDuplicate).toHaveBeenCalledTimes(1);
    expect(mocks.appendDetectionNote).toHaveBeenCalledWith(
      1,
      "Sin fusion automatica: fallo la fusion en el paso link_loser_lead_to_winner_contact: Kommo API error 400"
    );
  });

  it("si Kommo falla al leer los leads, no relanza ni resuelve", async () => {
    mocks.findByPhone.mockReturnValue([OTHER_ROW]);
    mocks.getLead.mockRejectedValue(new Error("Kommo API error 500"));

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.duplicatesDetected).toBe(1);
    expect(result.phonesIndexed).toBe(1);
    expect(mocks.unifyDuplicate).not.toHaveBeenCalled();
  });
});

describe("processIncomingEntity - telefono no indexado: fallback a Kommo", () => {
  it("encuentra un contacto de id MAS BAJO: lo indexa y ese pierde (va a Duplicados)", async () => {
    mocks.findByPhone.mockResolvedValue([]);
    // Caso real Matias Franco: el viejo tiene el telefono sin el 9.
    mocks.findContactsByPhoneQuery.mockResolvedValue([
      { id: "40490001", phones: ["+541122334455"], leadIds: ["22630001"] },
      { id: "40490002", phones: ["+5491122334455"], leadIds: ["22630002"] }, // el propio contacto
      { id: "40480000", phones: ["+5493777808738"], leadIds: ["22620000"] }, // matchea el texto, otro telefono
    ]);

    const result = await processIncomingEntity(BASE_INPUT);

    expect(mocks.findContactsByPhoneQuery).toHaveBeenCalledWith("22334455");
    expect(mocks.insertPhoneIndex).toHaveBeenCalledWith({
      phoneNormalized: "5491122334455",
      kommoContactId: "40490001",
      kommoLeadId: "22630001",
      source: "kommo_lookup",
    });
    expect(result.duplicatesDetected).toBe(1);
    expect(mocks.unifyDuplicate).toHaveBeenCalledWith({
      winnerContactId: "40490002",
      winnerLeadId: "22630002",
      loserContactId: "40490001",
      loserLeadId: "22630001",
    });
  });

  it("encuentra un contacto de id MAS ALTO: gana ese y el del evento va a Duplicados", async () => {
    mocks.findByPhone.mockResolvedValue([]);
    mocks.findContactsByPhoneQuery.mockResolvedValue([
      { id: "40499999", phones: ["+5491122334455"], leadIds: ["22639999"] },
    ]);

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.duplicatesDetected).toBe(1);
    expect(mocks.insertDuplicateDetection).toHaveBeenCalledWith(
      expect.objectContaining({ existingContactId: "40499999", newContactId: "40490002" })
    );
    expect(mocks.unifyDuplicate).toHaveBeenCalledWith({
      winnerContactId: "40499999",
      winnerLeadId: "22639999",
      loserContactId: "40490002",
      loserLeadId: "22630002",
    });
    expect(mocks.appendDetectionNote).not.toHaveBeenCalled();
  });

  it("si en Kommo hay varios, compara contra el de id mas alto", async () => {
    mocks.findByPhone.mockResolvedValue([]);
    mocks.findContactsByPhoneQuery.mockResolvedValue([
      { id: "40400000", phones: ["+5491122334455"], leadIds: ["22600000"] },
      { id: "40490001", phones: ["+5491122334455"], leadIds: ["22630001"] },
    ]);

    await processIncomingEntity(BASE_INPUT);

    expect(mocks.unifyDuplicate).toHaveBeenCalledWith(
      expect.objectContaining({ loserContactId: "40490001", loserLeadId: "22630001" })
    );
  });

  it("sin coincidencias en Kommo: lo trata como nuevo y lo indexa", async () => {
    mocks.findByPhone.mockResolvedValue([]);
    mocks.findContactsByPhoneQuery.mockResolvedValue([
      { id: "40490002", phones: ["+5491122334455"], leadIds: ["22630002"] },
    ]);

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.duplicatesDetected).toBe(0);
    expect(mocks.insertPhoneIndex).toHaveBeenCalledTimes(1);
    expect(mocks.insertPhoneIndex).toHaveBeenCalledWith(
      expect.objectContaining({ kommoContactId: "40490002", source: "facebook_ads" })
    );
  });

  it("si la consulta a Kommo falla, no bloquea: indexa como nuevo y loguea un error visible", async () => {
    mocks.findByPhone.mockResolvedValue([]);
    mocks.findContactsByPhoneQuery.mockRejectedValue(new Error("Kommo API error 429 en /contacts"));

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.duplicatesDetected).toBe(0);
    expect(result.phonesIndexed).toBe(1);
    expect(mocks.insertPhoneIndex).toHaveBeenCalledWith(
      expect.objectContaining({ kommoContactId: "40490002" })
    );
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "KOMMO_LOOKUP_FAILED_PHONE_NOT_VERIFIED",
      expect.objectContaining({
        phoneNormalized: "5491122334455",
        contactId: "40490002",
        error: "Kommo API error 429 en /contacts",
      })
    );
  });

  it("no consulta a Kommo si el telefono ya esta indexado", async () => {
    mocks.findByPhone.mockResolvedValue([OTHER_ROW]);

    await processIncomingEntity(BASE_INPUT);

    expect(mocks.findContactsByPhoneQuery).not.toHaveBeenCalled();
  });
});

describe("processIncomingEntity - varios contactos en el indice local", () => {
  it("compara contra el de id mas alto (el ganador vigente)", async () => {
    mocks.findByPhone.mockResolvedValue([
      { ...OTHER_ROW, id: 1, kommo_contact_id: "40400000", kommo_lead_id: "22600000" },
      { ...OTHER_ROW, id: 2, kommo_contact_id: "40490001", kommo_lead_id: "22630001" },
    ]);

    await processIncomingEntity(BASE_INPUT);

    expect(mocks.unifyDuplicate).toHaveBeenCalledWith(
      expect.objectContaining({ loserContactId: "40490001", loserLeadId: "22630001" })
    );
  });
});

describe("processIncomingEntity - no es duplicado", () => {
  it("no considera duplicado si la fila existente es de la MISMA entidad", async () => {
    mocks.findByPhone.mockReturnValue([{ ...OTHER_ROW, kommo_contact_id: "40490002", kommo_lead_id: "22630002" }]);

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.duplicatesDetected).toBe(0);
    expect(mocks.insertDuplicateDetection).not.toHaveBeenCalled();
    expect(mocks.unifyDuplicate).not.toHaveBeenCalled();
  });

  it("no reprocesa un evento ya visto (reintento de webhook)", async () => {
    mocks.markEventProcessedIfNew.mockReturnValue(false);

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.skippedAsRetry).toBe(true);
    expect(mocks.findByPhone).not.toHaveBeenCalled();
    expect(mocks.insertPhoneIndex).not.toHaveBeenCalled();
    expect(mocks.unifyDuplicate).not.toHaveBeenCalled();
  });

  it("deteccion ya registrada: no vuelve a insertar ni a fusionar (sin reintentos)", async () => {
    mocks.findByPhone.mockReturnValue([OTHER_ROW]);
    mocks.findExistingPendingDetection.mockReturnValue({ id: 99 });

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.duplicatesDetected).toBe(0);
    expect(mocks.insertDuplicateDetection).not.toHaveBeenCalled();
    expect(mocks.unifyDuplicate).not.toHaveBeenCalled();
  });

  it("telefono que no se puede normalizar: no indexa ni compara", async () => {
    const result = await processIncomingEntity({ ...BASE_INPUT, phonesRaw: ["abc"] });

    expect(result.phonesUnableToNormalize).toBe(1);
    expect(result.phonesIndexed).toBe(0);
    expect(mocks.findByPhone).not.toHaveBeenCalled();
    expect(mocks.insertPhoneIndex).not.toHaveBeenCalled();
  });
});

/**
 * Payload real capturado (rudas.kommo.com, 2026-09-23 18:45 UTC): contacto
 * "test 22" creado a mano en Kommo con el mismo telefono que el contacto
 * "test" (40487438), ya indexado antes. Llego como contacts.update, vinculado
 * al lead 22627634.
 */
const TEST_22_CONTACT: KommoContactEventPayload = {
  id: "40487830",
  name: "test 22",
  responsible_user_id: "12280712",
  custom_fields: [
    {
      id: "731676",
      name: "Teléfono",
      values: [{ value: "+5491100000003", enum: "552420" }],
      code: "PHONE",
    },
  ],
  linked_leads_id: {
    "22627634": { ID: "22627634" },
  },
};

// Fila real de phone_index del contacto "test" (indexado sin lead).
const TEST_EXISTING_ROW = {
  id: 282,
  phone_normalized: "5491100000003",
  kommo_contact_id: "40487438",
  kommo_lead_id: null,
  source: "unknown",
  created_at: "2026-09-23 18:41:12",
};

/** Arma el input igual que processContactEvents en routes/webhooks.ts. */
function contactInput(contact: KommoContactEventPayload) {
  const linkedLeadIds = extractLinkedLeadIds(contact.linked_leads_id);
  return {
    entityType: "contact" as const,
    entityId: contact.id,
    contactId: contact.id,
    leadId: linkedLeadIds[0] ?? null,
    linkedLeadIds,
    phonesRaw: ["+5491100000003"],
    source: "unknown" as const,
    rawPayload: contact,
  };
}

describe("extractLinkedLeadIds", () => {
  it("extrae el lead vinculado del payload real de 'test 22'", () => {
    expect(extractLinkedLeadIds(TEST_22_CONTACT.linked_leads_id)).toEqual(["22627634"]);
  });

  it("devuelve todos los leads cuando hay mas de uno vinculado", () => {
    expect(
      extractLinkedLeadIds({
        "22627634": { ID: "22627634" },
        "22627700": { ID: "22627700" },
      })
    ).toEqual(["22627634", "22627700"]);
  });

  it("devuelve array vacio si no hay linked_leads_id", () => {
    expect(extractLinkedLeadIds(undefined)).toEqual([]);
    expect(extractLinkedLeadIds({})).toEqual([]);
  });
});

describe("processIncomingEntity - caso real 'test 22'", () => {
  it("'test 22' es el mas nuevo: gana, y el lead 22627454 de 'test' va a Duplicados", async () => {
    mocks.findByPhone.mockReturnValue([TEST_EXISTING_ROW]);
    // Lead real de "test" (40487438) segun la API.
    mocks.getContactLeadIds.mockResolvedValue(["22627454"]);

    const result = await processIncomingEntity(contactInput(TEST_22_CONTACT));

    expect(result.duplicatesDetected).toBe(1);
    expect(mocks.insertDuplicateDetection).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNormalized: "5491100000003",
        existingContactId: "40487438",
        newContactId: "40487830",
        newLeadId: "22627634",
      })
    );
    expect(mocks.unifyDuplicate).toHaveBeenCalledWith({
      winnerContactId: "40487830",
      winnerLeadId: "22627634",
      loserContactId: "40487438",
      loserLeadId: "22627454",
    });

    // El contacto se indexa con su lead, asi futuros duplicados ya lo tienen.
    expect(mocks.insertPhoneIndex).toHaveBeenCalledWith(
      expect.objectContaining({ kommoContactId: "40487830", kommoLeadId: "22627634" })
    );
  });

  it("guarda existingLeadId cuando la fila indexada tiene lead", async () => {
    mocks.findByPhone.mockReturnValue([{ ...TEST_EXISTING_ROW, kommo_lead_id: "22627454" }]);

    await processIncomingEntity(contactInput(TEST_22_CONTACT));

    expect(mocks.insertDuplicateDetection).toHaveBeenCalledWith(
      expect.objectContaining({ existingLeadId: "22627454", newLeadId: "22627634" })
    );
  });
});
