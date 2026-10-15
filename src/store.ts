import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// One small document-store interface. Firestore in production, a JSON file in local development.
export interface Store {
  get<T>(coll: string, id: string): Promise<T | undefined>;
  set(coll: string, id: string, doc: object): Promise<void>;
  delete(coll: string, id: string): Promise<void>;
  // Newest first by the document's createdAt, when it has one.
  list<T>(coll: string, limit: number): Promise<T[]>;
}

export const hashKey = (s: string): string => createHash('sha1').update(s).digest('hex');

const newestFirst = (a: unknown, b: unknown): number =>
  String((b as { createdAt?: string }).createdAt ?? '').localeCompare(String((a as { createdAt?: string }).createdAt ?? ''));

export class MemoryStore implements Store {
  protected data = new Map<string, object>();
  async get<T>(coll: string, id: string): Promise<T | undefined> {
    return this.data.get(`${coll}/${id}`) as T | undefined;
  }
  async set(coll: string, id: string, doc: object): Promise<void> {
    this.data.set(`${coll}/${id}`, structuredClone(doc));
    await this.persist();
  }
  async delete(coll: string, id: string): Promise<void> {
    this.data.delete(`${coll}/${id}`);
    await this.persist();
  }
  async list<T>(coll: string, limit: number): Promise<T[]> {
    const rows = [...this.data].filter(([k]) => k.startsWith(`${coll}/`)).map(([, v]) => v as T);
    return rows.sort(newestFirst).slice(0, limit);
  }
  protected async persist(): Promise<void> {}
}

export class FileStore extends MemoryStore {
  private file: string;
  constructor(dir: string) {
    super();
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'store.json');
    if (existsSync(this.file)) this.data = new Map(Object.entries(JSON.parse(readFileSync(this.file, 'utf8'))));
  }
  protected override async persist(): Promise<void> {
    writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.data)));
  }
}

export async function firestoreStore(projectId: string, databaseId: string): Promise<Store> {
  const { Firestore } = await import('@google-cloud/firestore');
  const db = new Firestore({ projectId, databaseId });
  return {
    async get<T>(coll: string, id: string) {
      const snap = await db.collection(coll).doc(id).get();
      return snap.exists ? (snap.data() as T) : undefined;
    },
    async set(coll: string, id: string, doc: object) {
      await db.collection(coll).doc(id).set(JSON.parse(JSON.stringify(doc)));
    },
    async delete(coll: string, id: string) {
      await db.collection(coll).doc(id).delete();
    },
    async list<T>(coll: string, limit: number) {
      const snap = await db.collection(coll).orderBy('createdAt', 'desc').limit(limit).get();
      return snap.docs.map((d) => d.data() as T);
    },
  };
}

interface Cached<T> {
  value: T;
  expiresAt: number;
}

// Read-through cache. Every paid call (SerpApi, Gemini) goes through this so repeats cost nothing.
export async function cached<T>(store: Store, key: string, ttlMs: number, fn: () => Promise<T>, opts: { fresh?: boolean; now?: () => number } = {}): Promise<{ value: T; hit: boolean }> {
  const now = opts.now ?? Date.now;
  const id = hashKey(key);
  if (!opts.fresh) {
    const hit = await store.get<Cached<T>>('cache', id);
    if (hit && hit.expiresAt > now()) return { value: hit.value, hit: true };
  }
  const value = await fn();
  await store.set('cache', id, { value, expiresAt: now() + ttlMs, createdAt: new Date(now()).toISOString() });
  return { value, hit: false };
}

export class QuotaExceeded extends Error {}

// Monthly cap on paid SerpApi searches, counted by this app.
export class Quota {
  private store: Store;
  private cap: number;
  private now: () => Date;
  constructor(store: Store, cap: number, now: () => Date = () => new Date()) {
    this.store = store;
    this.cap = cap;
    this.now = now;
  }
  private id(): string {
    return `serpapi-${this.now().toISOString().slice(0, 7)}`;
  }
  async used(): Promise<number> {
    return (await this.store.get<{ used: number }>('quota', this.id()))?.used ?? 0;
  }
  async reserve(): Promise<void> {
    const used = await this.used();
    if (used >= this.cap) throw new QuotaExceeded(`monthly search cap of ${this.cap} reached`);
    await this.store.set('quota', this.id(), { used: used + 1 });
  }
  get limit(): number {
    return this.cap;
  }
}
