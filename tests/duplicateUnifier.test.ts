import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  linkContactToLead: vi.fn(),
  moveLeadToStage: vi.fn(),
  markDetectionsMergedForContacts: vi.fn(),
}));

vi.mock("../src/services/kommoClient", () => ({
  linkContactToLead: mocks.linkContactToLead,
  moveLeadToStage: mocks.moveLeadToStage,
}));

vi.mock("../src/db/duplicateDetections", () => ({
  markDetectionsMergedForContacts: mocks.markDetectionsMergedForContacts,
}));

import {
  DUPLICATES_PIPELINE_ID,
  DUPLICATES_RESPONSIBLE_USER_ID,
  DUPLICATES_STATUS_ID,
  resolveWinner,
  unifyDuplicate,
} from "../src/services/duplicateUnifier";

// Caso real de prueba: "test" (40487438, lead 22627454) es el mas viejo,
// "test 22" (40487830, lead 22627634) el mas nuevo con el mismo telefono.
const INPUT = {
  winnerContactId: "40487830",
  winnerLeadId: "22627634",
  loserContactId: "40487438",
  loserLeadId: "22627454",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.linkContactToLead.mockResolvedValue({ _embedded: { links: [] } });
  mocks.moveLeadToStage.mockResolvedValue({ id: 22627454 });
  mocks.markDetectionsMergedForContacts.mockReturnValue(1);
});

describe("resolveWinner", () => {
  const OLDER = { contactId: "40487438", leadId: "22627454" };
  const NEWER = { contactId: "40487830", leadId: "22627634" };

  it("gana el lado con ids mas altos, sin importar el orden de los argumentos", () => {
    expect(resolveWinner(OLDER, NEWER)).toEqual({ winner: NEWER, loser: OLDER });
    expect(resolveWinner(NEWER, OLDER)).toEqual({ winner: NEWER, loser: OLDER });
  });

  it("compara numericamente, no como texto", () => {
    const nineDigits = { contactId: "999999999", leadId: "99999999" };
    const tenDigits = { contactId: "1000000000", leadId: "100000000" };
    expect(resolveWinner(nineDigits, tenDigits)?.winner).toBe(tenDigits);
  });

  it("null si el contacto y el lead no coinciden en cual es mas nuevo", () => {
    expect(resolveWinner({ contactId: "40487830", leadId: "22627454" }, { contactId: "40487438", leadId: "22627634" })).toBeNull();
  });

  it("null con ids iguales o no numericos", () => {
    expect(resolveWinner(OLDER, OLDER)).toBeNull();
    expect(resolveWinner({ contactId: "40487830", leadId: "lead-1" }, OLDER)).toBeNull();
  });
});

describe("unifyDuplicate", () => {
  it("vincula el lead perdedor al contacto ganador como principal", async () => {
    const result = await unifyDuplicate(INPUT);

    expect(result.ok).toBe(true);
    expect(mocks.linkContactToLead).toHaveBeenCalledTimes(1);
    expect(mocks.linkContactToLead).toHaveBeenCalledWith("22627454", "40487830", { isMain: true });
  });

  it("mueve el lead perdedor a Duplicados y lo reasigna a Martin Vassallo, en un solo PATCH", async () => {
    const result = await unifyDuplicate(INPUT);

    expect(DUPLICATES_PIPELINE_ID).toBe(14517971);
    expect(DUPLICATES_STATUS_ID).toBe(112145359);
    expect(DUPLICATES_RESPONSIBLE_USER_ID).toBe(12280712);
    expect(mocks.moveLeadToStage).toHaveBeenCalledTimes(1);
    expect(mocks.moveLeadToStage).toHaveBeenCalledWith("22627454", 14517971, 112145359, 12280712);
    expect(result.steps.at(-1)).toMatchObject({
      step: "move_loser_lead_to_duplicates",
      status: "ok",
      request: { method: "PATCH", path: "/leads/22627454", body: { pipeline_id: 14517971, status_id: 112145359, responsible_user_id: 12280712 } },
    });
  });

  it("mueve recien despues de vincular", async () => {
    await unifyDuplicate(INPUT);

    expect(mocks.linkContactToLead.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.moveLeadToStage.mock.invocationCallOrder[0]
    );
  });

  it("el lead y el contacto ganadores quedan intactos: ninguna llamada los toca", async () => {
    await unifyDuplicate(INPUT);

    // El unico uso del contacto ganador es como destino del link del lead perdedor.
    const writtenLeads = [
      ...mocks.linkContactToLead.mock.calls.map((c) => c[0]),
      ...mocks.moveLeadToStage.mock.calls.map((c) => c[0]),
    ];
    expect(writtenLeads).toEqual(["22627454", "22627454"]);
    expect(writtenLeads).not.toContain(INPUT.winnerLeadId);
  });

  it("no desvincula ni toca el contacto perdedor (queda como secundario del lead)", async () => {
    await unifyDuplicate(INPUT);

    const allArgs = [...mocks.linkContactToLead.mock.calls, ...mocks.moveLeadToStage.mock.calls].flat();
    expect(allArgs).not.toContain(INPUT.loserContactId);
  });

  it("si falla la vinculacion no mueve el lead y devuelve ok=false", async () => {
    mocks.linkContactToLead.mockRejectedValue(new Error("Kommo API error 400"));

    const result = await unifyDuplicate(INPUT);

    expect(result.ok).toBe(false);
    expect(result.steps).toMatchObject([
      { step: "link_loser_lead_to_winner_contact", status: "failed" },
      { step: "move_loser_lead_to_duplicates", status: "skipped" },
    ]);
    expect(mocks.moveLeadToStage).not.toHaveBeenCalled();
  });

  it("si falla el movimiento devuelve ok=false", async () => {
    mocks.moveLeadToStage.mockRejectedValue(new Error("Kommo API error 400"));

    const result = await unifyDuplicate(INPUT);

    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({ step: "move_loser_lead_to_duplicates", status: "failed" });
  });

  it("en dryRun no llama a Kommo y devuelve los requests que haria", async () => {
    const result = await unifyDuplicate(INPUT, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(mocks.linkContactToLead).not.toHaveBeenCalled();
    expect(mocks.moveLeadToStage).not.toHaveBeenCalled();
    expect(result.steps.map((s) => s.request)).toEqual([
      {
        method: "POST",
        path: "/leads/22627454/link",
        body: [{ to_entity_id: 40487830, to_entity_type: "contacts", metadata: { is_main: true } }],
      },
      { method: "PATCH", path: "/leads/22627454", body: { pipeline_id: 14517971, status_id: 112145359, responsible_user_id: 12280712 } },
    ]);
    expect(result.steps.map((s) => s.status)).toEqual(["dry_run", "dry_run"]);
  });

  it("no hay notas, tags, cierre a 143 ni motivo de perdida en ningun request", async () => {
    const result = await unifyDuplicate(INPUT, { dryRun: true });

    const requests = JSON.stringify(result.steps.map((s) => s.request));
    expect(requests).not.toMatch(/notes|tags|loss_reason|"status_id":143/);
  });

  it("al completar OK marca la deteccion del par como reviewed_merged", async () => {
    const result = await unifyDuplicate(INPUT);

    expect(mocks.markDetectionsMergedForContacts).toHaveBeenCalledWith("40487830", "40487438");
    expect(result.detectionsMarkedMerged).toBe(1);
  });

  it("no marca la deteccion si algun paso fallo o si es dryRun", async () => {
    mocks.moveLeadToStage.mockRejectedValue(new Error("Kommo API error 403"));
    await unifyDuplicate(INPUT);
    await unifyDuplicate(INPUT, { dryRun: true });

    expect(mocks.markDetectionsMergedForContacts).not.toHaveBeenCalled();
  });
});
