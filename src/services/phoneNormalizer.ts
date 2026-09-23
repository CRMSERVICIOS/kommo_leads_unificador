/**
 * Normalizacion de numeros de telefono argentinos a un formato canonico estable,
 * para poder cruzar el mismo numero fisico llegado por canales distintos
 * (Facebook Lead Ads vs WhatsApp Business Cloud API vía Kommo).
 *
 * ---------------------------------------------------------------------------
 * Contexto del numerado argentino (documentado aca porque es la parte no obvia
 * del negocio, y porque determina por que dos strings "distintos" son el mismo
 * telefono):
 *
 * 1. Codigo de pais: 54.
 *
 * 2. "9" de celular: para poder marcar un celular argentino desde el exterior
 *    (o para que APIs internacionales como WhatsApp Business lo acepten), hay
 *    que anteponer un "9" entre el codigo de pais y el codigo de area:
 *       +54 9 11 2233-4455   (formato "internacional" de un celular de CABA/GBA)
 *    WhatsApp Business Cloud API SIEMPRE entrega los numeros de celular
 *    argentinos con este "9". Formularios web (Facebook Lead Ads con un input
 *    libre, o un widget que no fuerza el "9") a veces NO lo incluyen:
 *       +54 11 2233-4455     (mismo celular, sin el "9")
 *    Ambos casos deben normalizar al mismo valor.
 *
 * 3. "0" de larga distancia / trunk prefix: al discar en formato domestico
 *    (no internacional) el codigo de area se antepone con un "0":
 *       011 15-2233-4455     (formato domestico tradicional, ver punto 4)
 *    El "0" se descarta al normalizar.
 *
 * 4. "15" de celular (formato domestico viejo): antes de que existiera el "9"
 *    internacional, para marcar un celular DENTRO de Argentina se insertaba un
 *    "15" despues del codigo de area:
 *       0011... NO, el formato real es: 0 + codigo de area + 15 + numero
 *       Ejemplo Buenos Aires (area 11):      011 15-2233-4455
 *       Ejemplo Cordoba (area 351):          0351 15-612-3456
 *       Ejemplo Santa Rosa, LP (area 2954):  02954 15-12-3456
 *    El "15" NO es parte del numero real: el numero real es codigo de area +
 *    numero de abonado, sin 0 y sin 15. Muchos formularios viejos o gente que
 *    tipea "como marca" incluyen este 15.
 *
 * 5. Longitud del numero de abonado segun longitud del codigo de area (plan
 *    de numeracion de ENACOM): el total codigo de area + numero de abonado es
 *    SIEMPRE 10 digitos en Argentina:
 *       - Codigo de area de 2 digitos (solo "11", CABA y Gran Buenos Aires) +
 *         numero de abonado de 8 digitos.
 *       - Codigo de area de 3 digitos (la mayoria de capitales de provincia:
 *         220s/261/280s/290s/336x/341/342/343/351/362/370s/380s, etc.) +
 *         numero de abonado de 7 digitos.
 *       - Codigo de area de 4 digitos (localidades chicas) + numero de
 *         abonado de 6 digitos.
 *    Esto es lo que usamos para poder "encontrar" y descartar el "15" sin
 *    necesitar una tabla completa de codigos de area: probamos de a una las
 *    3 longitudes posibles (2, 3, 4) y nos quedamos con la que efectivamente
 *    calza con un "15" en esa posicion y el resto de digitos en la longitud
 *    esperada.
 *
 * 6. Decision de diseño: como el universo de numeros que nos interesa cruzar
 *    son celulares (WhatsApp solo funciona con celulares), el formato
 *    canonico que devolvemos SIEMPRE representa "como si fuera un celular
 *    internacional": "549" + codigoDeArea + numeroDeAbonado (13 digitos).
 *    Si el numero de entrada en realidad es una linea fija, igual se
 *    normaliza con el prefijo "549" antepuesto: no es "incorrecto" en el
 *    sentido E.164 estricto, pero es INOFENSIVO para el objetivo de este
 *    servicio (una linea fija nunca va a "colisionar" con un celular real,
 *    los digitos codigoDeArea+numero seguiran siendo unicos), y es lo que
 *    permite que "01122334455" y "+5491122334455" and "5491122334455" caigan
 *    en el mismo valor canonico.
 *
 * 7. Si no podemos llegar con confianza a un numero de 10 digitos
 *    (area+abonado), NO adivinamos: logueamos un warning y devolvemos `null`.
 *    Preferimos un falso negativo (no detectar un duplicado real) a un falso
 *    positivo (avisar de un duplicado que no existe) en esta fase.
 *
 * TODO (mejora futura, no bloqueante para Fase 1): reemplazar la deteccion
 * heuristica de longitud de codigo de area por una tabla real de prefijos de
 * ENACOM si en producción aparecen falsos negativos frecuentes en numeros de
 * 3 vs 4 digitos de area.
 * ---------------------------------------------------------------------------
 */

export interface PhoneNormalizationResult {
  /** Numero canonico ej: "5491122334455", o null si no se pudo normalizar con confianza. */
  canonical: string | null;
  /** Motivo por el cual no se pudo normalizar (solo si canonical es null). */
  reason?: string;
}

const AREA_CODE_LENGTHS = [2, 3, 4] as const;

function onlyDigits(raw: string): string {
  return raw.replace(/\D+/g, "");
}

/**
 * Intenta remover un "15" insertado despues del codigo de area, probando
 * las 3 longitudes de codigo de area posibles del plan de numeracion
 * argentino (ver punto 5 del comentario de cabecera).
 *
 * @param digits string de 12 digitos: codigoDeArea + "15" + numeroDeAbonado
 * @returns los 10 digitos resultantes (codigoDeArea + numeroDeAbonado), o null si no calza ningun patron.
 */
function stripMobileFifteenInsert(digits: string): string | null {
  if (digits.length !== 12) return null;

  for (const areaLen of AREA_CODE_LENGTHS) {
    const areaCode = digits.slice(0, areaLen);
    const marker = digits.slice(areaLen, areaLen + 2);
    const subscriber = digits.slice(areaLen + 2);
    const expectedSubscriberLen = 10 - areaLen;

    if (marker === "15" && subscriber.length === expectedSubscriberLen) {
      return areaCode + subscriber;
    }
  }

  return null;
}

/**
 * Normaliza un numero de telefono (potencialmente argentino) a un formato
 * canonico estable para poder cruzarlo entre canales distintos.
 *
 * @param raw texto crudo tal como llega del payload (puede tener espacios, guiones, parentesis, +, etc.)
 * @param defaultCountryCode codigo de pais a asumir cuando el numero no trae uno explicito (default "54" = Argentina)
 */
export function normalizePhoneDetailed(
  raw: string,
  defaultCountryCode: string = "54"
): PhoneNormalizationResult {
  if (!raw || typeof raw !== "string") {
    return { canonical: null, reason: "empty_or_invalid_input" };
  }

  let digits = onlyDigits(raw);

  if (!digits) {
    return { canonical: null, reason: "no_digits_found" };
  }

  // Solo soportamos la logica especial de Argentina por ahora. Si el codigo
  // de pais no es Argentina, no intentamos adivinar formatos de otros paises:
  // devolvemos best-effort el numero limpio con codigo de pais, marcando
  // baja confianza si no podemos validar longitud.
  if (defaultCountryCode !== "54") {
    return normalizeGenericInternational(digits, defaultCountryCode);
  }

  // 1. Prefijo de discado internacional "00" (ej: "0054911...") -> descartar.
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }

  // 2. Codigo de pais argentino explicito.
  if (digits.startsWith("54") && digits.length >= 12) {
    digits = digits.slice(2);
  }

  // 3. Prefijo de larga distancia "0" (formato domestico "011...", "0351...").
  //    Solo lo sacamos si NO venia con codigo de pais (si venia con 54 no deberia
  //    haber un 0 de por medio; si aparece igual, es dato sucio -> lo removemos
  //    tambien de forma conservadora).
  if (digits.startsWith("0")) {
    digits = digits.slice(1);
  }

  // 4. "9" de celular internacional, antepuesto al codigo de area.
  //    Ningun codigo de area argentino arranca con "9", asi que es seguro
  //    quitarlo si esta presente en esta posicion.
  if (digits.startsWith("9")) {
    digits = digits.slice(1);
  }

  // 5. En este punto esperamos: codigoDeArea + numeroDeAbonado (10 digitos),
  //    o codigoDeArea + "15" + numeroDeAbonado (12 digitos, formato domestico viejo).
  if (digits.length === 12) {
    const stripped = stripMobileFifteenInsert(digits);
    if (stripped) {
      digits = stripped;
    } else {
      return {
        canonical: null,
        reason: `unrecognized_12_digit_pattern:${digits}`,
      };
    }
  }

  if (digits.length !== 10) {
    return {
      canonical: null,
      reason: `unexpected_length_after_normalization:${digits.length}:${digits}`,
    };
  }

  // Validacion basica de sanidad: el codigo de area no puede empezar con 0 o 9.
  if (digits.startsWith("0") || digits.startsWith("9")) {
    return {
      canonical: null,
      reason: `invalid_area_code_prefix:${digits}`,
    };
  }

  return { canonical: `549${digits}` };
}

/**
 * Fallback best-effort para codigos de pais distintos de Argentina. No
 * intentamos aplicar heuristicas locales de otros paises (fuera de alcance
 * de esta fase, que se enfoca en el caso argentino). Simplemente anteponemos
 * el codigo de pais si no esta presente y devolvemos digitos limpios,
 * marcando baja confianza si la longitud resultante parece invalida.
 */
function normalizeGenericInternational(
  digitsInput: string,
  countryCode: string
): PhoneNormalizationResult {
  let digits = digitsInput;

  if (!digits.startsWith(countryCode)) {
    digits = `${countryCode}${digits}`;
  }

  if (digits.length < 8 || digits.length > 15) {
    return {
      canonical: null,
      reason: `unsupported_country_code_or_invalid_length:${countryCode}:${digits}`,
    };
  }

  return { canonical: digits };
}

/**
 * Variante simple que devuelve solo el string canonico (o null), y loguea un
 * warning estructurado cuando no se puede normalizar con confianza. Es la
 * funcion que deberia usar el resto de la aplicacion.
 */
export function normalizePhone(
  raw: string,
  defaultCountryCode: string = "54"
): string | null {
  const result = normalizePhoneDetailed(raw, defaultCountryCode);

  if (!result.canonical) {
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "phone_normalization_failed",
        raw,
        defaultCountryCode,
        reason: result.reason,
      })
    );
    return null;
  }

  return result.canonical;
}
