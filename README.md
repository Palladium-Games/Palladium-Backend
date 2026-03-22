# Antarctic Backend

This folder is the live backend runtime for Antarctic Games.

What it owns:

- `apps.js` in this folder
- Discord bot sidecars and Discord-facing APIs
- AI chat APIs backed by Ollama
- Scramjet proxy APIs plus the Wisp websocket transport
- SQLite-backed account auth, chat rooms, DMs, and cloud-save APIs
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

Production target:

- point `api.sethpang.com` at this backend
- keep `config/palladium.env` on the server
- host the frontend from a static platform separately

Important routes:

- `GET /health`
- `GET /api/config/public`
- `GET /api/proxy/health`
- `GET /api/proxy/fetch?url=...`
- `POST /api/ai/chat`
- `GET /api/account/session`
- `POST /api/account/signup`
- `POST /api/account/login`
- `GET /api/chat/threads`
- `POST /api/chat/rooms`
- `POST /api/chat/dms`
- `GET /api/saves`
- `GET /api/discord/widget`
- `GET /link-check?url=...`
- websocket upgrades on `/wisp/`

Docs:

- user guide: [docs/user-guide.md](docs/user-guide.md)
- agent guide: [docs/agent-guide.md](docs/agent-guide.md)
