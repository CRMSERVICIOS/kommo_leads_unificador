import dotenv from "dotenv";

dotenv.config();

export const config = {
  kommoSubdomain: process.env.KOMMO_SUBDOMAIN || "",
  kommoLongLivedToken: process.env.KOMMO_LONG_LIVED_TOKEN || "",
  kommoWebhookSecret: process.env.KOMMO_WEBHOOK_SECRET || "",
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || "",
  databaseUrl: process.env.DATABASE_URL || "./data/dedup.sqlite",
  port: Number(process.env.PORT || 3000),
  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || "54",
  // Default true: si DRY_RUN no esta seteado, el servicio no escribe nada en
  // Kommo (solo simula). Hay que setear explicitamente DRY_RUN=false para
  // habilitar las escrituras reales (addNote/addTag).
  dryRun: process.env.DRY_RUN !== "false",
};

export function getKommoBaseUrl(): string {
  if (!config.kommoSubdomain) {
    throw new Error(
      "KOMMO_SUBDOMAIN no esta configurado. Definilo en el .env para poder llamar a la API de Kommo."
    );
  }
  return `https://${config.kommoSubdomain}.kommo.com/api/v4`;
}
