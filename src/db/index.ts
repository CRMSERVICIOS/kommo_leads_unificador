import fs from "node:fs";
import path from "node:path";
import { Pool, type PoolConfig } from "pg";
import { config } from "../config";
import { logger } from "../logger";

let pool: Pool | null = null;

/**
 * Config de SSL para el pool. DO Managed Postgres exige SSL
 * (`?sslmode=require`) con un certificado firmado por su propia CA:
 *  - Si DATABASE_CA_CERT esta definido (en App Platform:
 *    `${<db>.CA_CERT}`), se verifica el certificado contra esa CA.
 *  - Si no, con sslmode=require se cifra la conexion sin verificar la CA.
 * Se saca `sslmode` de la URL porque `pg` lo interpreta como verify-full e
 * ignoraria la config de abajo.
 */
function buildPoolConfig(databaseUrl: string): PoolConfig {
  const url = new URL(databaseUrl);
  const sslMode = url.searchParams.get("sslmode");
  url.searchParams.delete("sslmode");

  const poolConfig: PoolConfig = { connectionString: url.toString(), max: 5 };

  if (config.databaseCaCert) {
    poolConfig.ssl = { ca: config.databaseCaCert, rejectUnauthorized: true };
  } else if (sslMode && sslMode !== "disable") {
    logger.warn("db_ssl_ca_not_configured", {
      reason: "DATABASE_CA_CERT no definido: conexion cifrada sin verificar la CA",
    });
    poolConfig.ssl = { rejectUnauthorized: false };
  }

  return poolConfig;
}

export function getPool(): Pool {
  if (pool) return pool;

  if (!config.databaseUrl) {
    throw new Error(
      "DATABASE_URL no esta configurado. Definilo con la connection string de Postgres (postgresql://user:pass@host:port/db)."
    );
  }

  pool = new Pool(buildPoolConfig(config.databaseUrl));
  pool.on("error", (err) => {
    logger.error("db_pool_error", { error: err.message });
  });
  return pool;
}

/** Crea las tablas/indices si no existen (schema.sql es idempotente). */
export async function runMigrations(): Promise<void> {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");
  await getPool().query(schema);
  logger.info("db_migrations_applied");
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
