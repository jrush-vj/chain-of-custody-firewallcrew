/**
 * Cloudflare Worker: Chain of Custody Public Cryptographic Notary
 *
 * Provides an external, independent anchor for chain heads.
 * Defeats Attack A10 (compromised witness attempting to rewrite history).
 */

export interface Env {
  ANCHOR_KV: KVNamespace;
  WITNESS_PUBLIC_KEY: string;
}

interface AnchorPayload {
  seq: number;
  chain_head: string;
  timestamp: string;
  signature?: string;
  key_id?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Enable CORS for dashboard and auditor queries
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Witness-Key",
      "Content-Type": "application/json"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // --- 1. POST /anchor (Anchor new chain head from Witness) ---
    if (request.method === "POST" && url.pathname === "/anchor") {
      const authHeader = request.headers.get("X-Witness-Key");
      if (env.WITNESS_PUBLIC_KEY && authHeader !== env.WITNESS_PUBLIC_KEY) {
        return new Response(JSON.stringify({ error: "Unauthorized: Invalid witness key" }), {
          status: 401,
          headers: corsHeaders
        });
      }

      try {
        const body = (await request.json()) as AnchorPayload;

        if (typeof body.seq !== "number" || !body.chain_head) {
          return new Response(
            JSON.stringify({ error: "Invalid payload: 'seq' (number) and 'chain_head' (hex string) required" }),
            { status: 400, headers: corsHeaders }
          );
        }

        // Check monotonicity
        const latestSeqStr = await env.ANCHOR_KV.get("latest_seq");
        if (latestSeqStr !== null) {
          const latestSeq = parseInt(latestSeqStr, 10);
          if (body.seq <= latestSeq) {
            return new Response(
              JSON.stringify({
                error: `Monotonicity violation: seq ${body.seq} <= latest anchored seq ${latestSeq}. Historical anchors cannot be modified or replaced.`
              }),
              { status: 400, headers: corsHeaders }
            );
          }
        }

        const anchorRecord = {
          seq: body.seq,
          chain_head: body.chain_head,
          witness_timestamp: body.timestamp,
          signature: body.signature || null,
          key_id: body.key_id || null,
          edge_anchored_at: new Date().toISOString(),
          edge_colo: request.cf?.colo || "UNKNOWN"
        };

        const recordJson = JSON.stringify(anchorRecord);
        await env.ANCHOR_KV.put(`anchor:${body.seq}`, recordJson);
        await env.ANCHOR_KV.put("latest_seq", body.seq.toString());
        await env.ANCHOR_KV.put("latest_anchor", recordJson);

        return new Response(
          JSON.stringify({
            status: "anchored",
            seq: body.seq,
            chain_head: body.chain_head,
            edge_anchored_at: anchorRecord.edge_anchored_at,
            edge_colo: anchorRecord.edge_colo
          }),
          { status: 201, headers: corsHeaders }
        );
      } catch (err: any) {
        return new Response(JSON.stringify({ error: "Failed to parse JSON body", details: err.message }), {
          status: 400,
          headers: corsHeaders
        });
      }
    }

    // --- 2. GET /anchor/latest (Query latest anchor) ---
    if (request.method === "GET" && url.pathname === "/anchor/latest") {
      const data = await env.ANCHOR_KV.get("latest_anchor");
      if (!data) {
        return new Response(JSON.stringify({ status: "empty", message: "No anchors committed yet" }), {
          status: 404,
          headers: corsHeaders
        });
      }
      return new Response(data, { headers: corsHeaders });
    }

    // --- 3. GET /anchor/:seq (Query anchor by sequence number) ---
    if (request.method === "GET" && url.pathname.startsWith("/anchor/")) {
      const seq = url.pathname.replace("/anchor/", "");
      const data = await env.ANCHOR_KV.get(`anchor:${seq}`);
      if (!data) {
        return new Response(JSON.stringify({ error: `Anchor at seq ${seq} not found` }), {
          status: 404,
          headers: corsHeaders
        });
      }
      return new Response(data, { headers: corsHeaders });
    }

    // --- 4. GET /verify?seq=...&hash=... (Verify proof against public anchor) ---
    if (request.method === "GET" && url.pathname === "/verify") {
      const seq = url.searchParams.get("seq");
      const hash = url.searchParams.get("hash");

      if (!seq || !hash) {
        return new Response(JSON.stringify({ error: "Missing query params 'seq' and 'hash'" }), {
          status: 400,
          headers: corsHeaders
        });
      }

      const dataStr = await env.ANCHOR_KV.get(`anchor:${seq}`);
      if (!dataStr) {
        return new Response(
          JSON.stringify({
            verified: false,
            reason: `Sequence ${seq} is not anchored in Cloudflare public notary.`
          }),
          { status: 404, headers: corsHeaders }
        );
      }

      const record: AnchorPayload = JSON.parse(dataStr);
      const isMatch = record.chain_head.toLowerCase() === hash.toLowerCase();

      return new Response(
        JSON.stringify({
          verified: isMatch,
          seq: parseInt(seq, 10),
          anchored_chain_head: record.chain_head,
          submitted_hash: hash,
          verdict: isMatch
            ? "VALID: Log matches external Cloudflare public notary."
            : "TAMPER DETECTED: Local chain diverges from external Cloudflare public notary (Attack A10)!"
        }),
        { headers: corsHeaders }
      );
    }

    // --- Default: Info page ---
    return new Response(
      JSON.stringify({
        project: "Chain of Custody",
        role: "External Public Notary & Anchor Service",
        endpoints: [
          "POST /anchor",
          "GET /anchor/latest",
          "GET /anchor/:seq",
          "GET /verify?seq=...&hash=..."
        ],
        documentation: "Tamper-evident external anchor for Indian banking compliance (CERT-In / RBI / PCI DSS)"
      }),
      { headers: corsHeaders }
    );
  }
};
