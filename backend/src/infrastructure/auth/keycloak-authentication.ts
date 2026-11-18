import { createPublicKey, verify as verifySignature, constants, type JsonWebKey as NodeJsonWebKey } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AuthenticationProvider, AuthenticatedPrincipal } from "../../shared/auth/authentication.ts";

type LocalJwk = NodeJsonWebKey & { kid?: string; alg?: string; use?: string };
type JwksDocument = { keys?: LocalJwk[] };
type OidcConfiguration = { issuer?: string; jwks_uri?: string };

const ALLOWED_ALGORITHMS = new Set(["RS256", "PS256", "ES256", "EdDSA"]);
const CLOCK_SKEW_SECONDS = 30;
const CACHE_MS = 5 * 60 * 1000;

export type KeycloakAuthenticationOptions = {
  issuer: string;
  audience: string;
  jwksUri?: string;
  fetcher?: typeof fetch;
};

/** Validates Keycloak OIDC bearer access tokens against the realm's signing keys. */
export class KeycloakAuthenticationProvider implements AuthenticationProvider {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly configuredJwksUri: string | undefined;
  private readonly fetcher: typeof fetch;
  private jwksCache: { keys: LocalJwk[]; expiresAt: number } | undefined;
  private resolvedJwksUri: string | undefined;

  constructor(options: KeycloakAuthenticationOptions) {
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.configuredJwksUri = options.jwksUri;
    this.fetcher = options.fetcher ?? fetch;
  }

  async authenticate(request: IncomingMessage): Promise<AuthenticatedPrincipal | null> {
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string") return null;
    const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
    if (!match) return null;
    const token = match[1]!;
    const pieces = token.split(".");
    if (pieces.length !== 3) return null;

    let header: Record<string, unknown>;
    let claims: Record<string, unknown> & { sub: string };
    let signature: Buffer;
    try {
      header = parseJson(pieces[0]!);
      const parsedClaims = parseJson(pieces[1]!);
      signature = decodeBase64Url(pieces[2]!);
      if (typeof header.alg !== "string" || !ALLOWED_ALGORITHMS.has(header.alg) || typeof header.kid !== "string") return null;
      if (!this.validClaims(parsedClaims)) return null;
      claims = parsedClaims;
    } catch {
      return null;
    }

    let key = await this.keyFor(header.kid as string);
    if (!key) {
      this.jwksCache = undefined;
      key = await this.keyFor(header.kid as string);
    }
    try {
      if (!key || (key.alg && key.alg !== header.alg) || !this.verify(header.alg as string, key, `${pieces[0]}.${pieces[1]}`, signature)) return null;
      return { userId: claims.sub };
    } catch {
      return null;
    }
  }

  private validClaims(claims: Record<string, unknown>): claims is Record<string, unknown> & { sub: string } {
    const now = Math.floor(Date.now() / 1000);
    const audiences = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
    return claims.iss === this.issuer && claims.typ === "Bearer" && audiences.includes(this.audience) && typeof claims.sub === "string" && claims.sub.length > 0 &&
      typeof claims.exp === "number" && claims.exp > now - CLOCK_SKEW_SECONDS &&
      (claims.nbf === undefined || (typeof claims.nbf === "number" && claims.nbf <= now + CLOCK_SKEW_SECONDS));
  }

  private async keyFor(kid: string): Promise<LocalJwk | undefined> {
    if (!this.jwksCache || this.jwksCache.expiresAt <= Date.now()) {
      const uri = await this.jwksUri();
      const response = await this.fetcher(uri, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`JWKS request failed with status ${response.status}`);
      const payload = await response.json() as JwksDocument;
      if (!Array.isArray(payload.keys)) throw new Error("JWKS response did not contain signing keys");
      this.jwksCache = { keys: payload.keys, expiresAt: Date.now() + CACHE_MS };
    }
    return this.jwksCache.keys.find((key) => key.kid === kid && (!key.use || key.use === "sig"));
  }

  private async jwksUri(): Promise<string> {
    if (this.configuredJwksUri) return this.configuredJwksUri;
    if (this.resolvedJwksUri) return this.resolvedJwksUri;
    const discoveryUrl = `${this.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const response = await this.fetcher(discoveryUrl, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`OIDC discovery failed with status ${response.status}`);
    const configuration = await response.json() as OidcConfiguration;
    if (configuration.issuer !== this.issuer || typeof configuration.jwks_uri !== "string") throw new Error("OIDC discovery issuer or JWKS URI is invalid");
    this.resolvedJwksUri = configuration.jwks_uri;
    return this.resolvedJwksUri;
  }

  private verify(algorithm: string, jwk: LocalJwk, signingInput: string, signature: Buffer): boolean {
    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    const input = Buffer.from(signingInput, "utf8");
    switch (algorithm) {
      case "RS256":
        return verifySignature("RSA-SHA256", input, publicKey, signature);
      case "PS256":
        return verifySignature("sha256", input, { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, signature);
      case "ES256":
        return verifySignature("sha256", input, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
      case "EdDSA":
        return verifySignature(null, input, publicKey, signature);
      default:
        return false;
    }
  }
}

function parseJson(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(decodeBase64Url(value).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("JWT component must be an object");
  return parsed as Record<string, unknown>;
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url data");
  return Buffer.from(value, "base64url");
}
