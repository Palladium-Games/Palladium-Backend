# Palladium Backend

This folder is the backend runtime for Palladium Games.

What it runs:

- `apps.js` in this folder
- AI APIs
- hosted game files
- hosted game thumbnails from `backend/images/game-img`
- proxy endpoints and the Scramjet Wisp websocket transport
- Monochrome endpoint configuration
- Discord bot sidecars

Discord link bot commands:

- `/link <url>` checks a URL with the existing blocker-analysis flow
- `/addlink <url>` lets admins save a reusable link into the shared pool
- `/getlink` gives members one random saved link from that pool

Saved links live in the link bot state file and persist across restarts.

Run locally:

```bash
cd backend
./start.sh
```

Production target:

- point `api.sethpang.com` at this backend
- keep `backend/config/palladium.env` on the server
- host the `../frontend/` folder separately on a static platform if you want the UI split

Notes:

- `FRONTEND_DIR` is optional
- set `FRONTEND_DIR=disabled` to force backend-only mode
- if no frontend directory exists, the backend still boots and serves `/api/*`, `/games/*`, `/swf/*`, and `/images/game-img/*`
- only direct static page routes like `/` are disabled in backend-only mode

Important:

- the backend remains the source of truth for `/api/*`, `/games/*`, `/health`, and `/link-check`
- the static frontend should not contain secrets, Discord tokens, or service runtime code

Scramjet split:

- keep the frontend static and serve it from a static host
- keep the live proxy transport on this backend at `/wisp/`
- let the frontend read `/api/config/public` and `/api/proxy/health`
- point production traffic at `https://api.sethpang.com`
