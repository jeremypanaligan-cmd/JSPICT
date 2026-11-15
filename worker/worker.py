#!/usr/bin/env python3
"""
JSP Extender Control — local bridge worker.

Runs on a Windows PC (or any always-on machine) on the same LAN as the
TP-Link Tapo P100 plugs, and talks to the Google Sheets backend through the
Apps Script Web App (apps-script/Code.gs).

Each cycle:
  1. Reads all extender rows from the sheet via the Web App.
  2. Expires subscriptions whose `expires_at` has passed (status -> EXPIRED,
     desired_power_state -> false).
  3. Reads each plug's real power state over the LAN.
  4. Toggles the plug when it differs from `desired_power_state`.
  5. Writes `actual_power_state` + `last_heartbeat` back in one batched call,
     so the PWA can show whether this bridge is online.

Setup:
    python -m venv .venv
    .venv\\Scripts\\activate
    pip install -r requirements.txt
    copy env.example .env       # fill in the Web App URL and WORKER_KEY
    python worker.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from tapo import ApiClient

load_dotenv(Path(__file__).with_name(".env"))

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s | %(levelname)-7s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("bridge")

REQUESTS_HEADERS = {"Content-Type": "text/plain;charset=utf-8"}
STATE_SETTLE_SECONDS = 1.0


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def require_env(name: str) -> str:
    value = (os.getenv(name) or "").strip()
    if not value:
        raise SystemExit(
            f"Missing environment variable {name}. Copy env.example to .env and fill it in."
        )
    return value


def parse_ts(value: Any) -> datetime | None:
    """Parse an ISO-8601 timestamp (with or without a trailing 'Z')."""
    if not value:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        text = str(value).strip().replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            log.warning("Could not parse timestamp: %r", value)
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return utcnow().isoformat(timespec="seconds").replace("+00:00", "Z")


def is_on(device_info: Any) -> bool:
    """Read the power flag across tapo library versions (attr or dict)."""
    value = getattr(device_info, "device_on", None)
    if value is None and hasattr(device_info, "to_dict"):
        value = device_info.to_dict().get("device_on")
    return bool(value)


def build_api_client(email: str, password: str) -> ApiClient:
    """Prefer the KLAP handshake used by newer P100 firmware when configured."""
    encrypt_type = (os.getenv("TAPO_ENCRYPT_TYPE") or "").strip()
    if encrypt_type:
        try:
            return ApiClient(email, password, encrypt_type=encrypt_type)  # type: ignore[arg-type]
        except TypeError:
            log.warning(
                "Installed tapo library does not support encrypt_type=%s; "
                "using the default handshake. Upgrade with: pip install -U tapo",
                encrypt_type,
            )
    return ApiClient(email, password)


# --------------------------------------------------------------------------
# Apps Script API (blocking HTTP pushed off the event loop)
# --------------------------------------------------------------------------
async def call_api(api_url: str, worker_key: str, action: str, **payload: Any) -> dict[str, Any]:
    body = json.dumps({"action": action, "workerKey": worker_key, **payload})

    def _post() -> dict[str, Any]:
        response = requests.post(
            api_url,
            data=body.encode("utf-8"),
            headers=REQUESTS_HEADERS,
            timeout=45,
            allow_redirects=True,
        )
        response.raise_for_status()
        data = response.json()
        if not data.get("ok"):
            raise RuntimeError(data.get("error") or "Apps Script returned an error")
        return data

    return await asyncio.to_thread(_post)


# --------------------------------------------------------------------------
# Tapo plug access
# --------------------------------------------------------------------------
class PlugPool:
    """Caches Tapo connections and drops them on failure so they reconnect."""

    def __init__(self, api: ApiClient) -> None:
        self._api = api
        self._devices: dict[str, Any] = {}

    async def _device(self, ip: str) -> Any:
        device = self._devices.get(ip)
        if device is None:
            log.info("Connecting to Tapo P100 at %s", ip)
            device = await self._api.p100(ip)
            self._devices[ip] = device
        return device

    def forget(self, ip: str) -> None:
        self._devices.pop(ip, None)

    async def read_power(self, ip: str) -> bool:
        device = await self._device(ip)
        info = await device.get_device_info()
        return is_on(info)

    async def write_power(self, ip: str, on: bool) -> None:
        device = await self._device(ip)
        await (device.on() if on else device.off())


# --------------------------------------------------------------------------
# One subscription per cycle
# --------------------------------------------------------------------------
async def process_subscription(plugs: PlugPool, row: dict[str, Any]) -> dict[str, Any] | None:
    row_id = str(row.get("id") or "").strip()
    if not row_id:
        return None

    device_name = row.get("device_name") or "Extender"
    ip = str(row.get("tapo_ip") or "").strip()

    fields: dict[str, Any] = {}
    status = str(row.get("status") or "").upper()
    desired = bool(row.get("desired_power_state"))
    expires_at = parse_ts(row.get("expires_at"))
    now = utcnow()

    # 1) Auto-expire: the 30-day period ended but the row is still ACTIVE.
    if expires_at and expires_at <= now and status == "ACTIVE":
        log.info(
            "%s expired at %s — marking EXPIRED and cutting plug power",
            device_name,
            expires_at.isoformat(timespec="seconds"),
        )
        fields["status"] = "EXPIRED"
        fields["desired_power_state"] = False
        desired = False

    # 2) Keep the plug in sync with the desired state.
    if not ip:
        log.warning("%s has no tapo_ip configured — skipping plug control", device_name)
        fields["last_heartbeat"] = iso_now()
        return {"id": row_id, "fields": fields}

    try:
        actual = await plugs.read_power(ip)

        if actual != desired:
            log.info(
                "%s: plug %s -> %s",
                device_name,
                "ON" if actual else "OFF",
                "ON" if desired else "OFF",
            )
            await plugs.write_power(ip, desired)
            await asyncio.sleep(STATE_SETTLE_SECONDS)
            actual = await plugs.read_power(ip)
            if actual != desired:
                log.warning(
                    "%s: plug at %s did not reach the desired state (still %s)",
                    device_name,
                    ip,
                    "ON" if actual else "OFF",
                )

        fields["actual_power_state"] = actual
    except Exception as exc:  # noqa: BLE001 - one unreachable plug must not stop the worker
        plugs.forget(ip)
        log.warning("%s: plug at %s unreachable (%s)", device_name, ip, exc)
    finally:
        # Heartbeat proves the bridge (not necessarily the plug) is alive.
        fields["last_heartbeat"] = iso_now()

    return {"id": row_id, "fields": fields}


# --------------------------------------------------------------------------
# Main loop
# --------------------------------------------------------------------------
async def run_cycle(api_url: str, worker_key: str, plugs: PlugPool) -> None:
    data = await call_api(api_url, worker_key, "workerPoll")
    rows = data.get("rows") or []
    log.debug("Polling %d subscription(s)", len(rows))

    updates: list[dict[str, Any]] = []
    for row in rows:
        try:
            change = await process_subscription(plugs, row)
            if change:
                updates.append(change)
        except Exception:  # noqa: BLE001 - keep the loop alive
            log.exception("Failed to process %s", row.get("device_name"))

    if updates:
        result = await call_api(api_url, worker_key, "workerApply", updates=updates)
        log.debug("Applied %s row update(s)", result.get("updated"))


async def main() -> None:
    api_url = require_env("SHEETS_API_URL")
    worker_key = require_env("WORKER_KEY")
    api = build_api_client(require_env("TAPO_EMAIL"), require_env("TAPO_PASSWORD"))
    plugs = PlugPool(api)
    poll_interval = max(5, int(os.getenv("POLL_INTERVAL_SECONDS", "20")))

    log.info("Bridge worker started (poll interval: %ss)", poll_interval)

    try:
        while True:
            started = time.monotonic()
            try:
                await run_cycle(api_url, worker_key, plugs)
            except Exception:  # noqa: BLE001 - network/API outages are expected
                log.exception("Cycle failed; retrying in %ss", poll_interval)

            elapsed = time.monotonic() - started
            await asyncio.sleep(max(1.0, poll_interval - elapsed))
    except (KeyboardInterrupt, asyncio.CancelledError):
        log.info("Bridge worker stopped")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
