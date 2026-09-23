import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findByPhone: vi.fn(),
  insertPhoneIndex: vi.fn(),
  findExistingPendingDetection: vi.fn(),
  insertDuplicateDetection: vi.fn(),
  buildEventKey: vi.fn(),
  markEventProcessedIfNew: vi.fn(),
  notifyDuplicateDetected: vi.fn(),
  addNote: vi.fn(),
  addTag: vi.fn(),
  config: { defaultCountryCode: "54", dryRun: false },
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
  findExistingPendingDetection: mocks.findExistingPendingDetection,
  insertDuplicateDetection: mocks.insertDuplicateDetection,
}));

vi.mock("../src/db/webhookEvents", () => ({
  buildEventKey: mocks.buildEventKey,
  markEventProcessedIfNew: mocks.markEventProcessedIfNew,
}));

vi.mock("../src/services/notifier", () => ({
  notifyDuplicateDetected: mocks.notifyDuplicateDetected,
}));

vi.mock("../src/services/kommoClient", () => ({
  addNote: mocks.addNote,
  addTag: mocks.addTag,
}));

vi.mock("../src/config", () => ({
  config: mocks.config,
}));

import { processIncomingEntity } from "../src/services/duplicateDetector";

const BASE_INPUT = {
  entityType: "lead" as const,
  entityId: "lead-1",
  contactId: "contact-1",
  leadId: "lead-1",
  phonesRaw: ["+5491122334455"],
  source: "facebook_ads" as const,
  rawPayload: { id: "lead-1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.defaultCountryCode = "54";
  mocks.config.dryRun = false;
  mocks.buildEventKey.mockReturnValue("lead:lead-1:hash");
  mocks.markEventProcessedIfNew.mockReturnValue(true);
  mocks.findExistingPendingDetection.mockReturnValue(undefined);
  mocks.insertDuplicateDetection.mockReturnValue({ id: 1 });
  mocks.insertPhoneIndex.mockReturnValue({ id: 1 });
  mocks.notifyDuplicateDetected.mockResolvedValue(undefined);
  mocks.addNote.mockResolvedValue(undefined);
  mocks.addTag.mockResolvedValue(undefined);
});

describe("processIncomingEntity - telefono nuevo", () => {
  it("indexa el telefono y no dispara ningun aviso de duplicado", async () => {
    mocks.findByPhone.mockReturnValue([]);

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.skippedAsRetry).toBe(false);
    expect(result.duplicatesDetected).toBe(0);
    expect(result.phonesIndexed).toBe(1);

    expect(mocks.insertPhoneIndex).toHaveBeenCalledTimes(1);
    expect(mocks.insertPhoneIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNormalized: "5491122334455",
        kommoContactId: "contact-1",
        kommoLeadId: "lead-1",
        source: "facebook_ads",
      })
    );

    expect(mocks.insertDuplicateDetection).not.toHaveBeenCalled();
    expect(mocks.notifyDuplicateDetected).not.toHaveBeenCalled();
    expect(mocks.addNote).not.toHaveBeenCalled();
    expect(mocks.addTag).not.toHaveBeenCalled();
  });
});

describe("processIncomingEntity - telefono duplicado (otro contacto/lead)", () => {
  it("registra la deteccion, notifica y anota en Kommo", async () => {
    mocks.findByPhone.mockReturnValue([
      {
        id: 1,
        phone_normalized: "5491122334455",
        kommo_contact_id: "contact-OTHER",
        kommo_lead_id: "lead-OTHER",
        source: "whatsapp",
        created_at: "2026-01-01",
      },
    ]);

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.duplicatesDetected).toBe(1);

    expect(mocks.insertDuplicateDetection).toHaveBeenCalledTimes(1);
    expect(mocks.insertDuplicateDetection).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNormalized: "5491122334455",
        existingContactId: "contact-OTHER",
        existingLeadId: "lead-OTHER",
        newContactId: "contact-1",
        newLeadId: "lead-1",
      })
    );

    expect(mocks.notifyDuplicateDetected).toHaveBeenCalledTimes(1);
    expect(mocks.addNote).toHaveBeenCalledTimes(1);
    expect(mocks.addTag).toHaveBeenCalledTimes(1);

    // Igual se indexa la nueva entidad para futuros cruces.
    expect(mocks.insertPhoneIndex).toHaveBeenCalledTimes(1);
  });

  it("en modo DRY_RUN detecta y registra el duplicado igual, pero NO llama a addNote/addTag", async () => {
    mocks.config.dryRun = true;
    mocks.findByPhone.mockReturnValue([
      {
        id: 1,
        phone_normalized: "5491122334455",
        kommo_contact_id: "contact-OTHER",
        kommo_lead_id: "lead-OTHER",
        source: "whatsapp",
        created_at: "2026-01-01",
      },
    ]);

    const result = await processIncomingEntity(BASE_INPUT);

    // El resto del flujo (deteccion, indexado, registro, notificacion) sigue
    // corriendo igual en DRY_RUN; solo se saltean las escrituras a Kommo.
    expect(result.duplicatesDetected).toBe(1);
    expect(mocks.insertDuplicateDetection).toHaveBeenCalledTimes(1);
    expect(mocks.notifyDuplicateDetected).toHaveBeenCalledTimes(1);
    expect(mocks.insertPhoneIndex).toHaveBeenCalledTimes(1);

    expect(mocks.addNote).not.toHaveBeenCalled();
    expect(mocks.addTag).not.toHaveBeenCalled();
  });

  it("no considera duplicado si la fila existente es de la MISMA entidad", async () => {
    mocks.findByPhone.mockReturnValue([
      {
        id: 1,
        phone_normalized: "5491122334455",
        kommo_contact_id: "contact-1", // mismo contact_id que el evento actual
        kommo_lead_id: "lead-1",
        source: "facebook_ads",
        created_at: "2026-01-01",
      },
    ]);

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.duplicatesDetected).toBe(0);
    expect(mocks.insertDuplicateDetection).not.toHaveBeenCalled();
    expect(mocks.notifyDuplicateDetected).not.toHaveBeenCalled();
  });
});

describe("processIncomingEntity - reintento de webhook (idempotencia)", () => {
  it("no reprocesa un evento ya visto y no duplica registros", async () => {
    mocks.markEventProcessedIfNew.mockReturnValue(false);

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.skippedAsRetry).toBe(true);
    expect(mocks.findByPhone).not.toHaveBeenCalled();
    expect(mocks.insertPhoneIndex).not.toHaveBeenCalled();
    expect(mocks.insertDuplicateDetection).not.toHaveBeenCalled();
    expect(mocks.notifyDuplicateDetected).not.toHaveBeenCalled();
  });
});

describe("processIncomingEntity - deteccion ya registrada previamente", () => {
  it("no vuelve a insertar en duplicate_detections ni a notificar dos veces", async () => {
    mocks.findByPhone.mockReturnValue([
      {
        id: 1,
        phone_normalized: "5491122334455",
        kommo_contact_id: "contact-OTHER",
        kommo_lead_id: "lead-OTHER",
        source: "whatsapp",
        created_at: "2026-01-01",
      },
    ]);
    mocks.findExistingPendingDetection.mockReturnValue({ id: 99 });

    const result = await processIncomingEntity(BASE_INPUT);

    expect(result.duplicatesDetected).toBe(0);
    expect(mocks.insertDuplicateDetection).not.toHaveBeenCalled();
    expect(mocks.notifyDuplicateDetected).not.toHaveBeenCalled();
    expect(mocks.addNote).not.toHaveBeenCalled();
  });
});

describe("processIncomingEntity - telefono que no se puede normalizar", () => {
  it("no indexa ni compara, y lo cuenta como no normalizable", async () => {
    const result = await processIncomingEntity({
      ...BASE_INPUT,
      phonesRaw: ["abc"],
    });

    expect(result.phonesUnableToNormalize).toBe(1);
    expect(result.phonesIndexed).toBe(0);
    expect(mocks.findByPhone).not.toHaveBeenCalled();
    expect(mocks.insertPhoneIndex).not.toHaveBeenCalled();
  });
});
