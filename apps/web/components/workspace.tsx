'use client';

import { guestColors, isDocumentSummary, maxGuestNameLength } from '@mergepad/shared';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import Placeholder from '@tiptap/extension-placeholder';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { ArrowLeft, Bold, Check, Code2, Heading2, Italic, Link2, List, ListOrdered, Quote, Users } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { Brand } from './library';

type Guest = { name: string; color: string };
type Person = Guest & { id: number };
type Resources = { doc: Y.Doc; provider: WebsocketProvider; guest: Guest };
type Connection = 'connecting' | 'offline' | 'syncing' | 'live';

function getGuest(): Guest {
  const number = Math.floor(Math.random() * 9000) + 1000;
  const color = guestColors[number % guestColors.length] ?? guestColors[0];
  try {
    return { name: sessionStorage.getItem('mergepad:guest')?.slice(0, maxGuestNameLength).trim() || `Guest ${number}`, color };
  } catch {
    return { name: `Guest ${number}`, color };
  }
}

function RichText({ doc, provider, guest }: Resources) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ undoRedo: false, link: false }),
      Collaboration.configure({ document: doc }),
      CollaborationCaret.configure({ provider, user: guest }),
      Placeholder.configure({ placeholder: 'Start writing or paste your notes…' }),
    ],
    editorProps: { attributes: { 'aria-label': 'Document content', role: 'textbox', 'aria-multiline': 'true' } },
  });
  const active = useEditorState({ editor, selector: ({ editor }) => ({
    bold: editor?.isActive('bold'), italic: editor?.isActive('italic'), heading: editor?.isActive('heading', { level: 2 }),
    bulletList: editor?.isActive('bulletList'), orderedList: editor?.isActive('orderedList'),
    quote: editor?.isActive('blockquote'), code: editor?.isActive('codeBlock'),
  }) });
  if (!editor) return <div className="paper" role="status">Preparing editor&hellip;</div>;
  const tools = [
    { key: 'bold', label: 'Bold', Icon: Bold, command: () => editor.chain().focus().toggleBold().run() },
    { key: 'italic', label: 'Italic', Icon: Italic, command: () => editor.chain().focus().toggleItalic().run() },
    { key: 'heading', label: 'Heading', Icon: Heading2, command: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { key: 'bulletList', label: 'Bulleted list', Icon: List, command: () => editor.chain().focus().toggleBulletList().run() },
    { key: 'orderedList', label: 'Numbered list', Icon: ListOrdered, command: () => editor.chain().focus().toggleOrderedList().run() },
    { key: 'quote', label: 'Quote', Icon: Quote, command: () => editor.chain().focus().toggleBlockquote().run() },
    { key: 'code', label: 'Code block', Icon: Code2, command: () => editor.chain().focus().toggleCodeBlock().run() },
  ] as const;
  return <>
    <div className="toolbar" role="group" aria-label="Text formatting">
      {tools.map(({ key, label, Icon, command }) => <button key={key} type="button" className="tool" aria-label={label} aria-pressed={!!active?.[key]} title={label} onClick={command}><Icon size={18} /></button>)}
      <span className="toolbar-note">Rich text</span>
    </div>
    <div className="paper"><EditorContent editor={editor} /></div>
  </>;
}

export function Workspace({ id }: { id: string }) {
  const [resources, setResources] = useState<Resources>();
  const [connection, setConnection] = useState<Connection>('connecting');
  const [people, setPeople] = useState<Person[]>([]);
  const [title, setTitle] = useState('Document');
  const [warning, setWarning] = useState('');
  const [missing, setMissing] = useState(false);
  const [localReady, setLocalReady] = useState(false);
  const [localWarning, setLocalWarning] = useState(false);
  const [name, setName] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  useEffect(() => {
    const request = new AbortController();
    fetch(`/api/documents/${id}`, { signal: request.signal }).then(async (response) => {
      if (response.status === 404) { setMissing(true); return; }
      if (!response.ok) throw new Error('Could not load the document title.');
      const doc: unknown = await response.json();
      if (!isDocumentSummary(doc)) throw new Error('Received invalid document details.');
      setTitle(doc.title);
    }).catch((err) => {
      if (!request.signal.aborted) setWarning(err instanceof Error ? err.message : 'Document details unavailable.');
    });
    return () => request.abort();
  }, [id]);

  useEffect(() => {
    if (missing) return;
    const guest = getGuest();
    const doc = new Y.Doc();
    let active = true;
    const url = process.env.NEXT_PUBLIC_WS_URL ?? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
    const provider = new WebsocketProvider(url, id, doc, { connect: false, disableBc: true });
    provider.awareness.setLocalStateField('user', guest);
    const fallback = setTimeout(() => { if (active) setLocalWarning(true); }, 2000);
    if (typeof indexedDB !== 'undefined') {
      const cache = new IndexeddbPersistence(`mergepad:${id}`, doc);
      void cache.whenSynced.then(() => {
        if (active) { clearTimeout(fallback); setLocalReady(true); setLocalWarning(false); }
      });
    } else {
      clearTimeout(fallback);
      setLocalWarning(true);
    }
    const updatePeople = () => setPeople([...provider.awareness.getStates()].flatMap(([clientId, state]) => {
      if (typeof state.user?.name !== 'string' || typeof state.user?.color !== 'string') return [];
      return [{ id: clientId, name: state.user.name, color: state.user.color }];
    }));
    provider.awareness.on('change', updatePeople);
    provider.on('status', ({ status }: { status: string }) => {
      setConnection(status === 'connected' ? 'syncing' : status === 'connecting' && navigator.onLine ? 'connecting' : 'offline');
      if (status === 'connected') {
        const state = provider.awareness.getLocalState();
        if (state) provider.awareness.setLocalState(state);
      }
    });
    provider.on('sync', (synced: boolean) => { if (synced) setConnection('live'); });
    provider.on('connection-close', (event: CloseEvent | null) => {
      if (event?.code === 1009) setWarning('The room reached its size limit. New edits may only be available in this browser.');
    });
    const onOffline = () => { provider.disconnect(); setConnection('offline'); };
    const onOnline = () => provider.connect();
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    setResources({ doc, provider, guest });
    setName(guest.name);
    updatePeople();
    if (navigator.onLine) provider.connect();
    else setConnection('offline');
    return () => {
      active = false;
      clearTimeout(fallback);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      provider.awareness.off('change', updatePeople);
      provider.destroy();
      doc.destroy();
    };
  }, [id, missing]);

  function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !resources) return;
    resources.provider.awareness.setLocalStateField('user', { ...resources.guest, name: trimmed });
    try { sessionStorage.setItem('mergepad:guest', trimmed); } catch { /* Use the name for this session only. */ }
    setName(trimmed);
  }

  async function share() {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }

  const status = { connecting: 'Connecting', offline: 'Offline', syncing: 'Syncing', live: 'Live' }[connection];
  const visiblePeople = connection === 'live' || connection === 'syncing' ? people : [];

  return <div className="site editor-site">
    <header className="mast"><div className="container mast-inner">
      <Brand /><div className="mast-actions"><span className={`status ${connection}`} role="status"><span className="dot" /> {status}</span>
        <button className="button primary" onClick={() => void share()} disabled={missing}>{copied ? <Check size={17} /> : <Link2 size={17} />}{copied ? 'Copied' : 'Copy link'}</button></div>
    </div></header>
    <main className="container editor-layout">
      <div className="editor-main">
        <Link className="back" href="/"><ArrowLeft size={16} /> All documents</Link>
        <h1>{missing ? 'Document not found' : title}</h1>
        {copyError && <p className="notice" role="status">Clipboard unavailable. Share the URL from your address bar.</p>}
        {!missing && <>
          {warning && <p className="notice" role="status">{warning}</p>}
          {localWarning && <p className="notice" role="status">Browser storage is not ready. Keep this tab open to retain unsynced edits.</p>}
          {connection === 'offline' && <p className="notice" role="status">You can keep editing. Changes merge when you reconnect.</p>}
          {resources ? <RichText {...resources} /> : <div className="paper" role="status">Opening document&hellip;</div>}
          <p className="editor-caption"><span className={`dot ${localReady ? 'enabled' : ''}`} /> {localReady ? 'Browser storage ready' : 'Checking browser storage'}</p>
        </>}
      </div>
      {!missing && <aside className="presence-card">
        <h2><Users size={19} /> In this document</h2>
        <p className="presence-count">{visiblePeople.length} online</p>
        <ul className="people">{visiblePeople.map((person) => <li key={person.id}>
          <span style={{ backgroundColor: person.color }} className="avatar">{person.name.slice(0, 1).toUpperCase()}</span>
          <strong>{person.name}</strong>{person.id === resources?.doc.clientID && <small>You</small>}
        </li>)}</ul>
        {!visiblePeople.length && <p className="muted">Presence appears when you connect.</p>}
        <form className="guest-form" onSubmit={rename}>
          <label htmlFor="guest">Your display name</label>
          <input id="guest" value={name} onChange={(event) => setName(event.target.value)} maxLength={maxGuestNameLength} required />
          <button type="submit" className="button secondary" disabled={!resources || !name.trim()}>Update name</button>
        </form>
        <p className="presence-foot">Anyone with access to this workspace can edit.</p>
      </aside>}
    </main>
  </div>;
}
