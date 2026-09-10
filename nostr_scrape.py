#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Minimal Nostr relay client for scraping BasicSwap broadcast offers.

Connects over WebSocket (stdlib only), subscribes to kind 4859 / #t=bsx,
and yields verified events. Payload decrypt happens in scraper.py.
"""

import base64
import hashlib
import json
import logging
import os
import socket
import ssl
import threading
import time
from urllib.parse import urlparse

from coincurve.keys import PublicKeyXOnly

log = logging.getLogger("BSXScraper")

BSX_NOSTR_KIND = 4859
DEFAULT_NOSTR_TAG = "bsx"
DEFAULT_NOSTR_RELAYS = (
    "wss://relay.primal.net",
    "wss://nos.lol",
    "wss://relay.damus.io",
    "wss://relay.momostr.pink",
    "wss://nostr.mom",
)
DEFAULT_NOSTR_SINCE_S = 48 * 3600
_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_MAX_FRAME = 2 * 1024 * 1024


def event_serialize(pubkey_hex, created_at, kind, tags, content):
    return json.dumps(
        [0, pubkey_hex, created_at, kind, tags, content],
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def event_id(pubkey_hex, created_at, kind, tags, content):
    return hashlib.sha256(
        event_serialize(pubkey_hex, created_at, kind, tags, content)
    ).digest()


def verify_event(event):
    try:
        eid = event_id(
            event["pubkey"],
            event["created_at"],
            event["kind"],
            event["tags"],
            event["content"],
        )
        if eid.hex() != event["id"]:
            return False
        pk = PublicKeyXOnly(bytes.fromhex(event["pubkey"]))
        return bool(pk.verify(bytes.fromhex(event["sig"]), eid))
    except Exception:
        return False


def event_has_tag(event, name, value):
    for tag in event.get("tags") or []:
        if len(tag) >= 2 and tag[0] == name and tag[1] == value:
            return True
    return False


def event_tag_value(event, name):
    for tag in event.get("tags") or []:
        if len(tag) >= 2 and tag[0] == name:
            return tag[1]
    return None


def parse_relay_list(text):
    if not text:
        return list(DEFAULT_NOSTR_RELAYS)
    out = []
    for part in str(text).split(","):
        url = part.strip()
        if url:
            out.append(url)
    return out or list(DEFAULT_NOSTR_RELAYS)


def _recv_exact(sock, n):
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("websocket closed")
        buf.extend(chunk)
    return bytes(buf)


def ws_send_frame(sock, opcode, payload):
    payload = bytes(payload)
    mask = os.urandom(4)
    header = bytearray()
    header.append(0x80 | (opcode & 0x0F))
    n = len(payload)
    if n < 126:
        header.append(0x80 | n)
    elif n < 65536:
        header.append(0x80 | 126)
        header.extend(n.to_bytes(2, "big"))
    else:
        header.append(0x80 | 127)
        header.extend(n.to_bytes(8, "big"))
    header.extend(mask)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    sock.sendall(header + masked)


def ws_send_text(sock, text):
    ws_send_frame(sock, 0x1, text.encode("utf-8"))


def ws_recv_message(sock):
    """Read one complete text message. Auto-answers pings. None on close."""
    fragments = []
    start_opcode = None
    while True:
        hdr = _recv_exact(sock, 2)
        fin = hdr[0] >> 7
        opcode = hdr[0] & 0x0F
        masked = hdr[1] >> 7
        length = hdr[1] & 0x7F
        if length == 126:
            length = int.from_bytes(_recv_exact(sock, 2), "big")
        elif length == 127:
            length = int.from_bytes(_recv_exact(sock, 8), "big")
        if length > _MAX_FRAME:
            raise ValueError("websocket frame too large")
        mask = _recv_exact(sock, 4) if masked else b""
        payload = bytearray(_recv_exact(sock, length))
        if masked:
            for i in range(len(payload)):
                payload[i] ^= mask[i % 4]
        if opcode == 0x8:
            return None
        if opcode == 0x9:
            ws_send_frame(sock, 0xA, payload)
            continue
        if opcode == 0xA:
            continue
        if opcode in (0x0, 0x1, 0x2):
            if opcode != 0x0:
                start_opcode = opcode
            fragments.append(bytes(payload))
            if fin:
                data = b"".join(fragments)
                if start_opcode == 0x1:
                    return data.decode("utf-8")
                return data
        else:
            raise ValueError(f"unsupported websocket opcode {opcode}")


def ws_connect(url, timeout=12):
    u = urlparse(url)
    if u.scheme not in ("ws", "wss") or not u.hostname:
        raise ValueError(f"invalid relay url: {url}")
    port = u.port or (443 if u.scheme == "wss" else 80)
    path = u.path or "/"
    if u.query:
        path += "?" + u.query
    raw = socket.create_connection((u.hostname, port), timeout=timeout)
    sock = raw
    if u.scheme == "wss":
        ctx = ssl.create_default_context()
        sock = ctx.wrap_socket(raw, server_hostname=u.hostname)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    host_hdr = u.hostname if (u.port in (None, 80, 443)) else f"{u.hostname}:{u.port}"
    req = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host_hdr}\r\n"
        f"Upgrade: websocket\r\n"
        f"Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        f"Sec-WebSocket-Version: 13\r\n"
        f"\r\n"
    )
    sock.sendall(req.encode("ascii"))
    buf = bytearray()
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("relay closed during websocket handshake")
        buf.extend(chunk)
        if len(buf) > 16384:
            raise ConnectionError("websocket handshake too large")
    head, _rest = bytes(buf).split(b"\r\n\r\n", 1)
    status_line = head.split(b"\r\n", 1)[0].decode("ascii", "replace")
    if "101" not in status_line:
        raise ConnectionError(f"websocket upgrade failed: {status_line}")
    expect = base64.b64encode(hashlib.sha1((key + _WS_GUID).encode("ascii")).digest()).decode("ascii")
    headers = {}
    for line in head.split(b"\r\n")[1:]:
        if b":" in line:
            k, v = line.split(b":", 1)
            headers[k.decode("ascii", "replace").lower()] = v.decode("ascii", "replace").strip()
    accept = headers.get("sec-websocket-accept", "")
    if accept and accept != expect:
        raise ConnectionError("bad Sec-WebSocket-Accept")
    return sock


def _relay_worker(url, since, duration, out_q, stop_event, kind, tag):
    sock = None
    try:
        sock = ws_connect(url)
        sub_id = "bsxob"
        req = ["REQ", sub_id, {"kinds": [kind], "#t": [tag], "since": int(since)}]
        ws_send_text(sock, json.dumps(req))
        deadline = time.monotonic() + max(1, int(duration))
        sock.settimeout(1.0)
        while time.monotonic() < deadline and not stop_event.is_set():
            try:
                raw = ws_recv_message(sock)
            except socket.timeout:
                continue
            if raw is None:
                break
            if not isinstance(raw, str):
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, list) or len(msg) < 2:
                continue
            if msg[0] == "EVENT" and len(msg) >= 3 and isinstance(msg[2], dict):
                out_q.append(msg[2])
            elif msg[0] == "EOSE":
                # Keep the socket open for live events until the scrape window ends.
                continue
            elif msg[0] == "NOTICE":
                log.debug(f"Nostr {url} notice: {msg[1:]}")
        out_q.append(("__ok__", url))
    except Exception as e:
        log.warning(f"Nostr relay {url} failed: {type(e).__name__}: {e}")
        out_q.append(("__fail__", url))
    finally:
        if sock is not None:
            try:
                ws_send_frame(sock, 0x8, b"")
            except Exception:
                pass
            try:
                sock.close()
            except Exception:
                pass


def collect_nostr_events(relays, duration, since_ts, kind=BSX_NOSTR_KIND,
                         tag=DEFAULT_NOSTR_TAG, stop_event=None):
    """Connect to relays in parallel; return (events, ok_urls, fail_urls)."""
    stop_event = stop_event or threading.Event()
    lock = threading.Lock()

    class _LockedList(list):
        def append(self, item):
            with lock:
                super().append(item)

    shared = _LockedList()
    threads = []
    for url in relays:
        t = threading.Thread(
            target=_relay_worker,
            args=(url, since_ts, duration, shared, stop_event, kind, tag),
            daemon=True,
        )
        t.start()
        threads.append(t)
    for t in threads:
        t.join(timeout=max(2, int(duration) + 15))

    events, ok_urls, fail_urls = [], [], []
    seen_ids = set()
    for item in list(shared):
        if isinstance(item, tuple):
            if item[0] == "__ok__":
                ok_urls.append(item[1])
            elif item[0] == "__fail__":
                fail_urls.append(item[1])
            continue
        eid = item.get("id")
        if not eid or eid in seen_ids:
            continue
        seen_ids.add(eid)
        events.append(item)
    return events, ok_urls, fail_urls
