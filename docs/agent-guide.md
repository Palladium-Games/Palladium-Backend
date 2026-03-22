# Agent Guide

Scope:

- Keep this backend focused on Discord, AI, proxy, community accounts/chat/cloud-saves, and link-check responsibilities.
- Do not reintroduce in-repo frontend hosting, game hosting, thumbnail hosting, or Monochrome coupling here.
- Optional frontend serving is allowed only as a passthrough to a separate frontend checkout configured with `FRONTEND_STATIC_DIR`.

When changing the backend:

1. Update `apps.js`, tests, and docs together so the public contract stays explicit.
2. Keep `/api/config/public` aligned with what the static frontend actually consumes, including account/chat/save endpoints.
3. Keep the proxy contract aligned across `/api/config/public`, `/api/proxy/fetch`, `/api/proxy/request`, and `/wisp/` so the frontend can fall back gracefully when websocket upgrades are unavailable.
4. Keep auth endpoints and `/api/community/bootstrap` aligned so the frontend can bootstrap logged-in account/chat UI from one payload.
5. Preserve the Supabase/Postgres community schema contract and tests together whenever auth, public/private room rules, room invites, DM request flow, automod mutes, or save behavior changes.
   If a migration path changes, update `scripts/migrate-community-to-supabase.js`, `services/community-migration.js`, and the migration tests in the same patch.
6. Keep AI defaults biased toward fast interactive shell replies unless the user explicitly asks for slower/deeper reasoning.
7. Prefer compatibility-preserving changes for existing env vars unless the user explicitly asks for breaking renames.
8. Keep `./start.sh` first-boot safe on clean machines, including dependency bootstrap behavior.
9. End every task with `npm run verify`.

Regression expectations:

- `/health` advertises the live backend features, including account/chat/save routes.
- `/api/config/public` exposes proxy, AI, Discord, and community metadata without legacy games/assets fields, including `/api/community/bootstrap`.
- the proxy surface stays usable when `/wisp/` is broken upstream by exposing `/api/proxy/request` as the HTTP fallback transport.
- the frontend passthrough also needs to serve `/service/scramjet/...` through the shell fallback so encoded proxy URLs never 404 on the host.
- backend-only mode leaves `/` unserved when `FRONTEND_STATIC_DIR` is blank.
- configured frontend passthrough can serve the separate static frontend shell and assets.
- legacy backend-hosted game and image routes remain absent.
- Supabase/Postgres-backed auth, bootstrap, public/private room access, room invite notifications, DM requests/acceptance, direct-message threads, automod mutes, save APIs, and SQLite-to-Supabase migration stay covered by direct tests.
