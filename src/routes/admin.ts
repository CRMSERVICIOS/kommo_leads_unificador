import crypto from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { config } from "../config";
import { logger } from "../logger";
import { unifyDuplicate } from "../services/duplicateUnifier";

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
 * { existingContactId, existingLeadId?, newContactId, newLeadId, dryRun? }
 *
 * Disparo MANUAL de la fusion contra un caso puntual (la misma que el
 * detector corre automaticamente). Es independiente de DRY_RUN
 * del .env (que sigue gobernando solo al detector): llamar a este endpoint
 * escribe en Kommo, salvo que se mande `dryRun: true` en el body.
 */
adminRouter.post("/unify-test", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const existingContactId = readId(body.existingContactId);
  const newContactId = readId(body.newContactId);
  const newLeadId = readId(body.newLeadId);
  const existingLeadId =
    body.existingLeadId == null || body.existingLeadId === "" ? null : readId(body.existingLeadId);

  const invalid: string[] = [];
  if (!existingContactId) invalid.push("existingContactId");
  if (!newContactId) invalid.push("newContactId");
  if (!newLeadId) invalid.push("newLeadId");
  if (body.existingLeadId != null && body.existingLeadId !== "" && !existingLeadId) {
    invalid.push("existingLeadId");
  }
  if (invalid.length > 0) {
    res.status(400).json({ error: "invalid_ids", fields: invalid });
    return;
  }

  if (existingContactId === newContactId || existingLeadId === newLeadId) {
    res.status(400).json({
      error: "same_entity",
      reason: "el contacto/lead existente y el nuevo no pueden ser el mismo",
    });
    return;
  }

  const result = await unifyDuplicate(
    {
      existingContactId: existingContactId!,
      existingLeadId,
      newContactId: newContactId!,
      newLeadId: newLeadId!,
    },
    {
      dryRun: body.dryRun === true || body.dryRun === "true",
      lossReasonId: config.duplicateLossReasonId,
    }
  );

  res.status(result.ok ? 200 : 502).json(result);
});
