import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config", () => ({
  config: { kommoSubdomain: "rudas", kommoLongLivedToken: "test-token" },
  getKommoBaseUrl: () => "https://rudas.kommo.com/api/v4",
}));

// Silenciar logs durante los tests de retry para no ensuciar la salida.
vi.mock("../src/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { linkContactToLead, moveLeadToStage, getContactLeadIds } from "../src/services/kommoClient";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function lastRequest() {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, method: init.method, body: JSON.parse(String(init.body)) };
}

// Shapes confirmados contra developers.kommo.com (link-entities,
// updating-single-lead).
describe("kommoClient - shapes de request", () => {
  it("linkContactToLead: POST /leads/{id}/link con is_main", async () => {
    const p = linkContactToLead("22627634", "40487438", { isMain: true });
    await vi.runAllTimersAsync();
    await p;

    expect(lastRequest()).toEqual({
      url: "https://rudas.kommo.com/api/v4/leads/22627634/link",
      method: "POST",
      body: [{ to_entity_id: 40487438, to_entity_type: "contacts", metadata: { is_main: true } }],
    });
  });

  it("moveLeadToStage: PATCH /leads/{id} con pipeline_id + status_id + responsible_user_id", async () => {
    const p = moveLeadToStage("22627454", 14517971, 112145359, 12280712);
    await vi.runAllTimersAsync();
    await p;

    expect(lastRequest()).toEqual({
      url: "https://rudas.kommo.com/api/v4/leads/22627454",
      method: "PATCH",
      body: { pipeline_id: 14517971, status_id: 112145359, responsible_user_id: 12280712 },
    });
  });

  it("error no reintentable (400): lanza en el primer intento", async () => {
    fetchMock.mockResolvedValue(new Response('{"title":"Bad Request"}', { status: 400 }));

    await expect(linkContactToLead("1", "2", { isMain: true })).rejects.toThrow(
      /Kommo API error 400 en \/leads\/1\/link/
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("kommoClient - retry en errores transitorios", () => {
  it("reintenta hasta 3 veces en 403 y lanza al agotar los intentos", async () => {
    fetchMock.mockResolvedValue(new Response("<html>403</html>", { status: 403 }));

    // Adjuntamos .catch inmediatamente para evitar "unhandled rejection" mientras
    // corren los timers falsos. El resultado del catch es el Error en sí.
    const p = getContactLeadIds("123");
    const caught = p.catch((e: unknown) => e as Error);
    await vi.runAllTimersAsync();
    const err = await caught;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Kommo API error 403/);
    // 1 intento original + 3 reintentos = 4 en total
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("reintenta en 429 y lanza al agotar los intentos", async () => {
    fetchMock.mockResolvedValue(new Response("Too Many Requests", { status: 429 }));

    const p = getContactLeadIds("456");
    const caught = p.catch((e: unknown) => e as Error);
    await vi.runAllTimersAsync();
    const err = await caught;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Kommo API error 429/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("tiene éxito si el reintento resuelve el error transitorio", async () => {
    // Primeros 2 intentos: 403. Tercer intento: éxito.
    fetchMock
      .mockResolvedValueOnce(new Response("<html>403</html>", { status: 403 }))
      .mockResolvedValueOnce(new Response("<html>403</html>", { status: 403 }))
      .mockResolvedValue(
        new Response(JSON.stringify({ _embedded: { leads: [{ id: 99 }] } }), { status: 200 })
      );

    const p = getContactLeadIds("789");
    await vi.runAllTimersAsync();
    const leadIds = await p;

    expect(leadIds).toEqual(["99"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("no reintenta en 401 (error permanente)", async () => {
    // 401 no dispara timers, podemos usar el patrón directo.
    fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));

    await expect(getContactLeadIds("999")).rejects.toThrow(/Kommo API error 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
