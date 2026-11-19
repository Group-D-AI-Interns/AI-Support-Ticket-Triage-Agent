# Local Keycloak development

This setup runs Keycloak and PostgreSQL locally in Docker. It uses HTTP at `http://localhost:8081` because port 8080 is already used by the local KnowledgeOps Keycloak. This is for local development only. Every developer runs an isolated local instance; users and realm changes do not sync between machines. The realm is `ai-support` with API audience `support-api`.

## 1. Prepare the host

Install Docker Desktop with the Compose plugin. No DNS, public host or inbound firewall ports are needed. Host port 8081 is bound to loopback only; container port 8080 is not published directly.

## 2. Configure and start

From this directory:

```sh
cp .env.example .env
```

Edit `.env` and replace the sample Keycloak and database passwords with separate values. Keep `.env` private; it is ignored by Git. On PowerShell, copy the template with `Copy-Item .env.example .env`; on macOS/Linux use `cp .env.example .env`. Then start:

```sh
docker compose up -d
docker compose logs -f keycloak postgres
```

The realm import template is `realm/ai-support-realm.json`. It creates the `ai-support` realm, canonical organisation/support/requester realm roles and role/group templates, `support-api` audience, `support-web` OIDC client and `support-admin-service` confidential service account. It disables direct password grants and public registration. The sample redirect URI is a placeholder; update it to your local frontend URL when you have one. The service account's user-management roles must be assigned and verified in the `ai-support` realm's `Clients → support-admin-service → Service account roles` page; grant only required roles. Import applies when the realm does not exist; editing the JSON later does not update an existing realm.

Open `http://localhost:8081/admin/` and verify the `ai-support` realm. PostgreSQL data is stored in the `postgres-data` Docker volume; keep both database and Keycloak volumes backed up. This development mode is not suitable for a public deployment.

## 3. Configure each backend

Each developer copies `backend/.env.example` to `backend/.env` and sets:

```dotenv
AUTH_MODE=keycloak
AUTH_ISSUER=http://localhost:8081/realms/ai-support
AUTH_AUDIENCE=support-api
```

For invitations and profile management, after assigning and verifying service-account roles, set `KEYCLOAK_ADMIN_CLIENT_ID=support-admin-service` and the generated client secret from that client's credentials page. Keep the secret in a secret store or ignored `.env`; never put it in Git or chat. Issue a test login and confirm its access token has the exact `iss` and an `aud` entry for `support-api`. Configure valid SMTP settings in the realm before testing invitation emails.

Each teammate configures their local backend with the issuer for their own local Keycloak port. For a backend running in Docker, `localhost` refers to the backend container itself; configure a shared Docker network and use the Keycloak service name consistently as its advertised hostname and issuer. Local user accounts and changes are not shared among teammates.

## 4. Per-developer operational checklist

Steps 1 and 3 are intentionally local because each teammate runs an isolated Keycloak instance:

1. Copy `.env.example` to `.env` and generate separate values for `KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD` and `KEYCLOAK_DB_PASSWORD`. Generate a separate service-account client secret in the Keycloak admin console. Never commit these values.
2. After creating or recreating the realm, assign the `support-admin-service` service account only the `manage-users`, `view-users`, and `query-users` roles from the `realm-management` client.
3. Configure each developer's own SMTP settings in their local `ai-support` realm. SMTP credentials and sender settings are also local and must not be committed.
4. For an existing local realm, changes in the realm JSON are not imported automatically. If the new realm roles and groups must be present, recreate only with `docker compose down -v && docker compose up -d`. This deletes local users and realm data; do not use it when preserving an existing local setup. The safer alternative is to add the four realm roles and four groups manually in the admin console.

After setup, verify from the deployment directory:

```sh
docker compose ps
curl.exe http://localhost:8081/realms/ai-support/.well-known/openid-configuration
```

Then verify in the admin console that `ai-support` exists and contains `organisation_admin`, `support_lead`, `support_agent`, `requester`, plus the matching role/group templates. Configure the backend's `KEYCLOAK_ADMIN_CLIENT_SECRET` only after the service-account roles and SMTP settings are ready.

## Operations

- Back up the `postgres-data` and `keycloak-data` volumes if local realm data matters.
- Never commit local `.env` files or realm exports containing users, credentials, tokens or SMTP secrets. The checked-in template has no users or secrets.
