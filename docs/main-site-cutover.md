# Main-Site Cutover

This runbook moves `antarctic.games`, `www.antarctic.games`, and `api.antarctic.games` onto the backend-served frontend passthrough. nginx should only terminate TLS and reverse proxy traffic to the backend after this cutover.

Target layout:

- backend checkout: `/opt/Antarctic-Backend`
- frontend checkout: `/opt/Antarctic-Games`
- backend env file: `/opt/Antarctic-Backend/config/palladium.env`

Required backend config:

1. Set `FRONTEND_STATIC_DIR=/opt/Antarctic-Games`.
2. Run `npm run verify` in `/opt/Antarctic-Backend`.
3. If the frontend proxy runtime drifted, run `npm run refresh:frontend-proxy`.
4. If the backend MercuryWorkshop runtime itself is damaged, run `npm run reinstall:frontend-proxy`.

Managed startup:

1. Copy `deploy/antarctic-backend.service` to `/etc/systemd/system/antarctic-backend.service`.
2. Run `systemctl daemon-reload`.
3. If a manual `node apps.js` still owns port `8080`, stop it before starting the service.
4. Run `systemctl enable --now antarctic-backend`.

nginx cutover:

1. Back up the current nginx site file before replacing it.
2. Copy `deploy/nginx/antarctic.games.conf` into the live nginx site config path.
3. Run `nginx -t`.
4. If a manual nginx master process still owns ports `80` or `443`, stop it before starting or restarting the systemd-managed nginx service.
5. Run `systemctl enable --now nginx`.

Verification:

- `curl -I https://antarctic.games/`
- `curl https://antarctic.games/api/config/public`
- `curl https://antarctic.games/api/proxy/health`
- confirm `/api/config/public` advertises `proxyMode=http-fallback`, `proxyTransport=http-fallback`, and `wss://antarctic.games/wisp/`
- confirm `/service/scramjet/...` falls back to the shell instead of returning `404`
- confirm `systemctl status antarctic-backend nginx`

Rollback:

1. Restore the previous nginx site file.
2. If you need to return to static-host mode, blank `FRONTEND_STATIC_DIR` and restart the backend.
3. Run `systemctl restart antarctic-backend nginx`.
