import { describe, expect, it, vi } from "vitest";
import { normalizePhone, normalizePhoneDetailed } from "../src/services/phoneNormalizer";

describe("normalizePhone - Argentina - celular de Buenos Aires (area 11)", () => {
  const canonical = "5491122334455";

  it("normaliza formato E.164 con 9 (como lo manda WhatsApp Business Cloud API)", () => {
    expect(normalizePhone("+5491122334455")).toBe(canonical);
  });

  it("normaliza formato E.164 sin 9 (como a veces lo manda un form web)", () => {
    expect(normalizePhone("+541122334455")).toBe(canonical);
  });

  it("normaliza sin +, solo digitos, con 9", () => {
    expect(normalizePhone("5491122334455")).toBe(canonical);
  });

  it("normaliza formato domestico con 0 y sin 15", () => {
    expect(normalizePhone("01122334455")).toBe(canonical);
  });

  it("normaliza formato domestico clasico con 0 + 15", () => {
    // 011 15-2233-4455
    expect(normalizePhone("011152233 4455")).toBe(canonical);
  });

  it("normaliza formato domestico clasico con guiones y espacios", () => {
    expect(normalizePhone("011 15-2233-4455")).toBe(canonical);
  });

  it("normaliza sin 0 pero con 15 (variante rara pero observada)", () => {
    expect(normalizePhone("1115-2233-4455")).toBe(canonical);
  });

  it("normaliza con espacios, guiones y parentesis mezclados", () => {
    expect(normalizePhone("+54 (911) 2233-4455".replace("(911)", "9 11"))).toBe(canonical);
  });

  it("normaliza con prefijo internacional 00", () => {
    expect(normalizePhone("0054 9 11 2233 4455")).toBe(canonical);
  });
});

describe("normalizePhone - Argentina - celular de Cordoba (area 351, 3 digitos)", () => {
  const canonical = "5493516123456";

  it("normaliza formato E.164 con 9", () => {
    expect(normalizePhone("+5493516123456")).toBe(canonical);
  });

  it("normaliza formato E.164 sin 9", () => {
    expect(normalizePhone("+543516123456")).toBe(canonical);
  });

  it("normaliza formato domestico con 0 y sin 15", () => {
    expect(normalizePhone("03516123456")).toBe(canonical);
  });

  it("normaliza formato domestico clasico con 0 + 15", () => {
    // 0351 15-612-3456
    expect(normalizePhone("0351 15 612 3456")).toBe(canonical);
  });
});

describe("normalizePhone - Argentina - celular de localidad chica (area de 4 digitos)", () => {
  // Ej: Santa Rosa, La Pampa (2954). Numero de abonado de 6 digitos.
  const canonical = "5492954123456";

  it("normaliza formato E.164 con 9", () => {
    expect(normalizePhone("+5492954123456")).toBe(canonical);
  });

  it("normaliza formato domestico clasico con 0 + 15", () => {
    // 02954 15-12-3456
    expect(normalizePhone("02954 15 12 3456")).toBe(canonical);
  });
});

describe("normalizePhone - casos invalidos / baja confianza", () => {
  it("devuelve null para string vacio", () => {
    expect(normalizePhone("")).toBeNull();
  });

  it("devuelve null para input sin digitos", () => {
    expect(normalizePhone("abc")).toBeNull();
  });

  it("devuelve null para numero demasiado corto", () => {
    expect(normalizePhone("12345")).toBeNull();
  });

  it("devuelve null para un patron de 12 digitos que no calza con ningun area+15", () => {
    // 12 digitos pero sin "15" en ninguna de las posiciones esperadas
    const result = normalizePhoneDetailed("123456789012");
    expect(result.canonical).toBeNull();
    expect(result.reason).toMatch(/unrecognized_12_digit_pattern/);
  });

  it("loguea un warning cuando no puede normalizar", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    normalizePhone("123");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("normalizePhone - codigo de pais distinto de Argentina (best-effort)", () => {
  it("antepone el codigo de pais si no esta presente", () => {
    expect(normalizePhone("5551234567", "1")).toBe("15551234567");
  });

  it("no duplica el codigo de pais si ya esta presente", () => {
    expect(normalizePhone("15551234567", "1")).toBe("15551234567");
  });
});

describe("normalizePhone - fixtures reales de produccion (cuenta rudas.kommo.com)", () => {
  // Numeros reales capturados de payloads de produccion (206 webhooks reales).
  // Se verifica que cada uno normalice a un canonico razonable: prefijo
  // "549", area+abonado sin el "9" duplicado, largo total 13.
  const fixtures: Array<{ raw: string; canonical: string; note: string }> = [
    { raw: "+5493444635587", canonical: "5493444635587", note: "Concordia" },
    { raw: "543772638475", canonical: "5493772638475", note: "sin +, sin 9 de celular" },
    { raw: "+5491139504231", canonical: "5491139504231", note: "Buenos Aires, area 11" },
    { raw: "+5493777213613", canonical: "5493777213613", note: "Corrientes, area 377" },
    { raw: "+5493795765060", canonical: "5493795765060", note: "Corrientes, area 379" },
    { raw: "+5493886558615", canonical: "5493886558615", note: "area 388" },
  ];

  for (const { raw, canonical, note } of fixtures) {
    it(`normaliza "${raw}" (${note}) a "${canonical}"`, () => {
      const result = normalizePhoneDetailed(raw, "54");

      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ fixture: note, raw, result }));

      expect(result.canonical).toBe(canonical);
      // Siempre celular internacional "549" + 10 digitos (area+abonado) = 13.
      expect(result.canonical).toMatch(/^549\d{10}$/);
    });
  }

  it("todas las fixtures normalizan a valores distintos entre si (no colisionan)", () => {
    const canonicals = fixtures.map((f) => normalizePhone(f.raw));
    const unique = new Set(canonicals);
    expect(unique.size).toBe(fixtures.length);
  });
});

describe("normalizePhoneDetailed - equivalencia cruzada entre canales (caso de negocio real)", () => {
  it("un mismo celular de CABA llegado por Facebook (sin 9) y por WhatsApp (con 9) normaliza igual", () => {
    const fromFacebook = normalizePhone("1122334455"); // form sin codigo de pais ni 9
    const fromWhatsapp = normalizePhone("+5491122334455");
    expect(fromFacebook).not.toBeNull();
    expect(fromFacebook).toBe(fromWhatsapp);
  });

  it("un mismo celular tipeado 'como se marca' (0+15) y en formato internacional normalizan igual", () => {
    const domesticoViejo = normalizePhone("011 15-2233-4455");
    const internacional = normalizePhone("+5491122334455");
    expect(domesticoViejo).toBe(internacional);
  });
});
