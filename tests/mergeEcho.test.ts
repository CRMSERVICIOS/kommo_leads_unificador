import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reproduce el "eco de fusion" encontrado con Matias Franco (2026-09-23):
 * unifyDuplicate vincula el lead nuevo al contacto ganador, Kommo manda un
 * contacts.update del ganador, y el detector lo tomaba como un duplicado
 * nuevo con los roles invertidos. Usa fakes con estado (DB en memoria +
 * Kommo en memoria) para que el efecto real de la fusion (el link) sea lo
 * que ve el evento siguiente.
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
  notes: [] as { entityType: string; entityId: string }[],
  /** lead -> status_id, como lo ve Kommo. */
  leadStatus: new Map<string, number>(),
  tags: [] as { entityType: string; entityId: string; tag: string }[],
}));

vi.mock("../src/config", () => ({
  config: { defaultCountryCode: "54", dryRun: false, duplicateLossReasonId: 38469131 },
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
      leadsOf(contactId).add(leadId);
      return { _embedded: { links: [{ to_entity_id: Number(contactId) }] } };
    },
    createNote: async (entityType: string, entityId: string) => {
      state.notes.push({ entityType, entityId });
      return {};
    },
    addTagsToEntity: async (entityType: string, entityId: string, tags: string[]) => {
      for (const tag of tags) state.tags.push({ entityType, entityId, tag });
      return {};
    },
    getLead: async (leadId: string) => ({
      id: Number(leadId),
      pipeline_id: 14491207,
      status_id: state.leadStatus.get(leadId) ?? 111934987,
    }),
    updateLeadStatus: async (leadId: string, _pipelineId: number, statusId: number) => {
      state.leadStatus.set(leadId, statusId);
      return {};
    },
    addNote: async (entityType: string, entityId: string) => {
      state.notes.push({ entityType, entityId });
    },
    addTag: async (entityType: string, entityId: string, tag: string) => {
      state.tags.push({ entityType, entityId, tag });
    },
  };
});

import { extractLinkedLeadIds, processIncomingEntity } from "../src/services/duplicateDetector";
import { unifyDuplicate } from "../src/services/duplicateUnifier";

// IDs reales del caso Matias Franco.
const PHONE_RAW = "+5493777808738";
const WINNER = { contactId: "40486170", leadId: "22626166" };
const LOSER = { contactId: "40486762", leadId: "22626774" };

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
  state.notes = [];
  state.tags = [];
  state.leadStatus = new Map();
});

describe("eco de fusion", () => {
  it("duplicado -> fusion automatica -> el contacts.update del ganador NO genera deteccion inversa", async () => {
    setKommoLinks(WINNER.contactId, [WINNER.leadId]);
    setKommoLinks(LOSER.contactId, [LOSER.leadId]);

    // 1. Entra el contacto original, se indexa.
    await processIncomingEntity(contactEvent(WINNER.contactId, [WINNER.leadId]));
    // 2. Entra el nuevo con el mismo telefono: duplicado real -> se fusiona solo.
    const detection = await processIncomingEntity(contactEvent(LOSER.contactId, [LOSER.leadId]));
    expect(detection.duplicatesDetected).toBe(1);
    expect(state.detections).toHaveLength(1);
    expect(state.detections[0].status).toBe("reviewed_merged");
    expect(state.kommoContactLeads.get(WINNER.contactId)).toEqual(new Set([WINNER.leadId, LOSER.leadId]));
    expect(state.leadStatus.get(LOSER.leadId)).toBe(143);
    expect(state.tags).toEqual([{ entityType: "leads", entityId: LOSER.leadId, tag: "duplicado-fusionado" }]);

    const notesBeforeEcho = state.notes.length;
    const tagsBeforeEcho = state.tags.length;

    // 3. Eco: Kommo manda contacts.update del GANADOR, ahora con los dos leads...
    const echo = await processIncomingEntity(
      contactEvent(WINNER.contactId, [WINNER.leadId, LOSER.leadId], { updated_at: "after-merge" })
    );
    // ...y un contacts.update del perdedor (su lead cambio de estado).
    const loserEcho = await processIncomingEntity(
      contactEvent(LOSER.contactId, [LOSER.leadId], { updated_at: "after-merge" })
    );

    expect(echo.duplicatesDetected).toBe(0);
    expect(loserEcho.duplicatesDetected).toBe(0);
    expect(state.detections).toHaveLength(1);
    expect(state.detections.some((d) => d.status === "pending_review")).toBe(false);
    expect(state.notes).toHaveLength(notesBeforeEcho);
    expect(state.tags).toHaveLength(tagsBeforeEcho);
  });

  it("el eco tampoco salta si la fila del perdedor es vieja (sin lead en phone_index): consulta a Kommo", async () => {
    // Estado real de la DB: el perdedor 40486762 se indexo antes de guardar leads.
    state.phoneRows.push({
      id: 280,
      phone_normalized: "5493777808738",
      kommo_contact_id: LOSER.contactId,
      kommo_lead_id: null,
      source: "unknown",
      created_at: "2026-09-23 18:33:47",
    });
    // Estado real en Kommo despues de la fusion (leido por API el 2026-09-23).
    setKommoLinks(WINNER.contactId, [WINNER.leadId, LOSER.leadId]);
    setKommoLinks(LOSER.contactId, [LOSER.leadId]);

    const echo = await processIncomingEntity(
      contactEvent(WINNER.contactId, [WINNER.leadId, LOSER.leadId])
    );

    expect(echo.duplicatesDetected).toBe(0);
    expect(state.detections).toHaveLength(0);
  });

  it("un duplicado real (sin leads en comun) se sigue detectando", async () => {
    setKommoLinks(WINNER.contactId, [WINNER.leadId]);
    setKommoLinks(LOSER.contactId, [LOSER.leadId]);

    await processIncomingEntity(contactEvent(WINNER.contactId, [WINNER.leadId]));
    const result = await processIncomingEntity(contactEvent(LOSER.contactId, [LOSER.leadId]));

    expect(result.duplicatesDetected).toBe(1);
    expect(state.leadStatus.get(LOSER.leadId)).toBe(143);
    expect(state.detections[0]).toMatchObject({
      existing_contact_id: WINNER.contactId,
      existing_lead_id: WINNER.leadId,
      new_contact_id: LOSER.contactId,
      new_lead_id: LOSER.leadId,
    });
  });
});
