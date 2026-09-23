import type { NextFunction, Request, Response } from "express";
import { config } from "../config";
import { logger } from "../logger";

/**
 * Middleware de validacion de origen del webhook.
 *
 * TODO (bloqueado hasta tener credenciales/cuenta real de Kommo):
 * Los webhooks "clasicos" de Kommo (Ajustes > Webhooks) historicamente NO
 * incluyen una firma HMAC como si lo hacen otras plataformas (Stripe,
 * GitHub, etc.). La forma habitual de "validar" origen en integraciones
 * clasicas de Kommo es:
 *   1. Confirmar que `account.subdomain` (o `account.id`) del body coincide
 *      con KOMMO_SUBDOMAIN configurado.
 *   2. Opcionalmente, restringir por IP de origen (Kommo publica rangos de
 *      IP en su documentacion) a nivel de firewall/proxy, no en este codigo.
 *   3. Si la integracion es OAuth (no webhook clasico) y Kommo empieza a
 *      firmar los webhooks salientes en el futuro, agregar aca la
 *      verificacion HMAC usando KOMMO_WEBHOOK_SECRET.
 *
 * Por ahora este middleware hace la validacion (1), que es best-effort:
 * si KOMMO_SUBDOMAIN no esta configurado, deja pasar todo (modo desarrollo)
 * pero logueando un warning.
 */
export function verifyKommoWebhook(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const body = req.body as { account?: { subdomain?: string } } | undefined;
  const incomingSubdomain = body?.account?.subdomain;

  if (!config.kommoSubdomain) {
    logger.warn("verify_kommo_webhook_skipped", {
      reason: "KOMMO_SUBDOMAIN no configurado, se acepta el webhook sin validar origen",
    });
    next();
    return;
  }

  if (incomingSubdomain && incomingSubdomain !== config.kommoSubdomain) {
    logger.error("verify_kommo_webhook_rejected", {
      expectedSubdomain: config.kommoSubdomain,
      incomingSubdomain,
    });
    res.status(403).json({ error: "subdomain_mismatch" });
    return;
  }

  // TODO: si en el futuro Kommo provee firma de webhook, validarla aca usando
  // config.kommoWebhookSecret antes de llamar a next().

  next();
}
