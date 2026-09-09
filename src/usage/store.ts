import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { updateUsageCaches } from './aggregate.ts';
import { usageContribution } from './contribution.ts';
import { type UsageFact, UsageFactSchema } from './schema.ts';

const RowSchema = z.object({ body: z.string() });
const RevisionSchema = z.object({ value: z.number() });

/** Checkpoints and facts commit together. Live-only facts belong in durable state, not cache. */
export class UsageStore {
  readonly db: Database;
  readonly identity: string;
  constructor(path: string) {
    this.identity = createHash('sha256').update(path).digest('hex');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY, body TEXT NOT NULL, seq INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS fact_sequence ON facts(seq);
      CREATE INDEX IF NOT EXISTS fact_event_time ON facts(json_extract(body,'$.at'));
      CREATE INDEX IF NOT EXISTS fact_epoch ON facts(json_extract(body,'$.epoch'),seq);
      CREATE TABLE IF NOT EXISTS contributions (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS buckets (query TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(query,key));
      CREATE TABLE IF NOT EXISTS revision (value INTEGER NOT NULL);
      INSERT INTO revision SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM revision);`);
  }
  close() {
    this.db.close();
  }
  eventRange() {
    const read = (order: 'ASC' | 'DESC') => {
      const row = this.db
        .query(`SELECT json_extract(body,'$.at') AS value FROM facts
        WHERE json_extract(body,'$.at') IS NOT NULL ORDER BY json_extract(body,'$.at') ${order} LIMIT 1`)
        .get();
      return row === null ? null : z.object({ value: z.iso.datetime() }).parse(row).value;
    };
    return { first: read('ASC'), last: read('DESC') };
  }
  revision(): number {
    return RevisionSchema.parse(this.db.query('SELECT value FROM revision').get()).value;
  }
  read<T>(key: string, schema: z.ZodType<T>): T | null {
    const row = this.db.query('SELECT body FROM metadata WHERE key=?').get(key);
    return row === null ? null : schema.parse(JSON.parse(RowSchema.parse(row).body));
  }
  write(key: string, value: unknown) {
    this.db.query('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(key, JSON.stringify(value));
  }
  put(input: UsageFact) {
    this.transaction(() => this.putFact(input));
  }
  private putFact(input: UsageFact) {
    const fact = UsageFactSchema.parse(input);
    const key = `${fact.epoch}:${fact.id}`;
    const previous = this.db.query('SELECT body FROM facts WHERE id=?').get(key);
    if (previous !== null) {
      const old = UsageFactSchema.parse(JSON.parse(RowSchema.parse(previous).body));
      if (JSON.stringify({ ...old, observedAt: fact.observedAt }) === JSON.stringify(fact)) return;
    }
    this.db
      .query(`INSERT INTO facts VALUES (?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM facts))
      ON CONFLICT(id) DO UPDATE SET body=excluded.body`)
      .run(key, JSON.stringify(fact));
    this.db.exec('UPDATE revision SET value=value+1');
    this.materialize(key, fact);
    if (fact.mode === 'cumulative') {
      const next = this.neighbor(key, fact, 'next');
      if (next) this.materialize(`${next.epoch}:${next.id}`, next);
    }
  }
  private neighbor(key: string, fact: UsageFact, direction: 'previous' | 'next'): UsageFact | null {
    const compare = direction === 'previous' ? '<' : '>';
    const order = direction === 'previous' ? 'DESC' : 'ASC';
    const row = this.db
      .query(`SELECT body FROM facts WHERE seq ${compare} (SELECT seq FROM facts WHERE id=?)
      AND json_extract(body,'$.epoch')=? AND json_extract(body,'$.mode')='cumulative'
      AND (? != 'claude' OR json_extract(body,'$.model') IS ?) ORDER BY seq ${order} LIMIT 1`)
      .get(key, fact.epoch, fact.runtime, fact.model);
    return row === null ? null : UsageFactSchema.parse(JSON.parse(RowSchema.parse(row).body));
  }
  private materialize(key: string, fact: UsageFact) {
    const row = this.db.query('SELECT body FROM contributions WHERE id=?').get(key);
    const old = row === null ? null : UsageFactSchema.parse(JSON.parse(RowSchema.parse(row).body));
    const next = usageContribution(
      fact,
      fact.mode === 'cumulative' ? this.neighbor(key, fact, 'previous') : null,
    );
    const sequence = z
      .object({ seq: z.number() })
      .parse(this.db.query('SELECT seq FROM facts WHERE id=?').get(key)).seq;
    updateUsageCaches(this, old, next, sequence);
    this.db
      .query(
        'INSERT INTO contributions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(key, JSON.stringify(next));
  }
  *facts(): Generator<UsageFact> {
    for (const row of this.db.query('SELECT body FROM facts ORDER BY seq').iterate())
      yield UsageFactSchema.parse(JSON.parse(RowSchema.parse(row).body));
  }
  contributionPage(after: number, limit: number): { sequence: number; fact: UsageFact }[] {
    return this.db
      .query(`SELECT facts.seq,contributions.body FROM contributions JOIN facts USING(id)
      WHERE facts.seq>? ORDER BY facts.seq LIMIT ?`)
      .all(after, limit)
      .map((raw) => {
        const row = z.object({ seq: z.number(), body: z.string() }).parse(raw);
        return { sequence: row.seq, fact: UsageFactSchema.parse(JSON.parse(row.body)) };
      });
  }
  reset() {
    this.db.exec(
      'DELETE FROM facts; DELETE FROM contributions; DELETE FROM buckets; DELETE FROM metadata; UPDATE revision SET value=value+1',
    );
  }
  transaction<T>(run: () => T): T {
    return this.db.transaction(run).immediate();
  }
}
