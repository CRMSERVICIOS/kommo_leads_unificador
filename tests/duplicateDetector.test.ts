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
    duplicateLossReasonId: 38469131 as number | null,
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

vi.mock("../src/services/duplicateUnifier", () => ({
  CLOSED_WON_STATUS_ID: 142,
  CLOSED_LOST_STATUS_ID: 143,
  unifyDuplicate: mocks.unifyDuplicate,
}));

vi.mock("../src/config", () => ({
  config: mocks.config,
}));

import {
  extractLinkedLeadIds,
  processIncomingEntity,
} from "../src/services/duplicateDetector";
import type { KommoContactEventPayload } from "../src/types/kommo";

const OPEN_STATUS = 111934987;

/** Evento de contacto (contacts.add/update) con un lead vinculado. */
const BASE_INPUT = {
  entityType: "contact" as const,
  entityId: "40490002",
  contactId: "40490002",
  leadId: "lead-1",
  linkedLeadIds: ["lead-1"],
  phonesRaw: ["+5491122334455"],
  source: "facebook_ads" as const,
  rawPayload: { id: "40490002" },
};

const OTHER_ROW = {
  id: 1,
  phone_normalized: "5491122334455",
  kommo_contact_id: "40490001",
  kommo_lead_id: "lead-OTHER",
  source: "whatsapp",
  created_at: "2026-01-01",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.defaultCountryCode = "54";
  mocks.config.dryRun = false;
  mocks.config.duplicateLossReasonId = 38469131;
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
    id: Number(id) || 1,
    pipeline_id: 14491207,
    status_id: OPEN_STATUS,
  }));
  mocks.unifyDuplicate.mockResolvedValue({ ok: true, dryRun: false, steps: [], detectionsMarkedMerged: 1 });
});

describe("processIncomingEntity - telefono nuevo", () => {
  it("indexa el telefono y no fusiona nada", async () => {
    mocks.findByPhone.mockReturnValue([]);

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.skippedAsRetry).toBe(false);
    expect(result.duplicatesDetected).toBe(0);
    expect(result.phonesIndexed).toBe(1);

    expect(mocks.insertPhoneIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNormalized: "5491122334455",
        kommoContactId: "40490002",
        kommoLeadId: "lead-1",
        source: "facebook_ads",
      })
    );

    expect(mocks.insertDuplicateDetection).not.toHaveBeenCalled();
    expect(mocks.unifyDuplicate).not.toHaveBeenCalled();
  });
});

describe("processIncomingEntity - duplicado real: fusion automatica", () => {
  it("registra la deteccion y fusiona con el contacto existente como ganador", async () => {
    mocks.findByPhone.mockReturnValue([OTHER_ROW]);

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.duplicatesDetected).toBe(1);
    expect(mocks.insertDuplicateDetection).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNormalized: "5491122334455",
        existingContactId: "40490001",
        existingLeadId: "lead-OTHER",
        newContactId: "40490002",
        newLeadId: "lead-1",
      })
    );

    expect(mocks.unifyDuplicate).toHaveBeenCalledTimes(1);
    expect(mocks.unifyDuplicate).toHaveBeenCalledWith(
      {
        existingContactId: "40490001",
        existingLeadId: "lead-OTHER",
        newContactId: "40490002",
        newLeadId: "lead-1",
      },
      { lossReasonId: 38469131 }
    );

    // Igual se indexa la nueva entidad para futuros cruces.
    expect(mocks.insertPhoneIndex).toHaveBeenCalledTimes(1);
  });

  it("si la fila existente no tiene lead, usa un lead abierto del contacto en Kommo", async () => {
    mocks.findByPhone.mockReturnValue([{ ...OTHER_ROW, kommo_lead_id: null }]);
    mocks.getContactLeadIds.mockResolvedValue(["lead-FROM-KOMMO"]);

    await processIncomingEntity(BASE_INPUT);

    expect(mocks.unifyDuplicate).toHaveBeenCalledWith(
      expect.objectContaining({ existingLeadId: "lead-FROM-KOMMO" }),
      expect.anything()
    );
  });

  it("si el lead del ganador esta cerrado, elige otro lead abierto del mismo contacto", async () => {
    mocks.findByPhone.mockReturnValue([OTHER_ROW]);
    mocks.getContactLeadIds.mockResolvedValue(["lead-OTHER", "lead-OPEN"]);
    mocks.getLead.mockImplementation(async (id: string) => ({
      id: 1,
      pipeline_id: 1,
      status_id: id === "lead-OTHER" ? 142 : OPEN_STATUS,
    }));

    await processIncomingEntity(BASE_INPUT);

    expect(mocks.unifyDuplicate).toHaveBeenCalledWith(
      expect.objectContaining({ existingLeadId: "lead-OPEN" }),
      expect.anything()
    );
  });
});

describe("processIncomingEntity - duplicado que queda en pending_review", () => {
  it("DRY_RUN=true: registra la deteccion pero NO fusiona (freno de emergencia)", async () => {
    mocks.config.dryRun = true;
    mocks.findByPhone.mockReturnValue([OTHER_ROW]);

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.duplicatesDetected).toBe(1);
    expect(mocks.insertDuplicateDetection).toHaveBeenCalledTimes(1);
    expect(mocks.insertPhoneIndex).toHaveBeenCalledTimes(1);
    expect(mocks.unifyDuplicate).not.toHaveBeenCalled();
    expect(mocks.getLead).not.toHaveBeenCalled();
  });

  it("el contacto existente no tiene leads abiertos (cliente que vuelve): no fusiona", async () => {
    mocks.findByPhone.mockReturnValue([OTHER_ROW]);
    mocks.getContactLeadIds.mockResolvedValue(["lead-OTHER", "lead-OLD"]);
    mocks.getLead.mockImplementation(async (id: string) => ({
      id: 1,
      pipeline_id: 1,
      status_id: id === "lead-OTHER" ? 142 : 143,
    }));

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.duplicatesDetected).toBe(1);
    expect(mocks.insertDuplicateDetection).toHaveBeenCalledTimes(1);
    expect(mocks.unifyDuplicate).not.toHaveBeenCalled();
  });

  it("evento sin lead del contacto nuevo (ej: unsorted): no fusiona", async () => {
    mocks.findByPhone.mockReturnValue([OTHER_ROW]);

    await processIncomingEntity({ ...BASE_INPUT, leadId: "lead-1", linkedLeadIds: undefined });

    expect(mocks.insertDuplicateDetection).toHaveBeenCalledTimes(1);
    expect(mocks.unifyDuplicate).not.toHaveBeenCalled();
  });

  it("contacto nuevo con varios leads: no fusiona (no sabemos cual cerrar)", async () => {
    mocks.findByPhone.mockReturnValue([OTHER_ROW]);

    await processIncomingEntity({ ...BASE_INPUT, linkedLeadIds: ["lead-1", "lead-2"] });

    expect(mocks.insertDuplicateDetection).toHaveBeenCalledTimes(1);
    expect(mocks.unifyDuplicate).not.toHaveBeenCalled();
  });

  it("si la fusion falla, no relanza y no reintenta", async () => {
    mocks.findByPhone.mockReturnValue([OTHER_ROW]);
    mocks.unifyDuplicate.mockResolvedValue({
      ok: false,
      dryRun: false,
      steps: [{ step: "link_new_lead_to_existing_contact", status: "failed", error: "Kommo API error 400" }],
      detectionsMarkedMerged: 0,
    });

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.duplicatesDetected).toBe(1);
    expect(mocks.unifyDuplicate).toHaveBeenCalledTimes(1);
  });

  it("si Kommo falla al elegir el lead ganador, no relanza ni fusiona", async () => {
    mocks.findByPhone.mockReturnValue([OTHER_ROW]);
    mocks.getLead.mockRejectedValue(new Error("Kommo API error 500"));

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.duplicatesDetected).toBe(1);
    expect(result.phonesIndexed).toBe(1);
    expect(mocks.unifyDuplicate).not.toHaveBeenCalled();
  });
});

describe("processIncomingEntity - telefono no indexado: fallback a Kommo", () => {
  it("busca en Kommo por los ultimos 8 digitos; si hay un contacto mas viejo, lo indexa y fusiona contra el", async () => {
    mocks.findByPhone.mockResolvedValue([]);
    // Caso real Matias Franco: el viejo tiene el telefono sin el 9.
    mocks.findContactsByPhoneQuery.mockResolvedValue([
      { id: "40490001", phones: ["+541122334455"], leadIds: ["22630001"] },
      { id: "40490002", phones: ["+5491122334455"], leadIds: ["lead-1"] }, // el propio contacto
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
    expect(mocks.unifyDuplicate).toHaveBeenCalledWith(
      { existingContactId: "40490001", existingLeadId: "22630001", newContactId: "40490002", newLeadId: "lead-1" },
      { lossReasonId: 38469131 }
    );
  });

  it("si en Kommo hay varios, el ganador es el de id mas bajo", async () => {
    mocks.findByPhone.mockResolvedValue([]);
    mocks.findContactsByPhoneQuery.mockResolvedValue([
      { id: "40490001", phones: ["+5491122334455"], leadIds: ["22630001"] },
      { id: "40400000", phones: ["+5491122334455"], leadIds: ["22600000"] },
    ]);

    await processIncomingEntity(BASE_INPUT);

    expect(mocks.unifyDuplicate).toHaveBeenCalledWith(
      expect.objectContaining({ existingContactId: "40400000", existingLeadId: "22600000" }),
      expect.anything()
    );
  });

  it("si el contacto de Kommo tiene id MAS ALTO que el nuevo: pending_review con motivo, no fusiona", async () => {
    mocks.findByPhone.mockResolvedValue([]);
    mocks.findContactsByPhoneQuery.mockResolvedValue([
      { id: "40499999", phones: ["+5491122334455"], leadIds: ["22639999"] },
    ]);

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.duplicatesDetected).toBe(1);
    expect(mocks.insertDuplicateDetection).toHaveBeenCalledWith(
      expect.objectContaining({ existingContactId: "40499999", newContactId: "40490002" })
    );
    expect(mocks.unifyDuplicate).not.toHaveBeenCalled();
    expect(mocks.appendDetectionNote).toHaveBeenCalledWith(
      1,
      "Sin fusion automatica: orden de IDs inesperado, revisar a mano"
    );
  });

  it("sin coincidencias en Kommo: lo trata como nuevo y lo indexa", async () => {
    mocks.findByPhone.mockResolvedValue([]);
    mocks.findContactsByPhoneQuery.mockResolvedValue([
      { id: "40490002", phones: ["+5491122334455"], leadIds: ["lead-1"] },
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

describe("processIncomingEntity - orden de ids en el indice local", () => {
  it("si el 'existente' del indice es mas nuevo que el contacto del evento: no fusiona (webhook del viejo perdido)", async () => {
    mocks.findByPhone.mockResolvedValue([{ ...OTHER_ROW, kommo_contact_id: "40499999" }]);

    await processIncomingEntity(BASE_INPUT);

    expect(mocks.unifyDuplicate).not.toHaveBeenCalled();
    expect(mocks.appendDetectionNote).toHaveBeenCalledWith(
      1,
      "Sin fusion automatica: orden de IDs inesperado, revisar a mano"
    );
  });

  it("con varios contactos en el indice, elige como ganador el de id mas bajo", async () => {
    mocks.findByPhone.mockResolvedValue([
      { ...OTHER_ROW, id: 1, kommo_contact_id: "40490001", kommo_lead_id: "L-NEWER" },
      { ...OTHER_ROW, id: 2, kommo_contact_id: "40400000", kommo_lead_id: "L-OLDEST" },
    ]);

    await processIncomingEntity(BASE_INPUT);

    expect(mocks.unifyDuplicate).toHaveBeenCalledWith(
      expect.objectContaining({ existingContactId: "40400000", existingLeadId: "L-OLDEST" }),
      expect.anything()
    );
  });
});

describe("processIncomingEntity - no es duplicado", () => {
  it("no considera duplicado si la fila existente es de la MISMA entidad", async () => {
    mocks.findByPhone.mockReturnValue([{ ...OTHER_ROW, kommo_contact_id: "40490002", kommo_lead_id: "lead-1" }]);

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
  it("fusiona el lead 22627634 con el contacto 'test', usando el lead real de 'test' en Kommo", async () => {
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
    expect(mocks.unifyDuplicate).toHaveBeenCalledWith(
      {
        existingContactId: "40487438",
        existingLeadId: "22627454",
        newContactId: "40487830",
        newLeadId: "22627634",
      },
      { lossReasonId: 38469131 }
    );

    // El contacto se indexa con su lead, asi futuros duplicados ya tienen existingLeadId.
    expect(mocks.insertPhoneIndex).toHaveBeenCalledWith(
      expect.objectContaining({ kommoContactId: "40487830", kommoLeadId: "22627634" })
    );
  });

  it("guarda existingLeadId cuando la fila existente tiene lead", async () => {
    mocks.findByPhone.mockReturnValue([{ ...TEST_EXISTING_ROW, kommo_lead_id: "22627454" }]);

    await processIncomingEntity(contactInput(TEST_22_CONTACT));

    expect(mocks.insertDuplicateDetection).toHaveBeenCalledWith(
      expect.objectContaining({ existingLeadId: "22627454", newLeadId: "22627634" })
    );
  });
});
