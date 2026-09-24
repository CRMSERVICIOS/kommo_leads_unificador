import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reproduce el "eco de fusion" encontrado con Matias Franco (2026-09-23):
 * unifyDuplicate vincula el lead perdedor al contacto ganador, Kommo manda
 * un contacts.update del ganador, y el detector lo tomaba como un duplicado
 * nuevo con los roles invertidos. Usa fakes con estado (DB en memoria +
 * Kommo en memoria) para que el efecto real de la fusion (el link y el
 * cambio de embudo) sea lo que ve el evento siguiente.
 */

type PhoneRow = {
  id: number;
  phone_normalized: string;
  kommo_contact_id: string | null;
  kommo_lead_id: string | null;
  source: string | null;
  created_at: string;
};
type DetectionRow = {
  id: number;
  phone_normalized: string;
  existing_contact_id: string | null;
  existing_lead_id: string | null;
  new_contact_id: string | null;
  new_lead_id: string | null;
  status: string;
};

const state = vi.hoisted(() => ({
  phoneRows: [] as PhoneRow[],
  detections: [] as DetectionRow[],
  seenEvents: new Set<string>(),
  /** contacto -> leads vinculados, como lo ve Kommo. */
  kommoContactLeads: new Map<string, Set<string>>(),
  /** lead -> embudo/etapa, como lo ve Kommo. */
  leadStage: new Map<string, { pipeline_id: number; status_id: number }>(),
  /** Cada escritura que recibio Kommo: [endpoint, lead]. */
  writes: [] as [string, string][],
}));

vi.mock("../src/config", () => ({
  config: { defaultCountryCode: "54", dryRun: false },
}));

vi.mock("../src/db/phoneIndex", async () => {
  const actual = await vi.importActual<typeof import("../src/db/phoneIndex")>("../src/db/phoneIndex");
  return {
    belongsToDifferentEntity: actual.belongsToDifferentEntity,
    findByPhone: (phone: string) => state.phoneRows.filter((r) => r.phone_normalized === phone),
    insertPhoneIndex: (input: { phoneNormalized: string; kommoContactId: string | null; kommoLeadId: string | null; source: string | null }) => {
      const row = {
        id: state.phoneRows.length + 1,
        phone_normalized: input.phoneNormalized,
        kommo_contact_id: input.kommoContactId,
        kommo_lead_id: input.kommoLeadId,
        source: input.source,
        created_at: "now",
      };
      state.phoneRows.push(row);
      return row;
    },
  };
});

vi.mock("../src/db/duplicateDetections", () => ({
  appendDetectionNote: async () => undefined,
  findExistingPendingDetection: (phone: string, newContactId: string | null, newLeadId: string | null) =>
    state.detections.find(
      (d) =>
        d.phone_normalized === phone &&
        d.status === "pending_review" &&
        d.new_contact_id === newContactId &&
        d.new_lead_id === newLeadId
    ),
  insertDuplicateDetection: (input: {
    phoneNormalized: string;
    existingContactId: string | null;
    existingLeadId: string | null;
    newContactId: string | null;
    newLeadId: string | null;
  }) => {
    const row = {
      id: state.detections.length + 1,
      phone_normalized: input.phoneNormalized,
      existing_contact_id: input.existingContactId,
      existing_lead_id: input.existingLeadId,
      new_contact_id: input.newContactId,
      new_lead_id: input.newLeadId,
      status: "pending_review",
    };
    state.detections.push(row);
    return row;
  },
  markDetectionsMergedForContacts: (a: string, b: string) => {
    let changes = 0;
    for (const d of state.detections) {
      const pair =
        (d.existing_contact_id === a && d.new_contact_id === b) ||
        (d.existing_contact_id === b && d.new_contact_id === a);
      if (pair && d.status === "pending_review") {
        d.status = "reviewed_merged";
        changes += 1;
      }
    }
    return changes;
  },
}));

vi.mock("../src/db/webhookEvents", () => ({
  buildEventKey: (type: string, id: string, payload: unknown) => `${type}:${id}:${JSON.stringify(payload)}`,
  markEventProcessedIfNew: (key: string) => {
    if (state.seenEvents.has(key)) return false;
    state.seenEvents.add(key);
    return true;
  },
}));

vi.mock("../src/services/kommoClient", () => {
  const leadsOf = (contactId: string) => {
    if (!state.kommoContactLeads.has(contactId)) state.kommoContactLeads.set(contactId, new Set());
    return state.kommoContactLeads.get(contactId)!;
  };
  return {
    getContactLeadIds: async (contactId: string) => [...leadsOf(contactId)],
    findContactsByPhoneQuery: async () => [],
    linkContactToLead: async (leadId: string, contactId: string) => {
      state.writes.push(["link", leadId]);
      leadsOf(contactId).add(leadId);
      return { _embedded: { links: [{ to_entity_id: Number(contactId) }] } };
    },
    getLead: async (leadId: string) => ({
      id: Number(leadId),
      ...(state.leadStage.get(leadId) ?? { pipeline_id: 14491207, status_id: 111934987 }),
    }),
    moveLeadToStage: async (leadId: string, pipelineId: number, statusId: number) => {
      state.writes.push(["move", leadId]);
      state.leadStage.set(leadId, { pipeline_id: pipelineId, status_id: statusId });
      return {};
    },
  };
});

import { extractLinkedLeadIds, processIncomingEntity } from "../src/services/duplicateDetector";
import { DUPLICATES_PIPELINE_ID, DUPLICATES_STATUS_ID } from "../src/services/duplicateUnifier";

// IDs reales del caso Matias Franco. Gana el mas nuevo (ids mas altos).
const PHONE_RAW = "+5493777808738";
const OLDER = { contactId: "40486170", leadId: "22626166" };
const NEWER = { contactId: "40486762", leadId: "22626774" };
const IN_DUPLICATES = { pipeline_id: DUPLICATES_PIPELINE_ID, status_id: DUPLICATES_STATUS_ID };

/** Arma el input como lo hace routes/webhooks.ts para un contacts.add/update. */
function contactEvent(contactId: string, linkedLeads: string[], extra: Record<string, unknown> = {}) {
  const linkedLeadIds = extractLinkedLeadIds(
    Object.fromEntries(linkedLeads.map((id) => [id, { ID: id }]))
  );
  return {
    entityType: "contact" as const,
    entityId: contactId,
    contactId,
    leadId: linkedLeadIds[0] ?? null,
    linkedLeadIds,
    phonesRaw: [PHONE_RAW],
    source: "unknown" as const,
    rawPayload: { id: contactId, linkedLeads, ...extra },
  };
}

function setKommoLinks(contactId: string, leads: string[]) {
  state.kommoContactLeads.set(contactId, new Set(leads));
}

beforeEach(() => {
  state.phoneRows = [];
  state.detections = [];
  state.seenEvents = new Set();
  state.kommoContactLeads = new Map();
  state.leadStage = new Map();
  state.writes = [];
});

describe("eco de fusion", () => {
  it("duplicado -> resolucion automatica -> los contacts.update posteriores NO generan deteccion inversa", async () => {
    setKommoLinks(OLDER.contactId, [OLDER.leadId]);
    setKommoLinks(NEWER.contactId, [NEWER.leadId]);

    // 1. Entra el contacto original, se indexa.
    await processIncomingEntity(contactEvent(OLDER.contactId, [OLDER.leadId]));
    // 2. Entra el nuevo con el mismo telefono: duplicado real -> se resuelve solo.
    const detection = await processIncomingEntity(contactEvent(NEWER.contactId, [NEWER.leadId]));
    expect(detection.duplicatesDetected).toBe(1);
    expect(state.detections).toHaveLength(1);
    expect(state.detections[0].status).toBe("reviewed_merged");
    // El lead viejo queda colgando del contacto nuevo...
    expect(state.kommoContactLeads.get(NEWER.contactId)).toEqual(new Set([NEWER.leadId, OLDER.leadId]));
    // ...sin perder su contacto original (secundario), y en el embudo Duplicados.
    expect(state.kommoContactLeads.get(OLDER.contactId)).toEqual(new Set([OLDER.leadId]));
    expect(state.leadStage.get(OLDER.leadId)).toEqual(IN_DUPLICATES);

    const writesBeforeEcho = state.writes.length;

    // 3. Eco: Kommo manda contacts.update del GANADOR, ahora con los dos leads...
    const echo = await processIncomingEntity(
      contactEvent(NEWER.contactId, [NEWER.leadId, OLDER.leadId], { updated_at: "after-merge" })
    );
    // ...y un contacts.update del perdedor (su lead cambio de embudo).
    const loserEcho = await processIncomingEntity(
      contactEvent(OLDER.contactId, [OLDER.leadId], { updated_at: "after-merge" })
    );

    expect(echo.duplicatesDetected).toBe(0);
    expect(loserEcho.duplicatesDetected).toBe(0);
    expect(state.detections).toHaveLength(1);
    expect(state.detections.some((d) => d.status === "pending_review")).toBe(false);
    expect(state.writes).toHaveLength(writesBeforeEcho);
  });

  it("el lead ganador queda 100% intacto: Kommo no recibe ninguna escritura sobre el", async () => {
    setKommoLinks(OLDER.contactId, [OLDER.leadId]);
    setKommoLinks(NEWER.contactId, [NEWER.leadId]);

    await processIncomingEntity(contactEvent(OLDER.contactId, [OLDER.leadId]));
    await processIncomingEntity(contactEvent(NEWER.contactId, [NEWER.leadId]));

    expect(state.writes).toEqual([
      ["link", OLDER.leadId],
      ["move", OLDER.leadId],
    ]);
    expect(state.leadStage.has(NEWER.leadId)).toBe(false);
  });

  it("si el evento que llega es el del contacto VIEJO, igual pierde el viejo", async () => {
    setKommoLinks(OLDER.contactId, [OLDER.leadId]);
    setKommoLinks(NEWER.contactId, [NEWER.leadId]);

    // Se indexa primero el nuevo (ej: webhook del viejo perdido).
    await processIncomingEntity(contactEvent(NEWER.contactId, [NEWER.leadId]));
    await processIncomingEntity(contactEvent(OLDER.contactId, [OLDER.leadId]));

    expect(state.leadStage.get(OLDER.leadId)).toEqual(IN_DUPLICATES);
    expect(state.kommoContactLeads.get(NEWER.contactId)).toEqual(new Set([NEWER.leadId, OLDER.leadId]));
    expect(state.writes.map(([, lead]) => lead)).not.toContain(NEWER.leadId);
  });

  it("un tercer contacto mas nuevo se resuelve contra el ganador vigente, sin re-mover el lead que ya esta en Duplicados", async () => {
    const THIRD = { contactId: "40490000", leadId: "22630000" };
    setKommoLinks(OLDER.contactId, [OLDER.leadId]);
    setKommoLinks(NEWER.contactId, [NEWER.leadId]);
    setKommoLinks(THIRD.contactId, [THIRD.leadId]);

    await processIncomingEntity(contactEvent(OLDER.contactId, [OLDER.leadId]));
    await processIncomingEntity(contactEvent(NEWER.contactId, [NEWER.leadId]));
    state.writes = [];

    const result = await processIncomingEntity(contactEvent(THIRD.contactId, [THIRD.leadId]));

    expect(result.duplicatesDetected).toBe(1);
    expect(state.writes).toEqual([
      ["link", NEWER.leadId],
      ["move", NEWER.leadId],
    ]);
    expect(state.leadStage.get(NEWER.leadId)).toEqual(IN_DUPLICATES);
    expect(state.detections.every((d) => d.status === "reviewed_merged")).toBe(true);
  });

  it("el eco tampoco salta si la fila del perdedor es vieja (sin lead en phone_index): consulta a Kommo", async () => {
    // Fila vieja del perdedor, indexada antes de guardar leads.
    state.phoneRows.push({
      id: 280,
      phone_normalized: "5493777808738",
      kommo_contact_id: OLDER.contactId,
      kommo_lead_id: null,
      source: "unknown",
      created_at: "2026-09-23 18:33:47",
    });
    // Estado en Kommo despues de la fusion.
    setKommoLinks(NEWER.contactId, [NEWER.leadId, OLDER.leadId]);
    setKommoLinks(OLDER.contactId, [OLDER.leadId]);
    state.leadStage.set(OLDER.leadId, IN_DUPLICATES);

    const echo = await processIncomingEntity(
      contactEvent(NEWER.contactId, [NEWER.leadId, OLDER.leadId])
    );

    expect(echo.duplicatesDetected).toBe(0);
    expect(state.detections).toHaveLength(0);
  });
});
