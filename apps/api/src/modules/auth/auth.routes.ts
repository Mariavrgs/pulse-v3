import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { unauthenticated } from "../../errors.js";
import { ErrorResponse as E } from "../../schemas.js";
import type { AuthService, Session } from "./auth.service.js";

export const REFRESH_COOKIE = "pulse_refresh";

const RegisterBody = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(10).max(128), // upper bound keeps hashing cost bounded
});
const LoginBody = z.strictObject({
  email: z.string().min(1).max(254),
  password: z.string().min(1).max(128),
});
const UserDto = z.object({ id: z.string(), email: z.string() });
const TokenResponse = z.object({
  accessToken: z.string(),
  tokenType: z.literal("Bearer"),
  expiresIn: z.number().describe("Access token lifetime in seconds"),
});
const SessionResponse = TokenResponse.extend({ user: UserDto });

export interface AuthRoutesDeps {
  auth: AuthService;
  authenticate: (request: FastifyRequest) => Promise<void>;
  secureCookies: boolean;
}

const tokenPayload = (s: Session) => ({
  accessToken: s.accessToken,
  tokenType: "Bearer" as const,
  expiresIn: s.expiresIn,
});

export function authRoutes(deps: AuthRoutesDeps): FastifyPluginAsync {
  return async (scope) => {
    const app = scope.withTypeProvider<ZodTypeProvider>();

    // The refresh token never appears in a response body: it travels only in an httpOnly
    // cookie scoped to /auth, so page scripts cannot read it and other routes never get it.
    const setRefreshCookie = (reply: FastifyReply, session: Session) =>
      reply.setCookie(REFRESH_COOKIE, session.refreshToken, {
        httpOnly: true,
        secure: deps.secureCookies,
        sameSite: "strict",
        path: "/auth",
        expires: session.refreshExpiresAt,
      });

    app.post(
      "/register",
      {
        schema: {
          tags: ["auth"],
          summary: "Create an account and start a session",
          body: RegisterBody,
          response: { 201: SessionResponse, 400: E, 409: E },
        },
      },
      async (request, reply) => {
        const session = await deps.auth.register(request.body.email, request.body.password);
        setRefreshCookie(reply, session);
        return reply.status(201).send({ ...tokenPayload(session), user: session.user });
      },
    );

    app.post(
      "/login",
      {
        schema: {
          tags: ["auth"],
          summary: "Log in with email and password",
          body: LoginBody,
          response: { 200: SessionResponse, 400: E, 401: E },
        },
      },
      async (request, reply) => {
        const session = await deps.auth.login(request.body.email, request.body.password);
        setRefreshCookie(reply, session);
        return reply.status(200).send({ ...tokenPayload(session), user: session.user });
      },
    );

    app.post(
      "/refresh",
      {
        schema: {
          tags: ["auth"],
          summary: "Exchange the refresh cookie for a new access token (rotates the cookie)",
          response: { 200: TokenResponse, 401: E },
        },
      },
      async (request, reply) => {
        const raw = request.cookies[REFRESH_COOKIE];
        if (!raw) throw unauthenticated("Missing refresh token");
        const session = await deps.auth.refresh(raw);
        setRefreshCookie(reply, session);
        return reply.status(200).send(tokenPayload(session));
      },
    );

    app.post(
      "/logout",
      {
        schema: {
          tags: ["auth"],
          summary: "Revoke the refresh token and clear the cookie",
          response: { 204: z.null() },
        },
      },
      async (request, reply) => {
        await deps.auth.logout(request.cookies[REFRESH_COOKIE]);
        reply.clearCookie(REFRESH_COOKIE, { path: "/auth" });
        return reply.status(204).send(null);
      },
    );

    app.get(
      "/me",
      {
        onRequest: deps.authenticate,
        schema: {
          tags: ["auth"],
          summary: "The authenticated user",
          security: [{ bearerAuth: [] }],
          response: { 200: UserDto, 401: E },
        },
      },
      async (request) => deps.auth.getUser(request.userId),
    );
  };
}
