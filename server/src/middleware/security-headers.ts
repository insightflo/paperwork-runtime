import type { RequestHandler } from "express";

const DEFAULT_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
} as const;

/** Mount before routes; explicit headers set before or after it take precedence. */
export function securityHeadersMiddleware(): RequestHandler {
  return (_req, res, next) => {
    for (const [name, value] of Object.entries(DEFAULT_SECURITY_HEADERS)) {
      if (!res.hasHeader(name)) {
        res.setHeader(name, value);
      }
    }
    // Keep cross-origin opener behavior unchanged for OAuth and popup flows.
    next();
  };
}
