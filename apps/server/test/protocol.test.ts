import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wire } from '@mergepad/shared';
import * as encoding from 'lib0/encoding';
import * as sync from 'y-protocols/sync';
import * as Y from 'yjs';
import { decodeFrame, frame, presenceId, takeToken } from '../src/protocol.js';

test('parses standard sync messages and distinguishes an empty update', () => {
  const doc = new Y.Doc();
  const vector = decodeFrame(frame(wire.sync, (enc) => sync.writeSyncStep1(enc, doc)));
  assert.equal(vector.kind, 'state-vector');
  assert.equal(decodeFrame(frame(wire.sync, (enc) => sync.writeSyncStep2(enc, doc))).kind, 'noop');
  doc.getText('demo').insert(0, 'hello');
  const message = decodeFrame(frame(wire.sync, (enc) => sync.writeUpdate(enc, Y.encodeStateAsUpdate(doc))));
  assert.equal(message.kind, 'update');
  assert.throws(() => decodeFrame(Uint8Array.of(3, 0)));
  assert.throws(() => decodeFrame(Uint8Array.of(0, 2, 1, 255)));
  doc.destroy();
});

test('validates awareness claims and guest labels', () => {
  const encode = (name: string, color: string) => {
    const enc = encoding.createEncoder();
    [1, 42, 3].forEach((value) => encoding.writeVarUint(enc, value));
    encoding.writeVarString(enc, JSON.stringify({ user: { name, color } }));
    return encoding.toUint8Array(enc);
  };
  assert.equal(presenceId(encode('Ada', '#7c3aed')), 42);
  assert.throws(() => presenceId(encode('  ', '#7c3aed')));
  assert.throws(() => presenceId(encode('Ada', 'red')));
  assert.equal(presenceId(Uint8Array.of(2)), undefined);
});

test('rate budget permits a burst and refills over time', () => {
  const bucket = { tokens: 2, at: 0 };
  assert.equal(takeToken(bucket, 0, 2, 2), true);
  assert.equal(takeToken(bucket, 0, 2, 2), true);
  assert.equal(takeToken(bucket, 400, 2, 2), false);
  assert.equal(takeToken(bucket, 500, 2, 2), true);
  assert.equal(takeToken(bucket, 500, 2, 2), false);
});
