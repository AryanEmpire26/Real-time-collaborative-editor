'use client';

import { isDocumentSummary, maxTitleLength, type DocumentSummary } from '@mergepad/shared';
import { ArrowDownRight, ArrowUpRight, CircleAlert, FileText, Layers3, Plus, Radio, WifiOff } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useRef, useState } from 'react';

export function Brand() {
  return <Link href="/" className="brand"><span className="brand-mark"><Layers3 size={19} /></span>Merge<span>Pad</span></Link>;
}

export function Library() {
  const router = useRouter();
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [listError, setListError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [revision, retry] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const request = new AbortController();
    fetch('/api/documents', { signal: request.signal }).then(async (response) => {
      if (!response.ok) throw new Error('Could not load documents. Check your connection and try again.');
      const data: unknown = await response.json();
      if (!Array.isArray(data) || !data.every(isDocumentSummary)) throw new Error('Received an invalid document list.');
      setDocuments(data);
    }).catch((failure) => {
      if (!request.signal.aborted) setListError(failure instanceof Error ? failure.message : 'Could not load documents.');
    });
    return () => request.abort();
  }, [revision]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !title.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/documents', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
      });
      if (!response.ok) throw new Error('Could not create the document. Check your connection and try again.');
      const doc: unknown = await response.json();
      if (!isDocumentSummary(doc)) throw new Error('Received an invalid document response.');
      router.push(`/doc/${doc.id}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not create document.');
      setSubmitting(false);
    }
  }

  return (
    <div className="site">
      <header className="mast"><div className="container mast-inner">
        <Brand /><button className="button secondary" onClick={() => inputRef.current?.focus()}><Plus size={17} /> New document</button>
      </div></header>
      <main className="container library">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow"><span className="dot" /> THE COLLABORATIVE WORKSPACE</p>
            <h1>Write together.<br /><em>Keep your momentum.</em></h1>
            <p>Edit in real time, see where others are working, and keep writing when your connection drops.</p>
            <div className="feature-tags"><span><Radio size={14} /> Live collaboration</span><span><WifiOff size={14} /> Offline editing</span></div>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="art-page"><div className="art-fold" /><div className="art-heading" /><div className="art-line" /><div className="art-line short" /><div className="art-line" /></div>
            <div className="art-caret first"><ArrowDownRight size={17} /> Mia</div>
            <div className="art-caret second"><ArrowUpRight size={17} /> Ravi</div>
          </div>
        </section>

        <div className="library-grid">
          <section aria-labelledby="docs-title">
            <p className="eyebrow muted">WORKSPACE</p>
            <h2 id="docs-title">Recent documents</h2>
            {listError ? <div className="empty" role="alert"><CircleAlert size={25} /><p>{listError}</p><button className="button secondary" onClick={() => { setListError(''); retry(revision + 1); }}>Retry</button></div>
              : documents === null ? <div className="empty" role="status">Loading documents&hellip;</div>
              : !documents.length ? <div className="empty"><FileText size={28} /><strong>No documents yet</strong><p>Start with a blank page, then invite someone to write with you.</p></div>
              : <ul className="document-list">{documents.map((doc) => (
                <li key={doc.id}><Link href={`/doc/${doc.id}`}><span className="file-mark"><FileText size={19} /></span><span><strong>{doc.title}</strong><small>Edited {new Date(doc.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</small></span><ArrowUpRight className="doc-arrow" size={18} /></Link></li>
              ))}</ul>}
          </section>
          <aside className="create-card">
            <span className="file-mark"><Plus size={21} /></span>
            <h2>Start a document</h2>
            <p>Give it a title. Share the link when you&apos;re ready.</p>
            <form onSubmit={create}>
              <label htmlFor="title">Document title</label>
              <input ref={inputRef} id="title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Sprint retrospective" maxLength={maxTitleLength} required />
              <button className="button primary" disabled={!title.trim() || submitting} type="submit"><Plus size={17} />{submitting ? 'Creating…' : 'Create document'}</button>
              {error && <p className="error" role="alert">{error}</p>}
            </form>
          </aside>
        </div>
      </main>
      <footer className="container footer"><Layers3 size={15} /> MergePad <span>Built for writing together.</span></footer>
    </div>
  );
}
