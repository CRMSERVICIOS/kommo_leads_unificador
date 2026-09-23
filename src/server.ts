import express from "express";
import { config } from "./config";
import { getDb } from "./db";
import { logger } from "./logger";
import { healthRouter } from "./routes/health";
import { duplicatesRouter } from "./routes/duplicates";
import { webhooksRouter } from "./routes/webhooks";

const app = express();

// Los webhooks "clasicos" de Kommo llegan como application/x-www-form-urlencoded
// con claves anidadas estilo PHP (ver src/types/kommo.ts). `extended: true`
// hace que `qs` reconstruya esa estructura anidada en objetos JS.
// Tambien soportamos JSON por si alguna integracion (salesbot, digital
// pipelines, o una prueba manual) manda el body como JSON.
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use("/health", healthRouter);
app.use("/duplicates", duplicatesRouter);
app.use("/webhooks", webhooksRouter);

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    logger.error("unhandled_error", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    res.status(500).json({ error: "internal_error" });
  }
);

getDb(); // inicializa el archivo sqlite y corre schema.sql si hace falta

app.listen(config.port, () => {
  logger.info("server_started", { port: config.port });
});
