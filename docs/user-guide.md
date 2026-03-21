# User Guide

This backend is the API side of Antarctic Games. It is meant to run behind `api.sethpang.com` while the website itself is hosted statically elsewhere.

Daily use:

1. Update `config/palladium.env` with your host, port, Ollama settings, Discord tokens, and any proxy base override.
2. If you want one site to serve both API routes and the static frontend, set `FRONTEND_STATIC_DIR` to the separate frontend checkout, for example `/opt/Antarctic-Frontend` or `../Antarctic-Frontend`.
3. Start the service with `./start.sh` or `npm start`.
4. If you prefer doing the install step manually, run `npm ci --omit=dev` before starting.
5. Verify the runtime with `GET /health` and `GET /api/proxy/health`.

Supported backend features:

- Discord widget aggregation and Discord bot sidecars
- AI chat requests through Ollama at `POST /api/ai/chat`
- Scramjet proxy metadata and fetch endpoints
- Wisp websocket transport at `/wisp/`
- URL/link analysis for Discord flows at `/link-check`
- optional static frontend passthrough from `FRONTEND_STATIC_DIR`

Not supported here anymore:

- keeping frontend source files inside the backend repo
- serving games or SWF files
- serving game thumbnails

Before deploying:

1. Run `npm run verify`.
2. Confirm `/api/config/public` returns the expected proxy, AI, and Discord settings.
3. If `FRONTEND_STATIC_DIR` is set, confirm `/` serves the frontend shell and asset paths resolve from that checkout.
4. If `FRONTEND_STATIC_DIR` is blank, confirm the static frontend is pointed at this backend base URL.
