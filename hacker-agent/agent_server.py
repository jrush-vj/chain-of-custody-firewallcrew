#!/usr/bin/env python3
"""
CT105 Agentic SSH Console - backend

Runs on your Windows laptop. Connects over SSH to your own Proxmox
CT105 container, talks to its locally-hosted llama.cpp server for
agent decisions, and executes commands against your SentinelLog test
environment - either one at a time with your approval, or in "full
access" mode if you flip that toggle in the UI.

Setup:
    pip install flask paramiko

Run:
    python agent_server.py

Then open http://localhost:5000 in a browser.
"""

import os
import re
import json
import threading
import urllib.request

import paramiko
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="")
cors_origins = [origin.strip() for origin in os.getenv("AGENT_CORS_ORIGINS", "").split(",") if origin.strip()]
if cors_origins:
    CORS(app, origins=cors_origins, supports_credentials=True)

MAX_TOOL_ROUNDS = 5

SYSTEM_PROMPT = """You are Sentinel, an agent with SSH access to a server. 
You have exactly ONE tool:
run_command(command, reason) - proposes a bash command to run on the
remote box, with a short reason explaining why. Whether it actually runs
depends on the user's approval setting - you don't control that, just
propose clearly.

To use it, respond with ONLY a JSON object, nothing else:
{"tool": "run_command", "args": {"command": "...", "reason": "..."}}

Otherwise just reply in plain text. Never fabricate command output or
file contents - only comment on real output once it is given back to you
as a TOOL_RESULT message. Keep proposed commands minimal and specific to
what the user actually asked for.
"""

state_lock = threading.Lock()
state = {
    "ssh_client": None,
    "host": None,
    "username": None,
    "connected": False,
    "llama_url": None,
    "chat_history": [],
    "pending_command": None,   # {"command": str, "reason": str}
    "approval_mode": "approve",  # "approve" | "full"
}


# ---------------------------------------------------------------- SSH

def run_ssh_command(command, timeout=15):
    with state_lock:
        client = state["ssh_client"]
    if client is None:
        return {"ok": False, "error": "Not connected via SSH."}
    try:
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        code = stdout.channel.recv_exit_status()
        return {
            "ok": code == 0,
            "returncode": code,
            "stdout": out[:4000],
            "stderr": err[:4000],
        }
    except Exception as error:
        return {"ok": False, "error": str(error)}


# ------------------------------------------------------------- llama.cpp

def strip_think_tags(text):
    return re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()


def extract_tool_call(text):
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"```$", "", text).strip()
    match = re.search(r'\{.*"tool"\s*:\s*".+?".*\}', text, flags=re.DOTALL)
    if not match:
        return None
    try:
        obj = json.loads(match.group(0))
        return obj if "tool" in obj else None
    except Exception:
        return None


def call_llama(messages, llama_url, max_tokens=700):
    payload = {"messages": messages, "temperature": 0.3, "max_tokens": max_tokens}
    req = urllib.request.Request(
        llama_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            raw = resp.read().decode("utf-8")
        data = json.loads(raw)
        msg = (data.get("choices") or [{}])[0].get("message", {})
        content = msg.get("content") or msg.get("reasoning_content", "") or ""
        content = strip_think_tags(content)
        if not content.strip():
            return f"__ERROR__: empty response from model. raw: {raw[:500]}"
        return content
    except Exception as error:
        return f"__ERROR__: {error}"


# ----------------------------------------------------------------- API

@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/api/connect", methods=["POST"])
def connect():
    data = request.get_json(force=True)
    host = (data.get("host") or "").strip()
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    port = int(data.get("port") or 22)
    llama_url = (data.get("llama_url") or "").strip() or f"http://{host}:8080/v1/chat/completions"

    if not host or not username:
        return jsonify({"ok": False, "error": "Host and username are required."}), 400

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(hostname=host, port=port, username=username, password=password, timeout=8)
    except Exception as error:
        return jsonify({"ok": False, "error": str(error)}), 400

    with state_lock:
        if state["ssh_client"]:
            try:
                state["ssh_client"].close()
            except Exception:
                pass
        state["ssh_client"] = client
        state["host"] = host
        state["username"] = username
        state["connected"] = True
        state["llama_url"] = llama_url
        state["chat_history"] = [{"role": "system", "content": SYSTEM_PROMPT}]
        state["pending_command"] = None

    return jsonify({"ok": True, "host": host, "llama_url": llama_url})


@app.route("/api/disconnect", methods=["POST"])
def disconnect():
    with state_lock:
        if state["ssh_client"]:
            try:
                state["ssh_client"].close()
            except Exception:
                pass
        state["ssh_client"] = None
        state["connected"] = False
        state["pending_command"] = None
    return jsonify({"ok": True})


@app.route("/api/status")
def status():
    with state_lock:
        return jsonify({
            "connected": state["connected"],
            "host": state["host"],
            "approval_mode": state["approval_mode"],
            "pending_command": state["pending_command"],
        })


@app.route("/api/mode", methods=["POST"])
def set_mode():
    data = request.get_json(force=True)
    mode = data.get("mode")
    if mode not in ("approve", "full"):
        return jsonify({"ok": False, "error": "mode must be 'approve' or 'full'"}), 400
    with state_lock:
        state["approval_mode"] = mode
    return jsonify({"ok": True, "mode": mode})


@app.route("/api/terminal/exec", methods=["POST"])
def terminal_exec():
    """Direct terminal input, typed by the user themselves - always allowed,
    same as a normal terminal would be, no agent/approval involved."""
    data = request.get_json(force=True)
    command = data.get("command", "")
    return jsonify(run_ssh_command(command))


def _agent_loop(history, llama_url, approval_mode):
    """Runs model turns, executing immediately in 'full' mode or stopping
    to request approval. Returns a dict describing what happened."""
    for _ in range(MAX_TOOL_ROUNDS):
        reply = call_llama(history, llama_url)
        if reply.startswith("__ERROR__"):
            return {"ok": False, "error": reply}

        tool_call = extract_tool_call(reply)
        if not tool_call:
            history.append({"role": "assistant", "content": reply})
            return {"ok": True, "type": "message", "text": reply}

        if tool_call.get("tool") != "run_command":
            history.append({"role": "user", "content": "TOOL_RESULT: unknown tool requested"})
            continue

        args = tool_call.get("args", {}) or {}
        command = args.get("command", "")
        reason = args.get("reason", "")
        history.append({"role": "assistant", "content": json.dumps(tool_call)})

        if approval_mode == "full":
            result = run_ssh_command(command)
            history.append({"role": "user", "content": f"TOOL_RESULT: {json.dumps(result)}"})
            continue
        else:
            with state_lock:
                state["pending_command"] = {"command": command, "reason": reason}
            return {"ok": True, "type": "approval_needed", "command": command, "reason": reason}

    return {"ok": True, "type": "message", "text": "Stopped after max tool-call rounds without a final answer."}


@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.get_json(force=True)
    user_message = (data.get("message") or "").strip()
    if not user_message:
        return jsonify({"ok": False, "error": "Empty message"}), 400

    with state_lock:
        if not state["connected"]:
            return jsonify({"ok": False, "error": "Not connected via SSH."}), 400
        history = state["chat_history"]
        llama_url = state["llama_url"]
        approval_mode = state["approval_mode"]

    history.append({"role": "user", "content": user_message})
    result = _agent_loop(history, llama_url, approval_mode)
    status_code = 200 if result.get("ok") else 502
    return jsonify(result), status_code


@app.route("/api/approve", methods=["POST"])
def approve():
    data = request.get_json(force=True)
    decision = data.get("decision")  # "approve" | "deny"

    with state_lock:
        pending = state["pending_command"]
        history = state["chat_history"]
        llama_url = state["llama_url"]
        approval_mode = state["approval_mode"]
        state["pending_command"] = None

    if not pending:
        return jsonify({"ok": False, "error": "No pending command."}), 400

    if decision != "approve":
        history.append({"role": "user", "content": "TOOL_RESULT: user denied this command."})
        return jsonify({"ok": True, "type": "message", "text": "Command denied."})

    result = run_ssh_command(pending["command"])
    history.append({"role": "user", "content": f"TOOL_RESULT: {json.dumps(result)}"})

    follow_up = _agent_loop(history, llama_url, approval_mode)
    follow_up["executed"] = result
    status_code = 200 if follow_up.get("ok") else 502
    return jsonify(follow_up), status_code


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)