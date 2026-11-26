import { Router, type Request } from "express";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authSessions } from "@paperclipai/db";
import { notFound, unauthorized } from "../errors.js";

function requireAuthenticatedBoardUser(req: Request): string {
  if (req.actor.type !== "board" || !req.actor.userId) {
    throw unauthorized("Authentication required");
  }
  return req.actor.userId;
}

export function authAccountRoutes(db: Db) {
  const router = Router();

  router.get("/sessions", async (req, res) => {
    const userId = requireAuthenticatedBoardUser(req);
    const now = new Date();
    const rows = await db
      .select({
        id: authSessions.id,
        createdAt: authSessions.createdAt,
        expiresAt: authSessions.expiresAt,
        ipAddress: authSessions.ipAddress,
        userAgent: authSessions.userAgent,
      })
      .from(authSessions)
      .where(and(eq(authSessions.userId, userId), gt(authSessions.expiresAt, now)))
      .orderBy(desc(authSessions.createdAt));

    res.json(
      rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        ipAddress: row.ipAddress ?? null,
        userAgent: row.userAgent ?? null,
        isCurrent: Boolean(req.actor.sessionId && row.id === req.actor.sessionId),
      })),
    );
  });

  router.delete("/sessions/:sessionId", async (req, res) => {
    const userId = requireAuthenticatedBoardUser(req);
    const sessionId = (req.params.sessionId as string).trim();
    if (!sessionId) throw notFound("Session not found");

    const deleted = await db
      .delete(authSessions)
      .where(and(eq(authSessions.id, sessionId), eq(authSessions.userId, userId)))
      .returning({ id: authSessions.id })
      .then((rows) => rows[0] ?? null);

    if (!deleted) throw notFound("Session not found");
    res.json({ ok: true, id: deleted.id });
  });

  router.post("/sessions/revoke-others", async (req, res) => {
    const userId = requireAuthenticatedBoardUser(req);
    const condition = req.actor.sessionId
      ? and(eq(authSessions.userId, userId), ne(authSessions.id, req.actor.sessionId))
      : eq(authSessions.userId, userId);

    const deleted = await db
      .delete(authSessions)
      .where(condition)
      .returning({ id: authSessions.id });

    res.json({ ok: true, revokedCount: deleted.length });
  });

  return router;
}
