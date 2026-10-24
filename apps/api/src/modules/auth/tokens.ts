import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

const ISSUER = "pulse";
const AUDIENCE = "pulse-api";

export class TokenService {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly ttlSeconds: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  async signAccess(userId: string): Promise<{ token: string; expiresIn: number }> {
    const issuedAt = Math.floor(this.now().getTime() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + this.ttlSeconds)
      .sign(this.key);
    return { token, expiresIn: this.ttlSeconds };
  }

  /** Returns the user id, or throws. The algorithm is pinned so `alg: none` is never accepted. */
  async verifyAccess(token: string): Promise<string> {
    const { payload } = await jwtVerify(token, this.key, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
      currentDate: this.now(),
    });
    if (typeof payload.sub !== "string" || payload.sub === "") throw new Error("missing subject");
    return payload.sub;
  }
}

/** Opaque, high-entropy, single use. Only its hash is stored. */
export const generateRefreshToken = (): string => randomBytes(32).toString("base64url");

export const hashRefreshToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");
