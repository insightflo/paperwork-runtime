// [파일 목적] 계층형 KB 노드 조회/검색/목차/등록 라우트 (RBAC 적용, 전체조회 비노출).
// [외부 연결] server/src/services/knowledge/kb-nodes.ts, server/src/app.ts.
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest, forbidden, notFound } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  buildAgentKbTocContext,
  readKbNode,
  searchKbNodes,
  upsertKbNode,
} from "../services/knowledge/kb-nodes.js";

function resolveScopedAgentId(req: Request): string | undefined {
  if (req.actor.type === "board") return undefined;
  if (req.actor.type === "agent" && req.actor.agentId) return req.actor.agentId;
  throw forbidden("Authenticated board user or agent identity required");
}

export function knowledgeBasesRoutes(db: Db) {
  const router = Router();

  // Static routes MUST precede param routes.
  router.get("/companies/:companyId/knowledge-bases/search", (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const agentId = resolveScopedAgentId(req);
      const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const kbId = typeof req.query.kbId === "string" && req.query.kbId.trim() ? req.query.kbId.trim() : undefined;
      const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
      const limit = rawLimit !== undefined && Number.isFinite(rawLimit) ? rawLimit : undefined;
      searchKbNodes(db, { companyId, agentId, query, kbId, limit })
        .then((hits) => res.json({ hits }))
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/knowledge-bases/toc", (req, res, next) => {
    try {
      const { companyId } = req.params;
      assertCompanyAccess(req, companyId);
      const agentId = resolveScopedAgentId(req);
      const rawMax = typeof req.query.maxTokens === "string" ? Number(req.query.maxTokens) : undefined;
      const maxTokens = rawMax !== undefined && Number.isFinite(rawMax) ? Math.min(Math.max(rawMax, 100), 1000) : undefined;
      buildAgentKbTocContext(db, { companyId, agentId, maxTokens })
        .then((toc) => res.json(toc))
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/knowledge-bases/nodes/:nodeId", (req, res, next) => {
    try {
      const { companyId, nodeId } = req.params;
      assertCompanyAccess(req, companyId);
      const agentId = resolveScopedAgentId(req);
      readKbNode(db, { companyId, agentId, nodeId })
        .then((node) => {
          if (!node) return next(notFound("Knowledge node not found"));
          return res.json(node);
        })
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  router.post("/companies/:companyId/knowledge-bases/:kbId/nodes", (req, res, next) => {
    try {
      assertBoard(req);
      const { companyId, kbId } = req.params;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const body = req.body ?? {};
      if (typeof body.slug !== "string" || typeof body.title !== "string") {
        throw badRequest("slug and title strings are required");
      }
      upsertKbNode(db, {
        companyId,
        kbId,
        slug: body.slug,
        title: body.title,
        summary: typeof body.summary === "string" ? body.summary : "",
        content: typeof body.content === "string" ? body.content : "",
        parentId: typeof body.parentId === "string" && body.parentId.trim() ? body.parentId.trim() : null,
        nodeType: typeof body.nodeType === "string" ? body.nodeType : "concept",
        certified: body.certified === true,
        tags: Array.isArray(body.tags) ? body.tags.filter((t: unknown): t is string => typeof t === "string") : [],
        linkedNodeIds: Array.isArray(body.linkedNodeIds)
          ? body.linkedNodeIds.filter((id: unknown): id is string => typeof id === "string")
          : [],
        sourceRefs: Array.isArray(body.sourceRefs) ? body.sourceRefs : [],
        actorId: actor.actorId,
      })
        .then((out) => res.status(out.created ? 201 : 200).json(out.node))
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
