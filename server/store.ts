import { Database } from "bun:sqlite";
import { hash } from "../shared/evaluation";
export class Store {
  db: Database;
  constructor(path = "arbiter.sqlite") {
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS content(hash TEXT PRIMARY KEY, body TEXT NOT NULL, owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nonces(nonce TEXT PRIMARY KEY, address TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, status TEXT NOT NULL, evidence TEXT, tx TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS events(block INTEGER NOT NULL, tx TEXT NOT NULL, idx INTEGER NOT NULL, id TEXT NOT NULL, state INTEGER NOT NULL, actor TEXT NOT NULL, PRIMARY KEY(tx,idx));
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  }
  put(body: string, owner: string) {
    const digest = hash(body);
    this.db
      .query("INSERT OR IGNORE INTO content VALUES (?,?,?)")
      .run(digest, new TextEncoder().encode(body), owner);
    return digest;
  }
  get(digest: string): string {
    const row = this.db
      .query("SELECT body FROM content WHERE hash=?")
      .get(digest) as { body: string | Uint8Array } | null;
    if (!row) throw Error("Content not found");
    const body =
      typeof row.body === "string"
        ? row.body
        : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            row.body,
          );
    if (hash(body) !== digest) throw Error("Content integrity check failed");
    return body;
  }
  job(id: string) {
    return this.db.query("SELECT * FROM jobs WHERE id=?").get(id) as {
      id: string;
      status: string;
      evidence: string | null;
      tx: string | null;
      error: string | null;
      attempts: number;
    } | null;
  }
  enqueue(id: string) {
    this.db
      .query("INSERT OR IGNORE INTO jobs(id,status) VALUES (?,'pending')")
      .run(id);
  }
  close() {
    this.db.close();
  }
}
