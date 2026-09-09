#!/usr/bin/env python3
"""Download the official simplex-chat binary for this platform.

Used by GitHub Actions so the orderbook scrape can join #bsx. The binary is
cached under .simplex-ci/bin (or --dest). Hash is checked against the
release _sha256sums when that file lists this build.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import platform
import stat
import sys
import urllib.request

SIMPLEX_CHAT_VERSION = os.getenv("SIMPLEX_CHAT_VERSION", "7.0.0")
RELEASE_BASE = (
    "https://github.com/simplex-chat/simplex-chat/releases/download/"
    f"v{SIMPLEX_CHAT_VERSION}"
)


def read_os_release() -> dict:
    info = {}
    try:
        with open("/etc/os-release") as fp:
            for line in fp:
                line = line.strip()
                if "=" not in line:
                    continue
                key, _, value = line.partition("=")
                info[key] = value.strip('"')
    except OSError:
        pass
    return info


def linux_build_tag() -> str:
    os_info = read_os_release()
    distro = os_info.get("ID", "").lower()
    if distro == "ubuntu":
        try:
            major = int(os_info.get("VERSION_ID", "").split(".")[0])
        except ValueError:
            major = 0
        return "ubuntu-22_04" if 0 < major < 24 else "ubuntu-24_04"
    return "ubuntu-24_04"


def release_filename() -> str:
    system = platform.system()
    machine = platform.machine().lower()
    if system == "Linux":
        arch = "aarch64" if ("arm" in machine or "aarch64" in machine) else "x86_64"
        return f"simplex-chat-{linux_build_tag()}-{arch}"
    if system == "Darwin":
        if machine in ("arm64", "aarch64"):
            return "simplex-chat-macos-aarch64"
        return "simplex-chat-macos-x86-64"
    if system == "Windows":
        return "simplex-chat-windows-x86-64"
    raise ValueError(f"Unsupported platform {system} {machine}")


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_sums(text: str) -> dict:
    out = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            out[parts[-1].rsplit("/", 1)[-1]] = parts[0]
    return out


def download(url: str, dest: str) -> None:
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    tmp = dest + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": "bsx-orderbook-ensure-simplex"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as out:
        while True:
            chunk = resp.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
    os.replace(tmp, dest)


def verify_hash(path: str, filename: str) -> None:
    sums_url = f"{RELEASE_BASE}/_sha256sums"
    try:
        req = urllib.request.Request(
            sums_url, headers={"User-Agent": "bsx-orderbook-ensure-simplex"}
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            sums = parse_sums(resp.read().decode("utf-8", "replace"))
    except Exception as e:
        print(f"warning: could not fetch _sha256sums ({e}); skipping hash check",
              file=sys.stderr)
        return
    expected = sums.get(filename)
    if not expected:
        print(f"warning: {filename} not in _sha256sums; skipping hash check",
              file=sys.stderr)
        return
    got = sha256_file(path)
    if got != expected:
        raise ValueError(f"hash mismatch for {filename}: {got} != {expected}")
    print(f"verified {filename} sha256 {got}")


def binary_ok(path: str) -> bool:
    if not (os.path.isfile(path) and os.access(path, os.X_OK)):
        return False
    return os.path.getsize(path) > 1_000_000


def ensure(dest_dir: str) -> str:
    dest_dir = os.path.abspath(dest_dir)
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, "simplex-chat")
    name = release_filename()
    if binary_ok(dest):
        print(f"using existing {dest}")
        return dest
    url = f"{RELEASE_BASE}/{name}"
    print(f"downloading {url}")
    download(url, dest)
    verify_hash(dest, name)
    mode = os.stat(dest).st_mode
    os.chmod(dest, mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    if not binary_ok(dest):
        raise ValueError(f"downloaded binary is missing or too small: {dest}")
    return dest


def main() -> int:
    parser = argparse.ArgumentParser(description="Ensure a simplex-chat binary is present")
    parser.add_argument(
        "--dest",
        default=os.path.join(".simplex-ci", "bin"),
        help="Directory to place simplex-chat (default: .simplex-ci/bin)",
    )
    args = parser.parse_args()
    path = ensure(args.dest)
    print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
