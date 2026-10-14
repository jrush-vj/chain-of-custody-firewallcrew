# Cloudflare Tunnel Setup for Chain of Custody Demo

## The Hackathon Networking Problem
In a 3-laptop setup:
- **Laptop A:** Victim platform + Agent
- **Laptop B:** Witness + Dashboards
- **Laptop C:** Feed + Red Team Scripts

Connecting over venue Wi-Fi or phone hotspots often fails due to:
- Client isolation (laptops cannot reach each other's local IPs)
- Firewall blocks on non-standard ports (e.g. 8000, 8001)
- Dynamic IP address changes when phones reconnect

## The Solution: Cloudflare Tunnel (`cloudflared`)

### Option 1: Zero-Config "Quick Tunnel" (Recommended for Hackathon Demo)
No domain or Cloudflare account required! Cloudflare provides a free ephemeral HTTPS URL with a trusted certificate:

```cmd
# 1. Download cloudflared:
winget install Cloudflare.cloudflared

# 2. Run a Quick Tunnel exposing the Witness on Laptop B:
cloudflared tunnel --url http://localhost:8000
```

Cloudflare outputs a public URL like:
`https://random-words-1234.trycloudflare.com`

- Laptop A sets: `WITNESS_URL = "https://random-words-1234.trycloudflare.com"`
- Laptop C sets: `WITNESS_URL = "https://random-words-1234.trycloudflare.com"`
- Judges open the same URL on their phones to view the Auditor and SOC tabs!

---

### Option 2: Named Tunnel (Custom Domain)
If you have a domain connected to Cloudflare:

1. Authenticate:
   ```cmd
   cloudflared tunnel login
   ```
2. Create tunnel:
   ```cmd
   cloudflared tunnel create coc-witness
   ```
3. Map domains in `config.yml`:
   ```yaml
   tunnel: <TUNNEL_ID>
   credentials-file: ~/.cloudflared/<TUNNEL_ID>.json

   ingress:
     - hostname: witness.yourdomain.com
       service: http://localhost:8000
     - hostname: soc.yourdomain.com
       service: http://localhost:8000/soc
     - hostname: auditor.yourdomain.com
       service: http://localhost:8000/auditor
     - service: http_status:404
   ```
4. Route DNS and run:
   ```cmd
   cloudflared tunnel route dns coc-witness witness.yourdomain.com
   cloudflared tunnel run coc-witness
   ```
