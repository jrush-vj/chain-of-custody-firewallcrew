# Networking and Routing

## Public routes

The project uses Cloudflare Tunnel instead of exposing application ports
directly to the Internet.

| Hostname | Tunnel location | Local service | Purpose |
|---|---|---|---|
| `bank.jrushvj.dev` | Homelab | `http://127.0.0.1:3001` | Banking frontend |
| `witness.jrushvj.dev` | Oracle VPS | `http://127.0.0.1:8800` | Witness dashboard and API |

Cloudflare provides public HTTPS. The origin services remain bound to loopback.

## Banking request path

```text
Browser
  → https://bank.jrushvj.dev
  → Cloudflare edge
  → homelab cloudflared
  → 127.0.0.1:3001
  → banking-frontend:80
  → /api/* proxied to backend:8080
  → PostgreSQL:5432
```

The frontend Nginx configuration routes:

```text
/api/       → http://backend:8080
/api-docs/  → http://backend:8080
/           → frontend static files
```

The browser does not need to know the backend's private host port. Keeping
`FRONTEND_PUBLIC_API_URL` empty makes the frontend use same-origin `/api`
requests.

## Witness request path

```text
Sidecar on homelab
  → HTTPS POST https://witness.jrushvj.dev/heartbeat
  → Cloudflare edge
  → Oracle cloudflared
  → 127.0.0.1:8800
  → FastAPI witness
  → /var/lib/coc-witness/witness.db
```

The dashboard browser requests read-only endpoints through the same hostname:

```text
GET /heartbeats?node_id=node-1
GET /checkpoints?node_id=node-1
GET /alerts?node_id=node-1
```

The dashboard polls every five seconds. It does not write to the witness.

## Private ports

| Port | Bind address | Service | Public? |
|---:|---|---|---|
| 3001 | `127.0.0.1` | Banking frontend | Through Cloudflare only |
| 8081 | `127.0.0.1` | Banking backend | No |
| 5432 | `127.0.0.1` | PostgreSQL | No |
| 8800 | `127.0.0.1` | Witness API | Through Cloudflare only |

Existing homelab services may occupy `3000` or `8080`; those are why the
banking stack uses host ports `3001` and `8081`. Docker container ports remain
80 and 8080 internally.

## DNS

Cloudflare Tunnel creates proxied CNAME records to tunnel hostnames. Do not
create public `A` or `AAAA` records pointing to the homelab or Oracle IP for
these application hostnames.

Typical route commands:

```bash
cloudflared tunnel route dns banking-tunnel bank.jrushvj.dev
cloudflared tunnel route dns witness-tunnel witness.jrushvj.dev
```

## Security rules

- Do not expose PostgreSQL to the Internet.
- Do not expose the backend host port directly.
- Do not expose the witness port directly.
- Do not route the public banking hostname to Open WebUI or llama-server.
- Keep tunnel credential JSON files owner-readable only.
- Use HTTPS witness URLs in the sidecar configuration.

## Troubleshooting route failures

Check the local origin first:

```bash
curl -I http://127.0.0.1:3001
curl -I http://127.0.0.1:8800/docs
```

Then inspect tunnel logs:

```bash
sudo journalctl -u cloudflared -n 100 --no-pager
```

A Cloudflare `502` generally means the tunnel is connected but the local
origin is not listening, is mapped to the wrong port, or is blocked by a
local service configuration.
