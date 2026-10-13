import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getLead: vi.fn(),
  unifyDuplicate: vi.fn(),
  appendDetectionNote: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("../src/services/kommoClient", () => ({ getLead: mocks.getLead }));
vi.mock("../src/services/duplicateUnifier", async () => {
  const actual = await vi.importActual<typeof import("../src/services/duplicateUnifier")>(
    "../src/services/duplicateUnifier"
  );
  return {
    DUPLICATES_PIPELINE_ID: actual.DUPLICATES_PIPELINE_ID,
    resolveWinner: actual.resolveWinner,
    unifyDuplicate: mocks.unifyDuplicate,
  };
});
vi.mock("../src/db/duplicateDetections", () => ({
  appendDetectionNote: mocks.appendDetectionNote,
}));
vi.mock("../src/logger", () => ({
  logger: { info: mocks.loggerInfo, warn: mocks.loggerWarn, error: mocks.loggerError },
}));

import { reconcileDetection } from "../src/jobs/reconcileDetections";
import type { DuplicateDetectionRow } from "../src/db/duplicateDetections";

function makeDetection(overrides: Partial<DuplicateDetectionRow> = {}): DuplicateDetectionRow {
  return {
    id: 1,
    phone_normalized: "5491122334455",
    // existing = contacto/lead más bajo = perdedor (el más alto gana)
    existing_contact_id: "100",
    existing_lead_id: "200",
    // new = contacto/lead más alto = ganador
    new_contact_id: "200",
    new_lead_id: "300",
    status: "pending_review",
    detected_at: new Date(),
    notes: "fallo la fusion: Kommo API error 403 en /contacts/100?with=leads",
    ...overrides,
  };
}

const openLead = { pipeline_id: 1111111, status_id: 1 };
const closedWonLead = { pipeline_id: 1111111, status_id: 142 };
const closedLostLead = { pipeline_id: 1111111, status_id: 143 };
const duplicatesLead = { pipeline_id: 14517971, status_id: 999 };

const successfulUnify = {
  ok: true,
  dryRun: false,
  steps: [
    { step: "link_loser_lead_to_winner_contact", status: "ok" },
    { step: "move_loser_lead_to_duplicates", status: "ok" },
  ],
  detectionsMarkedMerged: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.appendDetectionNote.mockResolvedValue(undefined);
  mocks.unifyDuplicate.mockResolvedValue(successfulUnify);
});

describe("reconcileDetection - cálculo de ganador/perdedor", () => {
  it("fusiona correctamente: ganador = IDs más altos (new_*)", async () => {
    mocks.getLead.mockResolvedValue(openLead);

    const result = await reconcileDetection(makeDetection(), false);

    expect(result.outcome).toBe("merged");
    expect(mocks.unifyDuplicate).toHaveBeenCalledWith({
      winnerContactId: "200",
      winnerLeadId: "300",
      loserContactId: "100",
      loserLeadId: "200",
    });
  });

  it("ganador/perdedor correcto cuando existing_* tiene IDs más altos", async () => {
    mocks.getLead.mockResolvedValue(openLead);

    const detection = makeDetection({
      existing_contact_id: "500",
      existing_lead_id: "600",
      new_contact_id: "100",
      new_lead_id: "200",
    });

    const result = await reconcileDetection(detection, false);

    expect(result.outcome).toBe("merged");
    expect(mocks.unifyDuplicate).toHaveBeenCalledWith({
      winnerContactId: "500",
      winnerLeadId: "600",
      loserContactId: "100",
      loserLeadId: "200",
    });
  });
});

describe("reconcileDetection - filtro de estado cambiado (skip)", () => {
  it("skippea si el lead perdedor ya está cerrado (won)", async () => {
    // existing = perdedor (IDs menores), new = ganador (IDs mayores)
    // getLead para "200" (perdedor) devuelve cerrado
    mocks.getLead
      .mockResolvedValueOnce(closedWonLead)  // existing lead 200 (perdedor)
      .mockResolvedValueOnce(openLead);      // new lead 300 (ganador)

    const result = await reconcileDetection(makeDetection(), false);

    expect(result.outcome).toBe("skipped_loser_closed_or_dup");
    expect(mocks.unifyDuplicate).not.toHaveBeenCalled();
  });

  it("skippea si el lead perdedor ya está en Duplicados", async () => {
    mocks.getLead
      .mockResolvedValueOnce(duplicatesLead) // existing lead 200 (perdedor)
      .mockResolvedValueOnce(openLead);      // new lead 300 (ganador)

    const result = await reconcileDetection(makeDetection(), false);

    expect(result.outcome).toBe("skipped_loser_closed_or_dup");
    expect(mocks.unifyDuplicate).not.toHaveBeenCalled();
  });

  it("skippea si el lead perdedor ya está cerrado (lost)", async () => {
    mocks.getLead
      .mockResolvedValueOnce(closedLostLead) // existing lead 200 (perdedor)
      .mockResolvedValueOnce(openLead);      // new lead 300 (ganador)

    const result = await reconcileDetection(makeDetection(), false);

    expect(result.outcome).toBe("skipped_loser_closed_or_dup");
    expect(mocks.unifyDuplicate).not.toHaveBeenCalled();
  });

  it("skippea si algún ID es null", async () => {
    const result = await reconcileDetection(
      makeDetection({ existing_lead_id: null }),
      false
    );

    expect(result.outcome).toBe("skipped_null_ids");
    expect(mocks.getLead).not.toHaveBeenCalled();
  });
});

describe("reconcileDetection - dry run", () => {
  it("en dry_run no llama a unifyDuplicate ni appendDetectionNote", async () => {
    mocks.getLead.mockResolvedValue(openLead);

    const result = await reconcileDetection(makeDetection(), true);

    expect(result.outcome).toBe("dry_run");
    expect(mocks.unifyDuplicate).not.toHaveBeenCalled();
    expect(mocks.appendDetectionNote).not.toHaveBeenCalled();
  });
});

describe("reconcileDetection - fallo de unify", () => {
  it("devuelve failed si unifyDuplicate falla", async () => {
    mocks.getLead.mockResolvedValue(openLead);
    mocks.unifyDuplicate.mockResolvedValue({
      ok: false,
      dryRun: false,
      steps: [
        { step: "link_loser_lead_to_winner_contact", status: "failed", error: "timeout" },
        { step: "move_loser_lead_to_duplicates", status: "skipped" },
      ],
      detectionsMarkedMerged: 0,
    });

    const result = await reconcileDetection(makeDetection(), false);

    expect(result.outcome).toBe("failed");
    expect(result.detail).toMatch(/link_loser_lead_to_winner_contact/);
  });
});
