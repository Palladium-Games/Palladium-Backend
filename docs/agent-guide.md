# Agent Guide

Scope:

- Keep this backend focused on Discord, AI, proxy, and link-check responsibilities.
- Do not reintroduce in-repo frontend hosting, game hosting, thumbnail hosting, or Monochrome coupling here.
- Optional frontend serving is allowed only as a passthrough to a separate frontend checkout configured with `FRONTEND_STATIC_DIR`.

When changing the backend:

1. Update `apps.js`, tests, and docs together so the public contract stays explicit.
2. Keep `/api/config/public` aligned with what the static frontend actually consumes.
3. Prefer compatibility-preserving changes for existing env vars unless the user explicitly asks for breaking renames.
4. Keep `./start.sh` first-boot safe on clean machines, including dependency bootstrap behavior.
5. End every task with `npm run verify`.

Regression expectations:

- `/health` advertises only the live backend features.
- `/api/config/public` exposes proxy, AI, and Discord metadata without legacy games/assets fields.
- backend-only mode leaves `/` unserved when `FRONTEND_STATIC_DIR` is blank.
- configured frontend passthrough can serve the separate static frontend shell and assets.
- legacy backend-hosted game and image routes remain absent.
