import type { FastifyRequest } from "fastify";
import { unauthenticated } from "../../errors.js";
import type { TokenService } from "./tokens.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by `authenticate`. Empty string on unauthenticated routes. */
    userId: string;
  }
}

const BEARER = /^Bearer\s+(\S+)$/i;

/** Runs as an onRequest hook, so a missing token is a 401 before any body validation. */
export function createAuthenticate(tokens: TokenService) {
  return async function authenticate(request: FastifyRequest): Promise<void> {
    const match = BEARER.exec(request.headers.authorization ?? "");
    if (!match?.[1]) throw unauthenticated();
    try {
      request.userId = await tokens.verifyAccess(match[1]);
    } catch {
      throw unauthenticated("Invalid or expired token");
    }
  };
}
