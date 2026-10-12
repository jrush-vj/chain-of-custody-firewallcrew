# Hacker Agent

This folder contains the Sentinel operator console:

- `agent_server.py` is the stateful Flask API. Run it on a trusted operator
  machine or a locked-down admin host, not as a Vercel serverless function.
- `static/index.html` is the browser console and can be deployed to Vercel.
- `requirements.txt` contains the API runtime dependencies.
- `vercel.json` keeps the static console deployable as a Vercel project.

## Run the API

```bash
cd hacker-agent
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python agent_server.py
```

The API listens on `127.0.0.1:5000` by default. Put it behind an authenticated
reverse proxy if it must be reachable from the Vercel console. The browser
console accepts an optional `window.SENTINEL_API_BASE_URL` value before its
script runs, for example:

```html
<script>
  window.SENTINEL_API_BASE_URL = "https://agent-api.example.com";
</script>
```

Set `AGENT_CORS_ORIGINS=https://your-console.vercel.app` on the API host. CORS is
disabled unless this variable is explicitly configured.

Never expose this API directly to the public internet. It can execute commands
over SSH by design. Keep the approval mode enabled and use a dedicated,
non-root VPS account for demonstrations.

## Deploy the console to Vercel

Create a Vercel project whose root directory is this folder. Vercel serves the
static console; it does not run the Flask API or the Chain of Custody witness.
The witness must remain on a separate trusted host with durable storage.
