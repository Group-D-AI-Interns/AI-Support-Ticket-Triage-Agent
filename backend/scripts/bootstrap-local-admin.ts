import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { JsonFileStore } from '../src/infrastructure/persistence/json/json-file-store.js';
import { JsonIdentityRepository } from '../src/modules/identity/repositories.js';
import { isEnvelope, isMembership, isUser } from '../src/modules/identity/model.js';
import { JsonOrganisationRepository } from '../src/modules/organisations/repositories.js';

type Input = { userId: string; email: string; displayName: string; organisationName: string };

/** Local operator provisioning only; never exposed as an HTTP endpoint. Stop the API first. */
export async function bootstrapLocalAdmin(input: Input, environment: NodeJS.ProcessEnv = process.env) {
  if (environment.NODE_ENV !== 'development') throw new Error('Set NODE_ENV=development for local setup.');
  const values = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value.trim()])) as Input;
  if (Object.values(values).some(value => !value) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    throw new Error('Provide a Keycloak user ID, valid email, display name and organisation name.');
  }
  const files = new JsonFileStore(resolve(environment.DATA_DIRECTORY ?? './.local-data'));
  const identity = new JsonIdentityRepository(files);
  const organisations = new JsonOrganisationRepository(files);
  const users = (await files.read('users.json', isEnvelope(isUser))).records;
  const memberships = (await files.read('memberships.json', isEnvelope(isMembership))).records;
  const tenants = await organisations.listAll();
  const existing = users.find(user => user.id === values.userId);
  const previous = existing?.status === 'active' && existing.email.toLowerCase() === values.email.toLowerCase()
    ? memberships.find(member => member.userId === existing.id && member.status === 'active' && member.roles.includes('organisation_admin') &&
      tenants.some(tenant => tenant.id === member.organisationId && tenant.status === 'active' && tenant.name === values.organisationName)) : undefined;
  if (previous) return { userId: values.userId, organisationId: previous.organisationId, alreadyConfigured: true };
  if (tenants.length || memberships.length || users.some(user => user.id !== values.userId)) {
    throw new Error('Existing identity setup found. Use the approved administrator membership flow; no changes made.');
  }
  if (existing && (existing.status !== 'active' || existing.email.toLowerCase() !== values.email.toLowerCase())) {
    throw new Error('Existing user details/status differ. No account was reactivated or changed.');
  }
  // A matching active user alone can remain after an interrupted first setup.
  if (!existing) await identity.createProvisionedUser(values.userId, values.email, values.displayName);
  const organisation = await organisations.create({ name: values.organisationName }, { userId: values.userId, role: 'organisation_admin' });
  return { userId: values.userId, organisationId: organisation.id, alreadyConfigured: false };
}

async function main() {
  if (process.env.NODE_ENV !== 'development') throw new Error('Set NODE_ENV=development in your local backend/.env.');
  let values = process.argv.slice(2);
  if (!values.length) {
    if (!process.stdin.isTTY) throw new Error('Supply user ID, email, display name and organisation name as four arguments.');
    console.log('Local first-administrator setup. Stop the backend before continuing.');
    console.log('Use your ai-support application user, not the Keycloak console administrator or a service account.');
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      values = [await terminal.question('Keycloak application user ID: '), await terminal.question('Application user email: '),
        await terminal.question('Display name: '), (await terminal.question('Local organisation name [Local Support]: ')).trim() || 'Local Support'];
    } finally { terminal.close(); }
  }
  const [userId, email, displayName, organisationName] = values;
  if (values.length !== 4 || !userId || !email || !displayName || !organisationName) throw new Error('Supply exactly four nonempty setup values.');
  console.log(JSON.stringify(await bootstrapLocalAdmin({ userId, email, displayName, organisationName }), null, 2));
  console.log('Start the backend, retry GET /api/v1/me with your application user access token, and use the returned organisationId in Postman.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Local setup failed.'); process.exitCode = 1; });
}
