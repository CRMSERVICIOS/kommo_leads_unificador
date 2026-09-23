import { config } from "../config";
import { logger } from "../logger";

export interface DuplicateNotificationPayload {
  phoneNormalized: string;
  existingContactId: string | null;
  existingLeadId: string | null;
  newContactId: string | null;
  newLeadId: string | null;
  source: string | null;
}

function buildMessage(payload: DuplicateNotificationPayload): string {
  return (
    `:warning: Posible duplicado detectado en Kommo\n` +
    `Telefono: ${payload.phoneNormalized}\n` +
    `Nuevo: contact=${payload.newContactId ?? "-"} lead=${payload.newLeadId ?? "-"} (fuente: ${payload.source ?? "unknown"})\n` +
    `Ya existia: contact=${payload.existingContactId ?? "-"} lead=${payload.existingLeadId ?? "-"}\n` +
    `Revisar manualmente en Kommo (Fase 1: sin fusion automatica).`
  );
}

/**
 * Notifica una deteccion de duplicado potencial. Si SLACK_WEBHOOK_URL esta
 * configurado, se envia ahi; en cualquier caso se loguea en formato
 * estructurado para poder auditar despues.
 */
export async function notifyDuplicateDetected(
  payload: DuplicateNotificationPayload
): Promise<void> {
  const message = buildMessage(payload);

  logger.info("duplicate_detected", {
    phoneNormalized: payload.phoneNormalized,
    existingContactId: payload.existingContactId,
    existingLeadId: payload.existingLeadId,
    newContactId: payload.newContactId,
    newLeadId: payload.newLeadId,
    source: payload.source,
  });

  if (!config.slackWebhookUrl) {
    logger.info("slack_notification_skipped", {
      reason: "SLACK_WEBHOOK_URL no configurado",
    });
    return;
  }

  try {
    const response = await fetch(config.slackWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });

    if (!response.ok) {
      logger.error("slack_notification_failed", {
        status: response.status,
        statusText: response.statusText,
      });
    }
  } catch (err) {
    logger.error("slack_notification_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
