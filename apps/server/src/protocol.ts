import { maxGuestNameLength, wire } from '@mergepad/shared';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as sync from 'y-protocols/sync';
import * as Y from 'yjs';

export const maxStateBytes = 2 * 1024 * 1024;
export const maxFrameBytes = maxStateBytes + 1024;

export function frame(type: number, write: (enc: encoding.Encoder) => void) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, type);
  write(enc);
  return encoding.toUint8Array(enc);
}

export function decodeFrame(bytes: Uint8Array) {
  const dec = decoding.createDecoder(bytes);
  const type = decoding.readVarUint(dec);
  if (type === wire.queryAwareness && !decoding.hasContent(dec)) return { kind: 'presence-query' } as const;
  const subtype = type === wire.sync ? decoding.readVarUint(dec) : null;
  if (type !== wire.sync && type !== wire.awareness) throw new Error('Unsupported frame');
  const payload = decoding.readVarUint8Array(dec);
  if (decoding.hasContent(dec)) throw new Error('Trailing frame data');
  if (type === wire.awareness && payload.length <= 8192) return { kind: 'presence', payload } as const;
  if (subtype === sync.messageYjsSyncStep1) return { kind: 'state-vector', payload } as const;
  if (subtype === sync.messageYjsSyncStep2 || subtype === sync.messageYjsUpdate) {
    if (payload.length > maxStateBytes) throw new Error('Update exceeds size limit');
    const data = Y.decodeUpdate(payload);
    if (!data.structs.length && !data.ds.clients.size) return { kind: 'noop' } as const;
    return { kind: 'update', payload } as const;
  }
  throw new Error('Unsupported sync subtype or presence payload');
}

export function presenceId(payload: Uint8Array) {
  const dec = decoding.createDecoder(payload);
  // The standard provider echoes multi-client snapshots; only individual claims can be owned.
  if (decoding.readVarUint(dec) !== 1) return;
  const id = decoding.readVarUint(dec);
  decoding.readVarUint(dec); // Awareness clock
  const state: unknown = JSON.parse(decoding.readVarString(dec));
  if (decoding.hasContent(dec)) throw new Error('Trailing presence data');
  if (state !== null) {
    if (typeof state !== 'object' || !('user' in state)) throw new Error('Missing guest identity');
    const user = state.user;
    if (!user || typeof user !== 'object' || !('name' in user) || typeof user.name !== 'string' ||
        !user.name.trim() || user.name.length > maxGuestNameLength ||
        !('color' in user) || typeof user.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(user.color)) {
      throw new Error('Invalid guest identity');
    }
  }
  return id;
}

export function takeToken(bucket: { tokens: number; at: number }, now: number, rate = 60, burst = 120) {
  bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, now - bucket.at) * rate / 1000);
  bucket.at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens--;
  return true;
}
