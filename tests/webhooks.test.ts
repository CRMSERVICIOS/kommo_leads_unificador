import { describe, expect, it } from "vitest";
import {
  detectEventTypes,
  extractPhoneFromUnsorted,
  extractPhonesFromCustomFields,
} from "../src/routes/webhooks";
import type { KommoCustomField, KommoUnsortedEventPayload } from "../src/types/kommo";

describe("extractPhonesFromCustomFields", () => {
  it("extrae el valor cuando hay un custom_field con code PHONE (contacto real de WhatsApp)", () => {
    const customFields: KommoCustomField[] = [
      {
        id: "731676",
        name: "Telefono",
        code: "PHONE",
        values: [{ value: "+5493456255001", enum: "552420" }],
      },
      { id: "1134182", name: "Unidad", values: [{ value: "0km" }] },
    ];

    expect(extractPhonesFromCustomFields(customFields)).toEqual(["+5493456255001"]);
  });

  it("devuelve array vacio (sin romper) cuando el contacto NO tiene custom_field PHONE (caso real de Facebook)", () => {
    // Shape real capturado: contacto de Facebook con "Interesado en", "Unidad",
    // "Canal" y "Vehiculo anterior", pero SIN ningun code "PHONE".
    const customFields: KommoCustomField[] = [
      { id: "800316", name: "Interesado en:", values: [{ value: "captiva" }] },
      { id: "1134182", name: "Unidad", values: [{ value: "0km", enum: "887638" }] },
      { id: "1134180", name: "Canal", values: [{ value: "Facebook" }] },
      { id: "1126120", name: "Vehiculo anterior", values: [{ value: "Montana 2026" }] },
    ];

    expect(extractPhonesFromCustomFields(customFields)).toEqual([]);
  });

  it("devuelve array vacio si custom_fields es undefined", () => {
    expect(extractPhonesFromCustomFields(undefined)).toEqual([]);
  });
});

describe("extractPhoneFromUnsorted", () => {
  it("extrae el telefono de source_data.client.id (payload real de WhatsApp)", () => {
    const entry: KommoUnsortedEventPayload = {
      uid: "41b65cf1cbf5264762f32a0ca25a339f40d97f059498de69d6be0e6d9081",
      source: "waba:1157583994107495",
      category: "chats",
      source_data: {
        client: { name: "Nicolelop", id: "+5493886558615" },
        data: [{ text: "Me interesa financiar un Chevrolet ONIX 0KM", date: "1790086046" }],
        service: "waba",
      },
      data: { contacts: { id: "40312854" } },
      pipeline_id: "14242275",
    };

    expect(extractPhoneFromUnsorted(entry)).toBe("+5493886558615");
  });

  it("devuelve null (sin romper) si no hay source_data.client.id", () => {
    const entry: KommoUnsortedEventPayload = { uid: "no-client-data" };
    expect(extractPhoneFromUnsorted(entry)).toBeNull();
  });
});

describe("detectEventTypes", () => {
  it("detecta unsorted.update en vez de 'unknown' (payload real de WhatsApp)", () => {
    const types = detectEventTypes({
      account: { subdomain: "rudas" },
      unsorted: {
        update: [
          {
            uid: "abc",
            source_data: { client: { id: "+5493886558615" } },
          },
        ],
      },
    });

    expect(types).toEqual(["unsorted.update"]);
  });

  it("detecta multiples tipos si el body trae mas de una clave", () => {
    const types = detectEventTypes({
      account: { subdomain: "rudas" },
      contacts: { update: [{ id: "1" } as never] },
      leads: { update: [{ id: "2" } as never] },
    });

    expect(types).toEqual(["leads.update", "contacts.update"]);
  });

  it("devuelve ['unknown'] si no reconoce ninguna clave", () => {
    expect(detectEventTypes({ account: { subdomain: "rudas" } })).toEqual(["unknown"]);
  });
});
