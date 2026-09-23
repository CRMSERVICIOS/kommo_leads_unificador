import { Router } from "express";
import {
  listDetectionsByStatus,
  type DuplicateDetectionStatus,
} from "../db/duplicateDetections";

export const duplicatesRouter = Router();

const VALID_STATUSES: DuplicateDetectionStatus[] = [
  "pending_review",
  "reviewed_merged",
  "reviewed_ignored",
];

/**
 * GET /duplicates?status=pending_review
 * Lista las detecciones registradas, para que un humano las revise
 * manualmente en la UI de Kommo (Fase 1: no hay fusion automatica).
 */
duplicatesRouter.get("/", async (req, res) => {
  const statusParam = req.query.status as string | undefined;

  if (statusParam && !VALID_STATUSES.includes(statusParam as DuplicateDetectionStatus)) {
    res.status(400).json({
      error: "invalid_status",
      validStatuses: VALID_STATUSES,
    });
    return;
  }

  const rows = await listDetectionsByStatus(statusParam as DuplicateDetectionStatus | undefined);
  res.status(200).json({ count: rows.length, results: rows });
});
