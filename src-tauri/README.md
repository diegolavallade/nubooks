# Nubooks desktop storage

The frontend calls `src/storage.ts`. Inside Tauri it invokes the commands in
`src/lib.rs`; in the browser preview the same API uses IndexedDB. EPUB and cover
bytes are therefore never kept only in React state or `localStorage`.

The native store is under Tauri's **app data directory**, not next to the
installed executable (which may be read-only):

```text
<app-data>/
  library.json          profile, books, per-book settings/progress/bookmarks,
                        collections and reading history
  library.json.bak      previous complete metadata snapshot
  books/<sha256>.epub
  covers/<sha256>-<uuid>.cover
```

EPUB IDs are SHA-256 hashes of their bytes, so importing the same file again
keeps its settings, progress and collection membership. All public file
operations accept IDs rather than arbitrary paths. Export opens a native Save
As dialog in Rust. Metadata writes use a temporary file, a backup and a
recoverable rename sequence for Windows. Book/cover deletion uses explicit
`*.pending-delete` staging; unreferenced complete binaries are never deleted
just because an old metadata backup was restored.

To run desktop locally, install the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/)
(Rust and MSVC/Windows SDK), then run `pnpm desktop:dev`. It attaches to Vite
on port 8443 if already running, or starts Vite itself. Use
`pnpm desktop:build` for a distributable binary. `pnpm dev` alone starts the
browser preview and exercises the IndexedDB adapter.

The browser adapter has an automated isolated-profile check:
`node scripts/storage-smoke.mjs` (requires Edge and the Vite server on port
8443). It covers binary import/read, persistent cover, settings, progress,
profile, collections and deletion across a page reload. Native commands still
require a real Tauri build and smoke test on a machine with Rust/MSVC installed.
