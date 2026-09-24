import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config", () => ({
  config: { kommoSubdomain: "rudas", kommoLongLivedToken: "test-token" },
  getKommoBaseUrl: () => "https://rudas.kommo.com/api/v4",
}));

import { linkContactToLead, moveLeadToStage } from "../src/services/kommoClient";

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

// Shapes confirmados contra developers.kommo.com (link-entities,
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

  it("moveLeadToStage: PATCH /leads/{id} con pipeline_id + status_id + responsible_user_id", async () => {
    await moveLeadToStage("22627454", 14517971, 112145359, 12280712);

    expect(lastRequest()).toEqual({
      url: "https://rudas.kommo.com/api/v4/leads/22627454",
      method: "PATCH",
      body: { pipeline_id: 14517971, status_id: 112145359, responsible_user_id: 12280712 },
    });
  });

  it("relanza con el status y body de Kommo cuando responde error", async () => {
    fetchMock.mockResolvedValue(new Response('{"title":"Bad Request"}', { status: 400 }));

    await expect(linkContactToLead("1", "2", { isMain: true })).rejects.toThrow(
      /Kommo API error 400 en \/leads\/1\/link/
    );
  });
});
