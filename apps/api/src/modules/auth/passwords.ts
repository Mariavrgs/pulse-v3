import { hash, verify } from "@node-rs/argon2";

/**
 * Argon2id (the library default) with the OWASP-recommended minimum cost:
 * 19 MiB of memory, 2 iterations, 1 lane.
 */
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string): Promise<string> => hash(password, OPTIONS);

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false; // malformed stored hash: treat as mismatch, never as a crash
  }
}

let dummyHash: Promise<string> | undefined;
/**
 * Verified against when the email is unknown, so "no such user" costs the same CPU time
 * as "wrong password" and response timing does not reveal which emails are registered.
 */
export const getDummyHash = (): Promise<string> =>
  (dummyHash ??= hashPassword("pulse-dummy-password"));
