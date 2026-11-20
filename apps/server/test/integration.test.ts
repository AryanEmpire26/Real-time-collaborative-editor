import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

const first = process.env.TEST_SERVER_A ?? 'http://localhost:4001';
const second = process.env.TEST_SERVER_B ?? 'http://localhost:4002';

async function eventually(check: () => boolean, description: string) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(30);
  }
  assert.fail(description);
}

test('independent instances fan out edits and awareness, merge offline edits, and reload durable state', async (t) => {
  const health = await Promise.all([first, second].map(async (url) => {
    const response = await fetch(`${url}/healthz`);
    assert.equal(response.status, 200);
    return response.json();
  }));
  assert.notEqual(health[0].instance, health[1].instance);
  const created = await fetch(`${first}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Cross-instance test' }),
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();

  function connect(url: string, name: string) {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(`${url.replace(/^http/, 'ws')}/ws`, id, doc, {
      WebSocketPolyfill: WebSocket, disableBc: true, connect: false,
    });
    const close = () => { provider.destroy(); doc.destroy(); };
    t.after(close);
    provider.awareness.setLocalStateField('user', { name, color: '#7c3aed' });
    provider.on('status', ({ status }: { status: string }) => {
      const state = provider.awareness.getLocalState();
      if (status === 'connected' && state) provider.awareness.setLocalState(state);
    });
    provider.connect();
    return { doc, text: doc.getText('integration'), provider };
  }

  const alice = connect(first, 'Alice');
  const bob = connect(second, 'Bob');
  await eventually(() => alice.provider.synced && bob.provider.synced, 'both providers completed sync');
  await eventually(() => alice.provider.awareness.getStates().has(bob.doc.clientID) &&
    bob.provider.awareness.getStates().has(alice.doc.clientID), 'presence replicated in both directions');
  alice.text.insert(0, 'Shared');
  await eventually(() => bob.text.toString() === 'Shared', 'edit crossed Redis');

  alice.provider.disconnect();
  await eventually(() => !bob.provider.awareness.getStates().has(alice.doc.clientID), 'offline presence removed');
  alice.text.insert(alice.text.length, ' offline-A');
  bob.text.insert(bob.text.length, ' online-B');
  alice.provider.connect();
  await eventually(() => alice.provider.synced && alice.text.toString() === bob.text.toString() &&
    bob.text.toString().includes('offline-A') && bob.text.toString().includes('online-B'), 'offline edits converged');
  const expected = bob.text.toString();
  alice.provider.disconnect();
  bob.provider.disconnect();
  await sleep(200);
  const reload = connect(first, 'Reviewer');
  await eventually(() => reload.provider.synced && reload.text.toString() === expected, 'new room recovered from Postgres');
});
