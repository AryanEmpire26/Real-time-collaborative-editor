import { randomUUID } from 'node:crypto';
import type { DocumentSummary } from '@mergepad/shared';
import { Pool } from 'pg';
import * as Y from 'yjs';
import { maxStateBytes } from './protocol.js';

export class DocumentCapacityError extends Error {}

export class Store {
  readonly pool: Pool;

  constructor(url: string) {
    this.pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  }

  async initialize() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(83449362)');
      await client.query(`CREATE TABLE IF NOT EXISTS documents (
        id uuid PRIMARY KEY, title text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
        state bytea NOT NULL DEFAULT '\\x'
      )`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async list() {
    return (await this.pool.query<DocumentSummary>(
      'SELECT id, title, updated_at AS "updatedAt" FROM documents ORDER BY updated_at DESC, id LIMIT 100',
    )).rows;
  }

  async create(title: string) {
    const result = await this.pool.query<DocumentSummary>(
      'INSERT INTO documents (id, title) VALUES ($1, $2) RETURNING id, title, updated_at AS "updatedAt"',
      [randomUUID(), title],
    );
    return result.rows[0]!;
  }

  async get(id: string) {
    return (await this.pool.query<DocumentSummary & { state: Buffer }>(
      'SELECT id, title, updated_at AS "updatedAt", state FROM documents WHERE id = $1', [id],
    )).rows[0];
  }

  async persist(id: string, updates: Uint8Array[]) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ state: Buffer }>('SELECT state FROM documents WHERE id = $1 FOR UPDATE', [id]);
      const current = rows[0]?.state;
      if (!current) throw new Error('Document disappeared');
      // Binary merge preserves structs whose causal dependencies haven't arrived yet.
      const state = Y.mergeUpdates(current.length ? [current, ...updates] : updates);
      if (state.length > maxStateBytes) throw new DocumentCapacityError('Document exceeds storage limit');
      if (!current.equals(state)) {
        await client.query('UPDATE documents SET state = $2, updated_at = now() WHERE id = $1', [id, Buffer.from(state)]);
      }
      await client.query('COMMIT');
      return state;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
