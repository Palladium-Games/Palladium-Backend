# User Guide

This backend is the API side of Antarctic Games. It is meant to run behind `sethpang.com`, either by directly serving the separate frontend checkout through `FRONTEND_STATIC_DIR` or by answering the `/api/...` routes for a static frontend hosted elsewhere.

Daily use:

1. Update `config/palladium.env` with your host, port, Ollama settings, Discord tokens, account provider settings, and any proxy base override.
   For Supabase, set `ACCOUNT_PROVIDER=supabase` and paste the project's Postgres connection string into `SUPABASE_DB_URL`. Keep `?sslmode=require` on the URL unless you have already configured full CA trust and intentionally want `sslmode=verify-full`.
2. If you want one site to serve both API routes and the static frontend, set `FRONTEND_STATIC_DIR` to the separate frontend checkout, for example `/opt/Antarctic-Frontend` or `../Antarctic-Frontend`.
3. Start the service with `./start.sh` or `npm start`.
4. If you prefer doing the install step manually, run `npm ci --omit=dev` before starting.
5. Verify the runtime with `GET /health` and `GET /api/proxy/health`.
6. If you are moving an existing SQLite community database into Supabase, run `npm run migrate:supabase` after `SUPABASE_DB_URL` is configured. The script reads `ACCOUNT_SQLITE_PATH` and `SUPABASE_DB_URL` from `config/palladium.env` by default and resets the target Supabase tables before importing.
7. If you want to refresh the static proxy runtime shipped to the sibling frontend checkout, run `npm run refresh:frontend-proxy`. Use `npm run sync:frontend-proxy` when you only need to copy the current installed assets without wiping the frontend runtime folders first. The backend will look for sibling frontends named `Antarctic-Games`, `Antarctic-Frontend`, `palladium-frontend`, or `frontend`.
8. If you want to completely delete and redownload the MercuryWorkshop proxy runtime before resyncing the frontend, run `npm run reinstall:frontend-proxy`.

Supported backend features:

- Discord widget aggregation and Discord bot sidecars
- AI chat requests through Ollama at `POST /api/ai/chat`
- AI chat defaults are tuned for fast shell replies, so the frontend can stream shorter low-latency answers without extra per-request config
- Scramjet proxy metadata and fetch endpoints
- backend HTTP proxy fallback at `POST /api/proxy/request?url=...` for sites where `/wisp/` websocket upgrades are unavailable
- Wisp websocket transport at `/wisp/`
- frontend shell fallback for `/service/scramjet/...` when the backend is serving `FRONTEND_STATIC_DIR`
- Supabase-backed account sessions at `GET /api/account/session`, `POST /api/account/signup`, and `POST /api/account/login`
- one-call community bootstrap at `GET /api/community/bootstrap` plus auth responses that include the same bootstrap payload
- room chat + DM requests at `GET /api/chat/threads`, `POST /api/chat/rooms`, `POST /api/chat/dms`, `POST /api/chat/dms/:id/accept`, `POST /api/chat/dms/:id/deny`, and `POST /api/chat/threads/:id/leave`
- room creation supports `public` and `private` visibility; private rooms accept invite usernames, notify those users via an Antarctic system DM, and only invited users can join
- chat messages cap at 2000 characters, and the built-in automod applies a short mute when blocked profanity is sent
- cloud saves at `GET /api/saves` and `PUT /api/saves/:gameKey`
- URL/link analysis for Discord flows at `/link-check`
- optional static frontend passthrough from `FRONTEND_STATIC_DIR`

Not supported here anymore:

- keeping frontend source files inside the backend repo
- serving games or SWF files
- serving game thumbnails

Before deploying:

1. Run `npm run verify`.
2. Confirm `/api/config/public` returns the expected proxy, AI, Discord, and community endpoints.
3. If the site is fronted by nginx or another reverse proxy, confirm `/wisp/` really upgrades as a websocket. If it does not, the frontend can still browse over `POST /api/proxy/request`, but websocket-heavy sites will be limited until `/wisp/` is fixed upstream.
4. Confirm account/session, signup, login, and `/api/community/bootstrap` all return the expected authenticated bootstrap payload for the logged-in UI, including `incomingDirectRequests`.
5. If `FRONTEND_STATIC_DIR` is set, confirm `/` serves the frontend shell and asset paths resolve from that checkout.
6. Create two throwaway accounts and confirm a DM request appears in the target user's `incomingDirectRequests`, can be accepted or denied, and accepted requests become normal direct-message threads in Supabase.
7. Create a private room with invited usernames and confirm the invited user sees the room in the catalog, receives an Antarctic invite DM, and can join while an uninvited user is rejected.
8. Send a blocked profanity string in chat and confirm the message is rejected with a temporary automod mute response.
9. If `FRONTEND_STATIC_DIR` is blank, confirm the static frontend is pointed at `https://sethpang.com`.
10. If you migrated from SQLite to Supabase, log into an old account, open the community chat, verify private room invites still appear as Antarctic DMs, and confirm at least one cloud save is still present.
11. If a sibling frontend checkout exists, confirm `npm run verify` passes after any proxy-runtime package update; it now fails if the vendored frontend Scramjet/BareMux/libcurl assets drift out of sync with the backend packages.
12. If Scramjet still behaves strangely after a normal refresh, run `npm run reinstall:frontend-proxy` once so the backend deletes the installed proxy packages, redownloads them, and recopies the frontend runtime from scratch.
