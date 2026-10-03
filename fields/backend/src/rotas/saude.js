import express from "express";

/** GET /api/health — pública (healthcheck do Railway). Não toca o banco, como sempre. */
export function rotasSaude() {
  const r = express.Router();
  r.get("/health", (_req, res) => {
    res.json({ status: "ok", db: "postgres", time: new Date().toISOString() });
  });
  return r;
}
