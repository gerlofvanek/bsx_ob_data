#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SimpleX #bsx group scraper for BasicSwap broadcast offers.

Talks to a local simplex-chat WebSocket API (stdlib WS). Prefers attaching
to an already-running client (a coinswaps/BasicSwap node); otherwise starts
one if a binary is found.
"""

import base64
import json
import logging
import os
import shutil
import socket
import subprocess
import time

from nostr_scrape import ws_connect, ws_recv_message, ws_send_frame, ws_send_text

log = logging.getLogger("BSXScraper")

DEFAULT_GROUP = "bsx"
DEFAULT_WS_URL = "ws://127.0.0.1:5225"
DEFAULT_WS_PORT = 5225
DEFAULT_OWN_PORT = 15225
DEFAULT_GROUP_LINK = (
    "https://smp4.simplex.im/g#6wTyP9neyb9ki_J8ntUqjL3q7CWWqPk3Z-o5bpuvfXg"
)
DEFAULT_SERVER = (
    "smp://u2dS9sG8nMNURyZwqASV4yROM28Er0luVTx5X1CsMrU=@smp4.simplex.im"
)
DEFAULT_TAIL = 200
SMSG_HDR_LEN = 108


def get_response_data(data, tag=None):
    if not isinstance(data, dict):
        return None
    resp = data.get("resp", data)
    if not isinstance(resp, dict):
        return None
    for pretag in ("Right", "Left"):
        if pretag in resp and isinstance(resp[pretag], dict):
            inner = resp[pretag]
            return inner.get(tag) if tag else inner
    return resp.get(tag) if tag else resp


def iter_chat_items(obj):
    """Yield chat-item dicts ({chatInfo, chatItem}) from any SimpleX JSON blob."""
    if isinstance(obj, dict):
        if "chatItem" in obj and "chatInfo" in obj:
            yield obj
        items = obj.get("chatItems")
        if isinstance(items, list):
            for it in items:
                if isinstance(it, dict):
                    if "chatItem" in it:
                        yield it
                    else:
                        yield from iter_chat_items(it)
        for k, v in obj.items():
            if k in ("chatItems", "chatItem", "chatInfo"):
                continue
            yield from iter_chat_items(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from iter_chat_items(v)


def chat_item_group_name(item):
    try:
        info = item["chatInfo"]
        if info.get("type") != "group":
            return None
        return info["groupInfo"]["localDisplayName"]
    except (KeyError, TypeError):
        return None


def chat_item_text(item):
    try:
        content = item["chatItem"]["content"]
        if isinstance(content, dict) and "msgContent" in content:
            return content["msgContent"].get("text")
        return None
    except (KeyError, TypeError):
        return None


def smsg_from_b64_text(text):
    if not text or not isinstance(text, str):
        return None
    compact = "".join(text.split())
    if len(compact) < 140:
        return None
    try:
        raw = base64.b64decode(compact, validate=False)
    except Exception:
        return None
    if len(raw) < SMSG_HDR_LEN:
        return None
    return raw


def group_display_names(groups_payload):
    names = []
    groups = groups_payload if isinstance(groups_payload, list) else []
    for g in groups:
        info = g
        if isinstance(g, list) and g:
            info = g[0]
        if not isinstance(info, dict):
            continue
        if "localDisplayName" in info:
            names.append(info["localDisplayName"])
            continue
        gi = info.get("groupInfo")
        if isinstance(gi, dict) and gi.get("localDisplayName"):
            names.append(gi["localDisplayName"])
    return names


def find_simplex_binary(explicit=None):
    candidates = []
    if explicit:
        candidates.append(os.path.expanduser(explicit))
    env = os.environ.get("SIMPLEX_CLIENT_PATH")
    if env:
        candidates.append(os.path.expanduser(env))
    which = shutil.which("simplex-chat")
    if which:
        candidates.append(which)
    home = os.path.expanduser("~")
    candidates.extend([
        os.path.join(home, "coinswaps", "bin", "simplex", "simplex-chat"),
        os.path.join(home, "basicswap", "bin", "simplex", "simplex-chat"),
        os.path.join(home, ".cache", "bsx_orderbook", "bin", "simplex-chat"),
    ])
    for path in candidates:
        if path and os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return None


def default_data_dir():
    override = os.environ.get("SIMPLEX_SCRAPE_DATA")
    if override:
        return os.path.expanduser(override)
    return os.path.join(os.path.expanduser("~"), ".cache", "bsx_orderbook", "simplex")


class SimplexWs:
    def __init__(self, url):
        self.url = url
        self.sock = None
        self.corr = 0

    def connect(self, timeout=8):
        self.sock = ws_connect(self.url, timeout=timeout)
        self.sock.settimeout(1.0)

    def close(self):
        if self.sock is None:
            return
        try:
            ws_send_frame(self.sock, 0x8, b"")
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass
        self.sock = None

    def send_command(self, cmd):
        self.corr += 1
        cid = str(self.corr)
        ws_send_text(self.sock, json.dumps({"corrId": cid, "cmd": cmd}))
        return cid

    def recv_one(self):
        raw = ws_recv_message(self.sock)
        if raw is None:
            return None
        if not isinstance(raw, str):
            return None
        return json.loads(raw)

    def wait_response(self, cid, timeout=45):
        deadline = time.monotonic() + timeout
        extras = []
        while time.monotonic() < deadline:
            try:
                msg = self.recv_one()
            except socket.timeout:
                continue
            if msg is None:
                break
            if str(msg.get("corrId", "")) == str(cid):
                return msg, extras
            extras.append(msg)
        raise TimeoutError(f"SimpleX command {cid} timed out")

    def drain(self, seconds):
        deadline = time.monotonic() + max(0.0, seconds)
        out = []
        while time.monotonic() < deadline:
            try:
                msg = self.recv_one()
            except socket.timeout:
                continue
            if msg is None:
                break
            out.append(msg)
        return out


def try_attach(url, timeout=3):
    ws = SimplexWs(url)
    try:
        ws.connect(timeout=timeout)
        cid = ws.send_command("/groups")
        resp, extras = ws.wait_response(cid, timeout=15)
        return ws, resp, extras
    except Exception:
        ws.close()
        return None, None, []


def _init_profile(bin_path, data_prefix, port, server):
    args = [bin_path, "-d", data_prefix, "-p", str(port), "-e", "/help", "-s", server]
    p = subprocess.Popen(
        args,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        deadline = time.time() + 45
        buf = b""
        while p.poll() is None and time.time() < deadline:
            chunk = p.stdout.read(256)
            if not chunk:
                break
            buf += chunk
            if b"display name" in buf.lower():
                p.stdin.write(b"bsxob\n")
                p.stdin.flush()
        try:
            p.wait(timeout=20)
        except subprocess.TimeoutExpired:
            p.terminate()
            p.wait(timeout=5)
    finally:
        if p.poll() is None:
            p.kill()


def start_simplex_client(bin_path, data_dir, port, server):
    os.makedirs(data_dir, exist_ok=True)
    data_prefix = os.path.join(data_dir, "simplex_client_data")
    db_path = data_prefix + "_chat.db"
    if not os.path.exists(db_path):
        log.info("SimpleX: initialising new client profile")
        _init_profile(bin_path, data_prefix, port, server)
    args = [bin_path, "-d", data_prefix, "-p", str(port), "-l", "error"]
    if not os.path.exists(db_path):
        args += ["-s", server]
    log_path = os.path.join(data_dir, "simplex_stdout.log")
    log_fp = open(log_path, "ab")
    proc = subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=log_fp,
        stderr=log_fp,
        cwd=data_dir,
    )
    return proc, log_fp


def ensure_bsx_group(ws, group_link, group=DEFAULT_GROUP):
    cid = ws.send_command("/groups")
    resp, extras = ws.wait_response(cid, timeout=20)
    names = group_display_names(get_response_data(resp, "groups") or [])
    extras.append(resp)
    if group in names:
        return extras, True
    log.info(f"SimpleX: joining #{group}")
    cid = ws.send_command("/c " + group_link)
    join_resp, join_extras = ws.wait_response(cid, timeout=60)
    extras.extend(join_extras)
    extras.append(join_resp)
    return extras, False


def collect_group_items(ws, group=DEFAULT_GROUP, tail=DEFAULT_TAIL, listen_s=15):
    items = []
    for cmd in (f"/_get chat #{group} count={tail}", f"/tail #{group} {tail}"):
        try:
            cid = ws.send_command(cmd)
            resp, extras = ws.wait_response(cid, timeout=30)
            items.extend(iter_chat_items(resp))
            for extra in extras:
                items.extend(iter_chat_items(extra))
            break
        except Exception as e:
            log.debug(f"SimpleX {cmd} failed: {e}")
    items.extend(iter_chat_items(ws.drain(listen_s)))
    seen = set()
    out = []
    for item in items:
        if chat_item_group_name(item) != group:
            continue
        text = chat_item_text(item)
        raw = smsg_from_b64_text(text)
        if raw is None:
            continue
        key = raw[:64]
        if key in seen:
            continue
        seen.add(key)
        out.append(raw)
    return out


def collect_simplex_smsgs(
    ws_url=DEFAULT_WS_URL,
    group_link=DEFAULT_GROUP_LINK,
    group=DEFAULT_GROUP,
    duration=15,
    tail=DEFAULT_TAIL,
    client_path=None,
    data_dir=None,
    server=DEFAULT_SERVER,
    start_if_needed=True,
    own_port=DEFAULT_OWN_PORT,
):
    """Return (smsg_blobs, meta). Never raises to the caller for attach/start misses."""
    meta = {
        "attached": False,
        "started": False,
        "ok": False,
        "error": "",
        "group_joined": False,
        "messages": 0,
    }
    ws = None
    proc = None
    log_fp = None
    started = False
    try:
        ws, resp, extras = try_attach(ws_url)
        if ws is not None:
            meta["attached"] = True
            log.info(f"SimpleX: attached to {ws_url}")
        elif start_if_needed:
            binary = find_simplex_binary(client_path)
            if not binary:
                meta["error"] = "no simplex-chat binary and nothing listening"
                log.warning(
                    "SimpleX: skipped (no client on %s and no simplex-chat binary). "
                    "Install one or start BasicSwap with SimpleX, or pass --simplex-client.",
                    ws_url,
                )
                return [], meta
            data_dir = data_dir or default_data_dir()
            port = own_port or DEFAULT_OWN_PORT
            own_url = f"ws://127.0.0.1:{port}"
            proc, log_fp = start_simplex_client(binary, data_dir, port, server)
            started = True
            meta["started"] = True
            log.info(f"SimpleX: started {binary} pid={proc.pid} on :{port}")
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    meta["error"] = f"simplex-chat exited {proc.returncode}"
                    return [], meta
                ws, resp, extras = try_attach(own_url, timeout=2)
                if ws is not None:
                    break
                time.sleep(0.5)
            if ws is None:
                meta["error"] = "started client but websocket never came up"
                return [], meta
        else:
            meta["error"] = f"nothing listening on {ws_url}"
            return [], meta

        join_msgs, already = ensure_bsx_group(ws, group_link, group=group)
        meta["group_joined"] = True
        extras = list(extras or []) + join_msgs
        blobs = collect_group_items(ws, group=group, tail=tail, listen_s=duration)
        # Also harvest anything already sitting in the join/attach extras.
        for extra in extras:
            for item in iter_chat_items(extra):
                if chat_item_group_name(item) != group:
                    continue
                raw = smsg_from_b64_text(chat_item_text(item))
                if raw is not None:
                    blobs.append(raw)
        # Dedup again after the extra harvest.
        uniq, seen = [], set()
        for raw in blobs:
            key = raw[:64]
            if key in seen:
                continue
            seen.add(key)
            uniq.append(raw)
        meta["messages"] = len(uniq)
        meta["ok"] = True
        if already:
            log.info(f"SimpleX: already in #{group}, {len(uniq)} SMSG blob(s)")
        else:
            log.info(f"SimpleX: joined #{group}, {len(uniq)} SMSG blob(s)")
        return uniq, meta
    except Exception as e:
        meta["error"] = f"{type(e).__name__}: {e}"
        log.warning(f"SimpleX scrape failed: {meta['error']}")
        return [], meta
    finally:
        if ws is not None:
            ws.close()
        if started and proc is not None:
            try:
                proc.terminate()
                proc.wait(timeout=8)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        if log_fp is not None:
            try:
                log_fp.close()
            except Exception:
                pass
