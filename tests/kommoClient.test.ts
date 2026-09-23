import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config", () => ({
  config: { kommoSubdomain: "rudas", kommoLongLivedToken: "test-token" },
  getKommoBaseUrl: () => "https://rudas.kommo.com/api/v4",
}));

import {
  addTagsToEntity,
  createNote,
  linkContactToLead,
  updateLeadStatus,
} from "../src/services/kommoClient";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastRequest() {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, method: init.method, body: JSON.parse(String(init.body)) };
}

// Shapes confirmados contra developers.kommo.com (link-entities, add-notes,
// updating-single-lead).
describe("kommoClient - shapes de request", () => {
  it("linkContactToLead: POST /leads/{id}/link con is_main", async () => {
    await linkContactToLead("22627634", "40487438", { isMain: true });

    expect(lastRequest()).toEqual({
      url: "https://rudas.kommo.com/api/v4/leads/22627634/link",
      method: "POST",
      body: [{ to_entity_id: 40487438, to_entity_type: "contacts", metadata: { is_main: true } }],
    });
  });

  it("createNote: POST /leads/notes con entity_id en el body", async () => {
    await createNote("leads", "22627634", "hola");

    expect(lastRequest()).toEqual({
      url: "https://rudas.kommo.com/api/v4/leads/notes",
      method: "POST",
      body: [{ entity_id: 22627634, note_type: "common", params: { text: "hola" } }],
    });
  });

  it("addTagsToEntity: usa tags_to_add (no _embedded.tags, que pisa los existentes)", async () => {
    await addTagsToEntity("leads", "22627634", ["duplicado-fusionado"]);

    const req = lastRequest();
    expect(req).toEqual({
      url: "https://rudas.kommo.com/api/v4/leads/22627634",
      method: "PATCH",
      body: { tags_to_add: [{ name: "duplicado-fusionado" }] },
    });
    expect(req.body._embedded).toBeUndefined();
  });

  it("updateLeadStatus: incluye loss_reason_id cuando se pasa", async () => {
    await updateLeadStatus("22627634", 14491207, 143, 38469131);

    expect(lastRequest().body).toEqual({ pipeline_id: 14491207, status_id: 143, loss_reason_id: 38469131 });
  });

  it("updateLeadStatus: PATCH /leads/{id} con pipeline_id + status_id", async () => {
    await updateLeadStatus("22627634", 14491207, 143);

    expect(lastRequest()).toEqual({
      url: "https://rudas.kommo.com/api/v4/leads/22627634",
      method: "PATCH",
      body: { pipeline_id: 14491207, status_id: 143 },
    });
  });

  it("relanza con el status y body de Kommo cuando responde error", async () => {
    fetchMock.mockResolvedValue(new Response('{"title":"Bad Request"}', { status: 400 }));

    await expect(linkContactToLead("1", "2", { isMain: true })).rejects.toThrow(
      /Kommo API error 400 en \/leads\/1\/link/
    );
  });
});
