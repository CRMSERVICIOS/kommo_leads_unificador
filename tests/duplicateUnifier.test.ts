import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  linkContactToLead: vi.fn(),
  createNote: vi.fn(),
  addTagsToEntity: vi.fn(),
  getLead: vi.fn(),
  updateLeadStatus: vi.fn(),
  markDetectionsMergedForContacts: vi.fn(),
}));

vi.mock("../src/services/kommoClient", () => ({
  linkContactToLead: mocks.linkContactToLead,
  createNote: mocks.createNote,
  addTagsToEntity: mocks.addTagsToEntity,
  getLead: mocks.getLead,
  updateLeadStatus: mocks.updateLeadStatus,
}));

vi.mock("../src/db/duplicateDetections", () => ({
  markDetectionsMergedForContacts: mocks.markDetectionsMergedForContacts,
}));

import {
  CLOSED_LOST_STATUS_ID,
  MERGED_TAG_NAME,
  unifyDuplicate,
} from "../src/services/duplicateUnifier";

// Caso real de prueba: "test" (40487438) es el existente, "test 22"
// (40487830, lead 22627634) es el nuevo con el mismo telefono.
const INPUT = {
  existingContactId: "40487438",
  existingLeadId: "22627454",
  newContactId: "40487830",
  newLeadId: "22627634",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.linkContactToLead.mockResolvedValue({ _embedded: { links: [] } });
  mocks.createNote.mockResolvedValue({ _embedded: { notes: [{ id: 1 }] } });
  mocks.addTagsToEntity.mockResolvedValue({ _embedded: { leads: [{ id: 22627634 }] } });
  mocks.markDetectionsMergedForContacts.mockReturnValue(1);
  // Pipeline real del lead de "test 22".
  mocks.getLead.mockResolvedValue({ id: 22627634, pipeline_id: 14491207, status_id: 111934987 });
  mocks.updateLeadStatus.mockResolvedValue({ id: 22627634 });
});

describe("unifyDuplicate", () => {
  it("vincula el lead nuevo al contacto existente como principal", async () => {
    const result = await unifyDuplicate(INPUT);

    expect(result.ok).toBe(true);
    expect(mocks.linkContactToLead).toHaveBeenCalledTimes(1);
    expect(mocks.linkContactToLead).toHaveBeenCalledWith("22627634", "40487438", { isMain: true });
  });

  it("agrega nota + tag duplicado-fusionado en el lead nuevo", async () => {
    await unifyDuplicate(INPUT);

    expect(mocks.createNote).toHaveBeenCalledWith(
      "leads",
      "22627634",
      "[DUPLICADO] Posible duplicado vinculado automáticamente con el contacto #40487438 (mismo teléfono). Verificar."
    );
    expect(mocks.addTagsToEntity).toHaveBeenCalledTimes(1);
    expect(mocks.addTagsToEntity).toHaveBeenCalledWith("leads", "22627634", [MERGED_TAG_NAME]);
    expect(MERGED_TAG_NAME).toBe("duplicado-fusionado");
  });

  it("agrega una nota en el lead ganador mencionando el lead vinculado", async () => {
    await unifyDuplicate(INPUT);

    expect(mocks.createNote).toHaveBeenCalledTimes(2);
    expect(mocks.createNote).toHaveBeenCalledWith(
      "leads",
      "22627454",
      expect.stringContaining("lead #22627634")
    );
  });

  it("sin existingLeadId, saltea la nota en el lead ganador", async () => {
    const result = await unifyDuplicate({ ...INPUT, existingLeadId: null });

    expect(result.ok).toBe(true);
    expect(mocks.createNote).toHaveBeenCalledTimes(1);
    expect(mocks.createNote).toHaveBeenCalledWith(
      "leads",
      "22627634",
      expect.stringContaining("contacto #40487438")
    );
    expect(result.steps.find((s) => s.step === "note_on_existing_lead")?.status).toBe("skipped");
  });

  it("si falla la vinculacion no marca nada y devuelve ok=false", async () => {
    mocks.linkContactToLead.mockRejectedValue(new Error("Kommo API error 400"));

    const result = await unifyDuplicate(INPUT);

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ step: "link_new_lead_to_existing_contact", status: "failed" });
    expect(mocks.createNote).not.toHaveBeenCalled();
    expect(mocks.addTagsToEntity).not.toHaveBeenCalled();
  });

  it("si falla el tag, igual deja la nota en el lead ganador y reporta ok=false", async () => {
    mocks.addTagsToEntity.mockRejectedValue(new Error("Kommo API error 403"));

    const result = await unifyDuplicate(INPUT);

    expect(result.ok).toBe(false);
    expect(result.steps.find((s) => s.step === "tag_new_lead")?.status).toBe("failed");
    expect(mocks.createNote).toHaveBeenCalledWith("leads", "22627454", expect.any(String));
  });

  it("en dryRun no llama a Kommo y devuelve los requests que haria", async () => {
    const result = await unifyDuplicate(INPUT, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(mocks.linkContactToLead).not.toHaveBeenCalled();
    expect(mocks.createNote).not.toHaveBeenCalled();
    expect(mocks.addTagsToEntity).not.toHaveBeenCalled();
    expect(mocks.updateLeadStatus).not.toHaveBeenCalled();
    expect(result.steps.map((s) => s.status)).toEqual(["dry_run", "dry_run", "dry_run", "dry_run", "dry_run"]);
    expect(result.steps[4].request).toEqual({
      method: "PATCH",
      path: "/leads/22627634",
      body: { pipeline_id: 14491207, status_id: 143 },
    });
    expect(result.steps[0].request).toEqual({
      method: "POST",
      path: "/leads/22627634/link",
      body: [{ to_entity_id: 40487438, to_entity_type: "contacts", metadata: { is_main: true } }],
    });
  });

  it("cierra el lead nuevo como perdido (143) dentro de su mismo embudo, con motivo", async () => {
    const result = await unifyDuplicate(INPUT, { lossReasonId: 38469131 });

    expect(CLOSED_LOST_STATUS_ID).toBe(143);
    expect(mocks.getLead).toHaveBeenCalledWith("22627634");
    expect(mocks.updateLeadStatus).toHaveBeenCalledTimes(1);
    expect(mocks.updateLeadStatus).toHaveBeenCalledWith("22627634", 14491207, 143, 38469131);
    expect(result.steps.at(-1)?.request?.body).toEqual({
      pipeline_id: 14491207,
      status_id: 143,
      loss_reason_id: 38469131,
    });
    expect(result.steps.at(-1)).toMatchObject({ step: "close_new_lead", status: "ok" });
  });

  it("cierra recien despues de vincular, notar y taggear", async () => {
    await unifyDuplicate(INPUT);

    const closeOrder = mocks.updateLeadStatus.mock.invocationCallOrder[0];
    expect(mocks.linkContactToLead.mock.invocationCallOrder[0]).toBeLessThan(closeOrder);
    expect(mocks.addTagsToEntity.mock.invocationCallOrder[0]).toBeLessThan(closeOrder);
    for (const order of mocks.createNote.mock.invocationCallOrder) expect(order).toBeLessThan(closeOrder);
  });

  it("no cierra el lead si fallo la nota o el tag", async () => {
    mocks.createNote.mockRejectedValueOnce(new Error("Kommo API error 400"));

    const result = await unifyDuplicate(INPUT);

    expect(mocks.updateLeadStatus).not.toHaveBeenCalled();
    expect(result.steps.find((s) => s.step === "close_new_lead")?.status).toBe("skipped");
  });

  it("si no puede leer el embudo del lead, no lo cierra y reporta ok=false", async () => {
    mocks.getLead.mockRejectedValue(new Error("Kommo API error 404"));

    const result = await unifyDuplicate(INPUT);

    expect(result.ok).toBe(false);
    expect(mocks.updateLeadStatus).not.toHaveBeenCalled();
  });

  it("nunca toca el contacto perdedor", async () => {
    await unifyDuplicate(INPUT);

    // Las unicas escrituras son sobre leads -- ninguna sobre el contacto 40487830.
    for (const call of mocks.createNote.mock.calls) expect(call[0]).toBe("leads");
    for (const call of mocks.addTagsToEntity.mock.calls) expect(call[0]).toBe("leads");
    const touchedIds = [
      ...mocks.createNote.mock.calls.map((c) => c[1]),
      ...mocks.addTagsToEntity.mock.calls.map((c) => c[1]),
      ...mocks.linkContactToLead.mock.calls.map((c) => c[0]),
      ...mocks.updateLeadStatus.mock.calls.map((c) => c[0]),
    ];
    expect(touchedIds).not.toContain("40487830");
  });

  it("al completar OK marca la deteccion del par como reviewed_merged", async () => {
    const result = await unifyDuplicate(INPUT);

    expect(mocks.markDetectionsMergedForContacts).toHaveBeenCalledWith("40487438", "40487830");
    expect(result.detectionsMarkedMerged).toBe(1);
  });

  it("no marca la deteccion si algun paso fallo o si es dryRun", async () => {
    mocks.addTagsToEntity.mockRejectedValue(new Error("Kommo API error 403"));
    await unifyDuplicate(INPUT);
    await unifyDuplicate(INPUT, { dryRun: true });

    expect(mocks.markDetectionsMergedForContacts).not.toHaveBeenCalled();
  });
});
