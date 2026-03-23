# Antarctic Backend

This folder is the live backend runtime for Antarctic Games.

What it owns:

- `apps.js` in this folder
- Discord bot sidecars and Discord-facing APIs
- AI chat APIs backed by Ollama
- Scramjet proxy APIs plus the Wisp websocket transport
- Supabase-backed account auth, public/private chat rooms, room invite notifications, DM requests/acceptance, live DMs, automod mutes, and cloud-save APIs
- link-check analysis used by the Discord tooling
- proxy-runtime sync tooling for the separate static frontend
- optional static passthrough for a separate frontend checkout via `FRONTEND_STATIC_DIR`

What it no longer owns:

- frontend source files inside this backend repo
- hosted games
- hosted SWF launchers
- backend-hosted game thumbnails
- Monochrome service files

Run locally:

```bash
cd palladium-backend
./start.sh
```

`./start.sh` will create `config/palladium.env` from the example file on first run and bootstrap runtime dependencies with `npm ci --omit=dev` if `node_modules` is missing or incomplete.

If you want the backend to serve the separately checked-out frontend from the same site, set `FRONTEND_STATIC_DIR` in `config/palladium.env`. Leave it blank to expose only backend routes.

For community accounts/chat/cloud saves, production should use:

- `ACCOUNT_PROVIDER=supabase`
- `SUPABASE_DB_URL=postgresql://...`

Supabase connection strings should normally keep `?sslmode=require`. The backend now translates that into the Node `pg` TLS settings Supabase expects. Only use `sslmode=verify-full` when the machine trusts the full CA chain for the database host.

`ACCOUNT_PROVIDER=auto` keeps SQLite as the local fallback when `SUPABASE_DB_URL` is blank, which is useful for tests and temporary local runs.

If you already have live SQLite accounts/chat/save data, migrate it into Supabase with:

```bash
npm run migrate:supabase
```

You can override the defaults with `--config`, `--sqlite`, `--supabase`, or keep the target intact with `--no-reset-target`, but the normal production move is to let the script reset the Supabase tables and copy the full SQLite dataset over exactly once.

Proxy runtime maintenance:

- `npm run sync:frontend-proxy` copies the installed Scramjet, BareMux, and libcurl runtime files into the sibling frontend checkout.
- `npm run refresh:frontend-proxy` first removes the vendored frontend proxy-runtime folders, then recopies those assets fresh.
- `npm run reinstall:frontend-proxy` removes the installed MercuryWorkshop proxy packages from the backend, redownloads them with `npm install --no-save`, then wipes and recopies the frontend runtime folders.
- frontend discovery for those commands now supports sibling checkouts named `Antarctic-Games`, `Antarctic-Frontend`, `palladium-frontend`, or `frontend`
- `npm run verify` now checks that the vendored frontend proxy runtime still matches the backend package sources whenever a sibling frontend checkout exists.

Production target:

- point `api.antarctic.games` at this backend
- keep `config/palladium.env` on the server
- or serve the separate frontend checkout from the same site with `FRONTEND_STATIC_DIR`

Important routes:

- `GET /health`
- `GET /api/config/public`
- `GET /api/proxy/health`
- `GET /api/proxy/fetch?url=...`
- `POST /api/proxy/request?url=...`
- `POST /api/ai/chat`
- `GET /api/account/session`
- `GET /api/community/bootstrap`
- `POST /api/account/signup`
- `POST /api/account/login`
- `GET /api/chat/threads`
- `POST /api/chat/rooms`
- `POST /api/chat/dms`
- `POST /api/chat/dms/:id/accept`
- `POST /api/chat/dms/:id/deny`
- `POST /api/chat/threads/:id/leave`
- `GET /api/saves`
- `GET /api/discord/widget`
- `GET /link-check?url=...`
- websocket upgrades on `/wisp/`

Auth bootstrap behavior:

- `GET /api/account/session`, `POST /api/account/signup`, `POST /api/account/login`, and `GET /api/community/bootstrap` all return the authenticated user plus the same `bootstrap` payload.
- `bootstrap` includes joined threads, room catalog membership state, incoming DM requests, cloud saves, and aggregate stats so the frontend can paint the logged-in account/chat UI in one round trip.
- room creation accepts `visibility` (`public` or `private`) and `invitedUsers`; private-room invites become Antarctic system DMs and only invited users can join those rooms.
- `POST /api/chat/dms` creates a pending DM request unless a direct thread already exists or the other user already requested you, in which case the request is resolved into the shared thread immediately.
- chat messages stay capped at 2000 characters, and the built-in automod applies a short mute when blocked profanity is sent.
- AI chat requests are normalized for low-latency shell responses by default, with shorter context/prediction limits and long-lived Ollama keep-alive reuse.
- The static frontend prefers Wisp for Scramjet, but can fall back to `POST /api/proxy/request` when a reverse proxy is not forwarding `/wisp/` websocket upgrades correctly.
- when `FRONTEND_STATIC_DIR` is serving the frontend shell, `/service/scramjet/...` falls back to the shell instead of 404ing, so the proxy bootstrap survives encoded target URLs with dots in them.

Docs:

- user guide: [docs/user-guide.md](docs/user-guide.md)
- agent guide: [docs/agent-guide.md](docs/agent-guide.md)
