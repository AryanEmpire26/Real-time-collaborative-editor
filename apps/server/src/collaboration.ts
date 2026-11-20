import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { documentIdPattern, wire } from '@mergepad/shared';
import * as encoding from 'lib0/encoding';
import type { Logger } from 'pino';
import { Counter, Gauge, Registry } from 'prom-client';
import { createClient } from 'redis';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as sync from 'y-protocols/sync';
import * as Y from 'yjs';
import { decodeFrame, frame, maxFrameBytes, maxStateBytes, presenceId, takeToken } from './protocol.js';
import { DocumentCapacityError, type Store } from './store.js';

type Peer = { ws: WebSocket; alive: boolean; presence?: number; budget: { tokens: number; at: number } };
type Room = {
  id: string;
  doc: Y.Doc;
  presence: awarenessProtocol.Awareness;
  peers: Set<Peer>;
  pending: Uint8Array[];
  pendingBytes: number;
  flush?: Promise<void>;
  timer?: NodeJS.Timeout;
};

const channel = 'mergepad:v1:rooms';
const liveLimit = 200;
const presenceFrame = (payload: Uint8Array) =>
  frame(wire.awareness, (enc) => encoding.writeVarUint8Array(enc, payload));

export class Collaboration {
  readonly metrics = new Registry();
  private readonly connections = new Gauge({ name: 'mergepad_connections', help: 'Open WebSockets', registers: [this.metrics] });
  private readonly commits = new Counter({ name: 'mergepad_commits_total', help: 'Durable update batches', registers: [this.metrics] });
  private readonly rejects = new Counter({ name: 'mergepad_rejected_frames_total', help: 'Rejected client frames', registers: [this.metrics] });
  private readonly rooms = new Map<string, Promise<Room | undefined>>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: maxFrameBytes });
  private readonly pub;
  private readonly sub;
  private heartbeat?: NodeJS.Timeout;
  private stopping = false;
  private generation = 0;

  constructor(url: string, private readonly instance: string, private readonly store: Store, private readonly log: Logger) {
    this.pub = createClient({ url, disableOfflineQueue: true });
    this.sub = this.pub.duplicate();
    for (const client of [this.pub, this.sub]) {
      client.on('error', (err) => this.log.warn({ err }, 'Redis connection error'));
      client.on('reconnecting', () => this.invalidate());
    }
  }

  get ready() {
    return !this.stopping && this.pub.isReady && this.sub.isReady;
  }

  async start() {
    await Promise.all([this.pub.connect(), this.sub.connect()]);
    await this.sub.subscribe(channel, (value) => void this.receive(value));
    this.heartbeat = setInterval(() => {
      for (const task of this.rooms.values()) void task.then((room) => {
        for (const peer of room?.peers ?? []) {
          if (!peer.alive) peer.ws.terminate();
          else {
            peer.alive = false;
            peer.ws.ping();
          }
        }
      }).catch(() => { /* Loading errors are handled by the upgrade request. */ });
    }, 20_000);
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, origin: string) {
    const id = req.url?.split('?')[0]?.match(/^\/ws\/([^/]+)$/)?.[1];
    if (!id || !documentIdPattern.test(id)) return this.reject(socket, '404 Not Found');
    if (req.headers.origin && req.headers.origin !== origin) return this.reject(socket, '403 Forbidden');
    if (!this.ready || this.wss.clients.size >= liveLimit) return this.reject(socket, '503 Service Unavailable');
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.connections.inc();
      ws.once('close', () => this.connections.dec());
      ws.on('error', (err) => this.log.debug({ err, id }, 'WebSocket error'));
      void this.join(id, ws).catch((err) => {
        this.log.error({ err, id }, 'Could not load room');
        ws.close(1011, 'Room unavailable');
      });
    });
  }

  private reject(socket: Duplex, status: string) {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  private async join(id: string, ws: WebSocket) {
    const generation = this.generation;
    const inbox: [RawData, boolean][] = [];
    let inboxBytes = 0;
    const buffer = (data: RawData, binary: boolean) => {
      if (inbox.length >= 16 || !Buffer.isBuffer(data) || inboxBytes + data.length > maxFrameBytes) {
        return ws.close(1013, 'Room is still loading');
      }
      inboxBytes += data.length;
      inbox.push([data, binary]);
    };
    ws.on('message', buffer);
    let task = this.rooms.get(id);
    if (!task) {
      task = this.load(id);
      this.rooms.set(id, task);
      const clear = () => { if (this.rooms.get(id) === task) this.rooms.delete(id); };
      void task.then((room) => { if (!room) clear(); }, clear);
    }
    const room = await task.finally(() => ws.off('message', buffer));
    if (!room) return ws.close(1008, 'Document not found');
    if (!this.ready || generation !== this.generation || ws.readyState !== WebSocket.OPEN) {
      this.release(room);
      return ws.close(1013, 'Try again');
    }
    const peer: Peer = { ws, alive: true, budget: { tokens: 120, at: performance.now() } };
    room.peers.add(peer);
    ws.on('pong', () => { peer.alive = true; });
    const onMessage = (data: RawData, binary: boolean) => {
      if (ws.readyState !== WebSocket.OPEN || !this.ready) return;
      if (!takeToken(peer.budget, performance.now())) {
        this.rejects.inc();
        return ws.close(1008, 'Message rate exceeded');
      }
      if (!binary || !Buffer.isBuffer(data)) {
        this.rejects.inc();
        return ws.close(1003, 'Expected binary protocol');
      }
      try {
        this.message(room, peer, data);
      } catch (err) {
        this.rejects.inc();
        this.log.debug({ err, id }, 'Invalid client frame');
        ws.close(1008, 'Invalid collaboration frame');
      }
    };
    ws.on('message', onMessage);
    ws.on('close', () => {
      if (peer.presence !== undefined) awarenessProtocol.removeAwarenessStates(room.presence, [peer.presence], peer);
      room.peers.delete(peer);
      this.release(room);
    });
    this.send(ws, frame(wire.sync, (enc) => sync.writeSyncStep1(enc, room.doc)));
    this.sendPresence(room, ws);
    for (const [data, binary] of inbox) onMessage(data, binary);
  }

  private async load(id: string): Promise<Room | undefined> {
    const stored = await this.store.get(id);
    if (!stored) return;
    const doc = new Y.Doc();
    if (stored.state.length) Y.applyUpdate(doc, stored.state);
    const presence = new awarenessProtocol.Awareness(doc);
    presence.setLocalState(null);
    const room: Room = { id, doc, presence, peers: new Set(), pending: [], pendingBytes: 0 };
    doc.on('update', (update: Uint8Array) => {
      this.broadcast(room, frame(wire.sync, (enc) => sync.writeUpdate(enc, update)));
    });
    presence.on('update', (change: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const ids = [...change.added, ...change.updated, ...change.removed];
      if (!ids.length) return;
      const data = awarenessProtocol.encodeAwarenessUpdate(presence, ids);
      this.broadcast(room, presenceFrame(data));
      if (typeof origin === 'object' && origin !== null) void this.publish(room, 'presence', data).catch((err) => {
        this.log.warn({ err, id }, 'Presence fan-out failed');
      });
    });
    return room;
  }

  private sendPresence(room: Room, ws: WebSocket) {
    const ids = [...room.presence.getStates().keys()];
    if (ids.length) this.send(ws, presenceFrame(awarenessProtocol.encodeAwarenessUpdate(room.presence, ids)));
  }

  private message(room: Room, peer: Peer, bytes: Uint8Array) {
    const message = decodeFrame(bytes);
    switch (message.kind) {
      case 'state-vector':
        this.send(peer.ws, frame(wire.sync, (enc) => sync.writeSyncStep2(enc, room.doc, message.payload)));
        void this.publish(room, 'query', new Uint8Array()).catch((err) => {
          this.log.warn({ err, id: room.id }, 'Cross-instance presence query failed');
        });
        break;
      case 'presence-query':
        this.sendPresence(room, peer.ws);
        break;
      case 'presence': {
        const id = presenceId(message.payload);
        // y-websocket rebroadcasts awareness it receives; never relay another user's echo.
        if (id === undefined || id === room.doc.clientID || (peer.presence !== undefined && peer.presence !== id) ||
            (peer.presence === undefined && [...room.peers].some((other) => other.presence === id))) return;
        peer.presence = id;
        awarenessProtocol.applyAwarenessUpdate(room.presence, message.payload, peer);
        break;
      }
      case 'update':
        if (room.pendingBytes + message.payload.length > maxStateBytes * 2) {
          return peer.ws.close(1013, 'Room write queue full');
        }
        room.pending.push(message.payload);
        room.pendingBytes += message.payload.length;
        if (!room.timer && !room.flush) room.timer = setTimeout(() => this.flush(room), 40);
        break;
    }
  }

  private flush(room: Room) {
    clearTimeout(room.timer);
    room.timer = undefined;
    if (room.flush || !room.pending.length) return room.flush;
    const updates = room.pending.splice(0);
    room.pendingBytes = 0;
    room.flush = (async () => {
      const merged = Y.mergeUpdates(updates);
      const state = await this.store.persist(room.id, [merged]);
      this.commits.inc();
      Y.applyUpdate(room.doc, state);
      await this.publish(room, 'update', merged);
    })().catch((err) => {
      this.log.error({ err, id: room.id }, 'Update could not be replicated');
      if (err instanceof DocumentCapacityError) {
        for (const peer of room.peers) peer.ws.close(1009, 'Document storage limit');
      } else {
        this.invalidate();
      }
    }).finally(() => {
      room.flush = undefined;
      if (room.pending.length) void this.flush(room);
      else this.release(room);
    });
    return room.flush;
  }

  private async publish(room: Room, kind: string, data: Uint8Array) {
    await this.pub.publish(channel, JSON.stringify({
      from: this.instance, id: room.id, kind, data: Buffer.from(data).toString('base64'),
    }));
  }

  private async receive(value: string) {
    try {
      const { from, id, kind, data } = JSON.parse(value);
      if (from === this.instance) return;
      const room = await this.rooms.get(id);
      if (!room) return;
      const bytes = Buffer.from(data, 'base64');
      if (kind === 'update') Y.applyUpdate(room.doc, bytes);
      if (kind === 'presence') awarenessProtocol.applyAwarenessUpdate(room.presence, bytes, 'redis');
      if (kind === 'query') {
        const ids = [...room.peers].flatMap((peer) =>
          peer.presence !== undefined && room.presence.getStates().has(peer.presence) ? [peer.presence] : []);
        if (ids.length) await this.publish(room, 'presence', awarenessProtocol.encodeAwarenessUpdate(room.presence, ids));
      }
    } catch (err) {
      this.log.warn({ err }, 'Redis event could not be applied');
    }
  }

  private send(ws: WebSocket, bytes: Uint8Array) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > maxFrameBytes * 2) ws.close(1013, 'Slow consumer');
    else ws.send(bytes);
  }

  private broadcast(room: Room, bytes: Uint8Array) {
    for (const peer of room.peers) this.send(peer.ws, bytes);
  }

  private release(room: Room) {
    if (room.peers.size || room.flush || room.pending.length) return;
    const task = this.rooms.get(room.id);
    void task?.then((active) => {
      if (active === room && !room.peers.size && !room.flush && !room.pending.length) {
        this.rooms.delete(room.id);
        room.doc.destroy();
      }
    });
  }

  private invalidate(code = 1013) {
    this.generation++;
    for (const ws of this.wss.clients) ws.close(code, 'Reconnect to sync');
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.heartbeat);
    for (const ws of this.wss.clients) ws.terminate();
    await Promise.allSettled([...this.rooms.values()].map(async (task) => {
      const room = await task;
      if (!room) return;
      while (room.flush || room.pending.length) await this.flush(room);
      room.doc.destroy();
    }));
    this.rooms.clear();
    this.wss.close();
    await Promise.allSettled([this.sub.close(), this.pub.close()]);
  }
}
