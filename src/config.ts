import dotenv from "dotenv";

dotenv.config();

export const config = {
  kommoSubdomain: process.env.KOMMO_SUBDOMAIN || "",
  kommoLongLivedToken: process.env.KOMMO_LONG_LIVED_TOKEN || "",
  kommoWebhookSecret: process.env.KOMMO_WEBHOOK_SECRET || "",
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || "",
  // Connection string de Postgres, ej. postgresql://user:pass@host:25060/db?sslmode=require
  databaseUrl: process.env.DATABASE_URL || "",
  // CA del Postgres administrado (DO App Platform: ${<db>.CA_CERT}). Opcional.
  databaseCaCert: process.env.DATABASE_CA_CERT || "",
  port: Number(process.env.PORT || 3000),
  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || "54",
  // Freno de emergencia. Default false: los duplicados se resuelven
  // automaticamente (el lead perdedor va al embudo Duplicados). Con
  // DRY_RUN=true el detector solo loguea lo que haria, sin escribir en Kommo.
  dryRun: process.env.DRY_RUN === "true",
  // Token para las rutas /admin (ej. POST /admin/unify-test). Si esta vacio,
  // esas rutas quedan deshabilitadas.
  adminToken: process.env.ADMIN_TOKEN || "",
};

export function getKommoBaseUrl(): string {
  if (!config.kommoSubdomain) {
    throw new Error(
      "KOMMO_SUBDOMAIN no esta configurado. Definilo en el .env para poder llamar a la API de Kommo."
    );
  }
  return `https://${config.kommoSubdomain}.kommo.com/api/v4`;
}
