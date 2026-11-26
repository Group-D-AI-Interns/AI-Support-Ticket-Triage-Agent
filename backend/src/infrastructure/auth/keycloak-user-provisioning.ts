import { IdentityProviderError, type IdentityProvisioningProvider } from "../../shared/auth/authentication.ts";

type TokenResponse = { access_token?: string; expires_in?: number };
type KeycloakUser = { id: string; email?: string; enabled?: boolean };

export type KeycloakUserProvisioningOptions = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  fetcher?: typeof fetch;
  invitationLifespanSeconds?: number;
};

/** Uses a Keycloak service account; grant only the realm user-management roles required by these calls. */
export class KeycloakUserProvisioningProvider implements IdentityProvisioningProvider {
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetcher: typeof fetch;
  private readonly lifespan: number;
  private cachedToken: { value: string; expiresAt: number } | undefined;
  private readonly adminRealmUrl: string;

  constructor(options: KeycloakUserProvisioningOptions) {
    this.issuer = options.issuer.replace(/\/$/, "");
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.fetcher = options.fetcher ?? fetch;
    this.lifespan = options.invitationLifespanSeconds ?? 604800;
    const realm = new URL(this.issuer).pathname.match(/\/realms\/([^/]+)$/)?.[1];
    if (!realm) throw new Error("AUTH_ISSUER must end with /realms/{realm} for Keycloak user management");
    const basePath = new URL(this.issuer).pathname.replace(/\/realms\/[^/]+$/, "");
    this.adminRealmUrl = `${new URL(this.issuer).origin}${basePath}/admin/realms/${encodeURIComponent(decodeURIComponent(realm))}`;
  }

  async inviteUser(input: { email: string; displayName: string }): Promise<{ userId: string }> {
    const token = await this.serviceToken();
    const response = await this.fetcher(`${this.adminRealmUrl}/users`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ username: input.email, email: input.email, firstName: input.displayName, enabled: true, emailVerified: false }),
    });
    if (response.status === 409) throw new IdentityProviderError(409, "USER_ALREADY_EXISTS", "A Keycloak user with this email already exists.");
    if (!response.ok) throw new IdentityProviderError(503, "IDENTITY_PROVIDER_UNAVAILABLE", `Keycloak user creation failed with status ${response.status}`);
    const location = response.headers.get("location");
    const userId = location?.split("/").filter(Boolean).at(-1);
    if (!userId) throw new IdentityProviderError(503, "IDENTITY_PROVIDER_INVALID_RESPONSE", "Keycloak user creation response did not include a user ID.");

    try {
      const actionResponse = await this.fetcher(`${this.adminRealmUrl}/users/${encodeURIComponent(userId)}/execute-actions-email?lifespan=${this.lifespan}`, {
        method: "PUT",
        signal: AbortSignal.timeout(10000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(["VERIFY_EMAIL", "UPDATE_PASSWORD"]),
      });
      if (!actionResponse.ok) throw new IdentityProviderError(503, "IDENTITY_PROVIDER_UNAVAILABLE", `Keycloak invitation email failed with status ${actionResponse.status}`);
      return { userId };
    } catch (error) {
      await this.deleteWithToken(userId, token).catch(() => undefined);
      throw error;
    }
  }

  async deleteUser(userId: string): Promise<void> {
    await this.deleteWithToken(userId, await this.serviceToken());
  }

  async updateUser(userId: string, changes: { displayName?: string }): Promise<void> {
    if (changes.displayName === undefined) return;
    const token = await this.serviceToken();
    const endpoint = `${this.adminRealmUrl}/users/${encodeURIComponent(userId)}`;
    const currentResponse = await this.fetcher(endpoint, { signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${token}` } });
    if (currentResponse.status === 404) throw new Error("Keycloak user was not found.");
    if (!currentResponse.ok) throw new IdentityProviderError(503, "IDENTITY_PROVIDER_UNAVAILABLE", `Keycloak user lookup failed with status ${currentResponse.status}`);
    const current = await currentResponse.json() as Record<string, unknown>;
    const updateResponse = await this.fetcher(endpoint, {
      method: "PUT", signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...current, firstName: changes.displayName }),
    });
    if (!updateResponse.ok) throw new IdentityProviderError(503, "IDENTITY_PROVIDER_UNAVAILABLE", `Keycloak user update failed with status ${updateResponse.status}`);
  }

  private async deleteWithToken(userId: string, token: string): Promise<void> {
    const response = await this.fetcher(`${this.adminRealmUrl}/users/${encodeURIComponent(userId)}`, {
      method: "DELETE", signal: AbortSignal.timeout(10000), headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok && response.status !== 404) throw new IdentityProviderError(503, "IDENTITY_PROVIDER_UNAVAILABLE", `Keycloak user cleanup failed with status ${response.status}`);
  }

  private async serviceToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 10000) return this.cachedToken.value;
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: this.clientId, client_secret: this.clientSecret });
    const response = await this.fetcher(`${this.issuer}/protocol/openid-connect/token`, {
      method: "POST", signal: AbortSignal.timeout(10000), headers: { "content-type": "application/x-www-form-urlencoded" }, body,
    });
    if (!response.ok) throw new IdentityProviderError(503, "IDENTITY_PROVIDER_UNAVAILABLE", `Keycloak service-account token request failed with status ${response.status}`);
    const result = await response.json() as TokenResponse;
    if (typeof result.access_token !== "string" || typeof result.expires_in !== "number") throw new IdentityProviderError(503, "IDENTITY_PROVIDER_INVALID_RESPONSE", "Keycloak token response is invalid");
    this.cachedToken = { value: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 };
    return result.access_token;
  }
}
