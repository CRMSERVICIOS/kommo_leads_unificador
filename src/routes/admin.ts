import crypto from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { config } from "../config";
import { logger } from "../logger";
import { resolveWinner, unifyDuplicate } from "../services/duplicateUnifier";

export const adminRouter = Router();

/**
 * Proteccion simple por token: header `Authorization: Bearer <ADMIN_TOKEN>`.
 * Si ADMIN_TOKEN no esta configurado, las rutas de admin quedan deshabilitadas.
 */
export function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  if (!config.adminToken) {
    res.status(503).json({ error: "admin_disabled", reason: "ADMIN_TOKEN no configurado" });
    return;
  }

  const header = req.header("authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  const expected = Buffer.from(config.adminToken);
  const actual = Buffer.from(provided);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    logger.warn("admin_unauthorized", { path: req.path, ip: req.ip });
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  next();
}

adminRouter.use(requireAdminToken);

const ID_PATTERN = /^\d+$/;

function readId(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && ID_PATTERN.test(value.trim())) return value.trim();
  return null;
}

/**
 * POST /admin/unify-test
 * { winnerContactId, winnerLeadId, loserContactId, loserLeadId, dryRun? }
 *
 * Disparo MANUAL de la resolucion contra un caso puntual (la misma que el
 * detector corre automaticamente). Es independiente de DRY_RUN
 * del .env (que sigue gobernando solo al detector): llamar a este endpoint
 * escribe en Kommo, salvo que se mande `dryRun: true` en el body.
 * Rechaza el pedido si el ganador no es el de ids mas altos (misma regla
 * que el detector).
 */
adminRouter.post("/unify-test", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const fields = ["winnerContactId", "winnerLeadId", "loserContactId", "loserLeadId"] as const;
  const ids = Object.fromEntries(fields.map((f) => [f, readId(body[f])])) as Record<
    (typeof fields)[number],
    string | null
  >;

  const invalid = fields.filter((f) => !ids[f]);
  if (invalid.length > 0) {
    res.status(400).json({ error: "invalid_ids", fields: invalid });
    return;
  }

  const winner = { contactId: ids.winnerContactId!, leadId: ids.winnerLeadId! };
  const loser = { contactId: ids.loserContactId!, leadId: ids.loserLeadId! };
  if (resolveWinner(winner, loser)?.winner !== winner) {
    res.status(400).json({
      error: "invalid_winner",
      reason: "el ganador tiene que tener el id de contacto Y el id de lead mas altos que el perdedor",
    });
    return;
  }

  const result = await unifyDuplicate(
    {
      winnerContactId: winner.contactId,
      winnerLeadId: winner.leadId,
      loserContactId: loser.contactId,
      loserLeadId: loser.leadId,
    },
    { dryRun: body.dryRun === true || body.dryRun === "true" }
  );

  res.status(result.ok ? 200 : 502).json(result);
});
