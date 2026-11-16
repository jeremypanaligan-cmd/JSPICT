#!/usr/bin/env python3
"""
JSP Extender Control — local bridge agent.

Runs on the Windows PC that can reach the Tapo plugs and gives the PWA a tiny
loopback API so the bridge worker can be started from the app:

    GET  /status   -> {"ok": true, "running": bool, "pid": int, "log_tail": [..]}
    POST /start    -> start worker.py detached (stdout/stderr -> worker/worker.log)
    POST /stop     -> stop the worker process
    POST /restart  -> stop + start

Only 127.0.0.1 is bound, and POSTs are refused unless the browser Origin is
allow-listed (BRIDGE_AGENT_ORIGINS, comma separated; defaults to the GitHub
Pages site), so other websites cannot drive your plugs.

Usage:
    .venv\\Scripts\\pythonw.exe bridge_agent.py     (or start-agent.bat)
    BRIDGE_AGENT_PORT=8765                        (optional, default 8765)
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
WORKER = HERE / "worker.py"
PID_FILE = HERE / ".worker.pid"
WORKER_LOG = HERE / "worker.log"
AGENT_LOG = HERE / "agent.log"

HOST = "127.0.0.1"
PORT = int(os.getenv("BRIDGE_AGENT_PORT", "8765"))

DEFAULT_ORIGINS = "https://jeremypanaligan-cmd.github.io"
ALLOWED_ORIGINS = {
    origin.strip().rstrip("/")
    for origin in (os.getenv("BRIDGE_AGENT_ORIGINS") or DEFAULT_ORIGINS).split(",")
    if origin.strip()
}

log = logging.getLogger("bridge-agent")


# --------------------------------------------------------------------------
# Worker process control
# --------------------------------------------------------------------------
def python_executable() -> Path:
    for candidate in (
        HERE / ".venv" / "Scripts" / "python.exe",
        HERE / ".venv" / "bin" / "python",
    ):
        if candidate.exists():
            return candidate
    return Path(sys.executable)


def read_pid() -> int:
    try:
        return int(PID_FILE.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return 0


def is_running(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes

        process_query_limited_information = 0x1000
        still_active = 259
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return False
            return code.value == still_active
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def log_tail(lines: int = 8) -> list[str]:
    try:
        content = WORKER_LOG.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    return [line for line in content[-lines:] if line.strip()]


def status() -> dict:
    pid = read_pid()
    running = is_running(pid)
    return {"ok": True, "running": running, "pid": pid if running else 0, "log_tail": log_tail()}


def start() -> dict:
    pid = read_pid()
    if is_running(pid):
        return {"ok": True, "running": True, "pid": pid, "already": True}

    if not WORKER.exists():
        raise RuntimeError("worker.py is missing next to bridge_agent.py")

    WORKER_LOG.parent.mkdir(parents=True, exist_ok=True)
    with WORKER_LOG.open("a", encoding="utf-8") as handle:
        handle.write(f"\n--- worker started by bridge agent at {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n")
        handle.flush()
        flags = 0
        if os.name == "nt":
            flags = getattr(subprocess, "DETACHED_PROCESS", 0x00000008) | getattr(
                subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200
            )
        proc = subprocess.Popen(  # noqa: S603 - fixed command, local only
            [str(python_executable()), "-u", str(WORKER)],
            cwd=str(HERE),
            stdout=handle,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            creationflags=flags,
        )

    PID_FILE.write_text(str(proc.pid), encoding="utf-8")
    time.sleep(2.0)

    if proc.poll() is not None:
        PID_FILE.unlink(missing_ok=True)
        tail = "\n".join(log_tail(6))
        raise RuntimeError(f"worker.py exited immediately (code {proc.returncode}).\n{tail}")

    log.info("Started worker pid=%s", proc.pid)
    return {"ok": True, "running": True, "pid": proc.pid, "already": False}


def stop() -> dict:
    pid = read_pid()
    if not is_running(pid):
        PID_FILE.unlink(missing_ok=True)
        return {"ok": True, "running": False, "pid": 0, "already": True}

    if os.name == "nt":
        subprocess.run(  # noqa: S603 - pid comes from our own pid file
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            capture_output=True,
            check=False,
        )
    else:
        os.kill(pid, 15)

    time.sleep(1.0)
    PID_FILE.unlink(missing_ok=True)
    log.info("Stopped worker pid=%s", pid)
    return {"ok": True, "running": is_running(pid), "pid": 0}


def restart() -> dict:
    stop()
    result = start()
    result["restarted"] = True
    return result


# --------------------------------------------------------------------------
# HTTP plumbing
# --------------------------------------------------------------------------
def origin_allowed(origin: str) -> bool:
    if not origin:
        return False
    normalized = origin.rstrip("/")
    if normalized in ALLOWED_ORIGINS:
        return True
    # Local development of the PWA (python -m http.server, live server, ...).
    return normalized.startswith("http://localhost") or normalized.startswith("http://127.0.0.1")


class Handler(BaseHTTPRequestHandler):
    server_version = "JSPBridgeAgent/1.0"

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin", "")
        if origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self.send_response(204)
        origin = self.headers.get("Origin", "")
        if origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if urlparse(self.path).path != "/status":
            self._send(404, {"ok": False, "error": "Unknown endpoint."})
            return
        self._send(200, status())

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if not origin_allowed(self.headers.get("Origin", "")):
            self._send(403, {"ok": False, "error": "Origin not allowed."})
            return

        actions = {"/start": start, "/stop": stop, "/restart": restart}
        action = actions.get(urlparse(self.path).path)
        if not action:
            self._send(404, {"ok": False, "error": "Unknown endpoint."})
            return

        try:
            self._send(200, action())
        except Exception as exc:  # noqa: BLE001 - report to the app, keep serving
            log.exception("Action %s failed", self.path)
            self._send(500, {"ok": False, "error": str(exc)})

    def log_message(self, fmt: str, *args) -> None:
        log.info("%s - %s", self.address_string(), fmt % args)


def main() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s | %(levelname)-7s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=[logging.FileHandler(AGENT_LOG, encoding="utf-8"), logging.StreamHandler()],
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    log.info("Bridge agent listening on http://%s:%s", HOST, PORT)
    log.info("Allowed origins: %s", ", ".join(sorted(ALLOWED_ORIGINS)) or "(none)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Bridge agent stopped")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
