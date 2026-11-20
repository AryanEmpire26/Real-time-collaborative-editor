# MergePad | Resume bullets

- Built an offline-capable collaborative rich-text editor using Next.js, Tiptap, TypeScript, and Yjs, with live cursors, selections, presence, and shareable documents.
- Implemented Redis pub/sub across two load-balanced WebSocket replicas so users on different instances could edit the same document without sticky sessions.
- Persisted batched CRDT updates in PostgreSQL under row-level locks; used IndexedDB and state-vector reconciliation to recover unsent edits after a browser tab closed.
- Added a reproducible Podman environment, readiness checks, Prometheus metrics, and GitHub Actions coverage for protocol behavior, cross-instance convergence, and browser-level offline recovery.
