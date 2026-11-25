import { AsyncLocalStorage } from 'node:async_hooks';
import { MongoClient, type ClientSession, type Db } from 'mongodb';

export class MongoDatabase {
  readonly client: MongoClient;
  readonly db: Db;
  private readonly sessions = new AsyncLocalStorage<ClientSession>();
  private connected = false;

  constructor(uri: string, databaseName: string) {
    // Keep the driver's pool and timeout defaults until production traffic and Atlas
    // connection metrics provide evidence for tuning them.
    this.client = new MongoClient(uri, { appName: 'ai-support-ticket-triage-agent' });
    this.db = this.client.db(databaseName);
  }

  async connect(): Promise<void> {
    if (!this.connected) {
      await this.client.connect();
      await this.db.command({ ping: 1 });
      this.connected = true;
    }
  }

  async checkReady(): Promise<void> {
    await this.connect();
    await this.db.command({ ping: 1 });
  }

  currentSession(): ClientSession | undefined {
    return this.sessions.getStore();
  }

  async transaction<T>(operation: (session: ClientSession) => Promise<T>): Promise<T> {
    const current = this.currentSession();
    if (current) return operation(current);

    await this.connect();
    const session = this.client.startSession();
    try {
      return await session.withTransaction(() => this.sessions.run(session, () => operation(session)));
    } finally {
      await session.endSession();
    }
  }

  async close(): Promise<void> {
    await this.client.close();
    this.connected = false;
  }
}

export function mongoCollectionName(name: string): string {
  const base = name.replace(/\.json$/i, '');
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,119}$/.test(base)) {
    throw new Error('Invalid MongoDB collection name.');
  }
  return `app_${base}`;
}
