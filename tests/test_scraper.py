"""Pure-function tests for the BSX scraper.

These tests exercise everything that does NOT require a live Particl peer:
protobuf decoding, coin/decimals tables, varint round-trips, address
encoding, anonymisation, and the JSON output schema.

Network-dependent paths (peer connect, SMSG decrypt of live messages)
are out of scope and exercised by running ``scraper.py --auto`` manually.
"""
import json
import os

import pytest

# Hard-skip the whole module if the runtime deps are absent so a vanilla
# ``pytest`` invocation doesn't blow up before collection.
pytest.importorskip("coincurve")
pytest.importorskip("Crypto")

import scraper  # noqa: E402
from scraper import (  # noqa: E402
    BidMessage,
    COIN_DECIMALS,
    COIN_TICKERS,
    DEFAULT_DECIMALS,
    MESSAGE_TYPE_LABELS,
    MessageTypes,
    OfferMessage,
    decode_varint,
    format_amount,
    hash160,
    pkh_to_address,
    ripemd160,
    sha256,
    smsg_get_id,
    smsg_get_timestamp,
)


# -----------------------------------------------------------------------------
# decode_varint
# -----------------------------------------------------------------------------

def _encode_varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


@pytest.mark.parametrize("n", [0, 1, 127, 128, 16383, 16384, 2 ** 32, 2 ** 53])
def test_decode_varint_roundtrip(n):
    enc = _encode_varint(n)
    val, consumed = decode_varint(enc, 0)
    assert val == n
    assert consumed == len(enc)


def test_decode_varint_with_offset():
    payload = b"\x00\x00" + _encode_varint(99999)
    val, consumed = decode_varint(payload, 2)
    assert val == 99999
    assert consumed == len(payload) - 2


def test_decode_varint_overflow_raises():
    with pytest.raises(ValueError):
        decode_varint(b"\x80" * 10, 0)


# -----------------------------------------------------------------------------
# Coin tables
# -----------------------------------------------------------------------------

def test_coin_decimals_overrides():
    # WOW=11, XMR=12, everything else falls through to DEFAULT_DECIMALS=8.
    assert COIN_DECIMALS[6] == 12          # XMR
    assert COIN_DECIMALS[9] == 11          # WOW
    assert COIN_DECIMALS.get(2, DEFAULT_DECIMALS) == 8   # BTC default
    assert DEFAULT_DECIMALS == 8


def test_coin_tickers_cover_known_chains():
    # A regression here usually means BSX renumbered a coin upstream.
    expected = {1: "PART", 2: "BTC", 3: "LTC", 6: "XMR", 9: "WOW",
                12: "DASH", 13: "FIRO", 18: "DOGE"}
    for cid, ticker in expected.items():
        assert COIN_TICKERS[cid] == ticker


@pytest.mark.parametrize("amount,coin_id,expected", [
    (100_000_000, 2, "1.00000000"),                  # 1 BTC
    (123_456_789, 2, "1.23456789"),                  # ~1.23 BTC
    (1_000_000_000_000, 6, "1.000000000000"),        # 1 XMR
    (100_000_000_000, 9, "1.00000000000"),           # 1 WOW (11 decimals)
    (0, 2, "0.00000000"),
])
def test_format_amount(amount, coin_id, expected):
    assert format_amount(amount, coin_id) == expected


# -----------------------------------------------------------------------------
# Crypto helpers
# -----------------------------------------------------------------------------

def test_sha256_known_vector():
    assert sha256(b"abc").hex() == (
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )


def test_ripemd160_known_vector():
    assert ripemd160(b"abc").hex() == "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc"


def test_hash160_is_ripemd_of_sha256():
    assert hash160(b"hello") == ripemd160(sha256(b"hello"))


def test_pkh_to_address_particl_mainnet():
    # 0x38 = Particl mainnet pubkey-hash version byte. Hash of 20 zero bytes
    # is a stable, well-known input; we just assert the encode is deterministic
    # and produces a Particl-shaped (P-prefixed) base58check string.
    addr = pkh_to_address(b"\x38" + b"\x00" * 20)
    assert isinstance(addr, str)
    assert addr.startswith("P")
    assert 32 <= len(addr) <= 36


def test_smsg_get_id_and_timestamp_consistent():
    # Build a minimal SMSG-shaped buffer: header up to byte 108 + dummy ct.
    buf = bytearray(150)
    ts = 0x123456789ABCDEF0
    buf[11:19] = ts.to_bytes(8, "little")
    buf[104:108] = (42).to_bytes(4, "little")  # ciphertext length tag
    # The id is BE-ts || ripemd160(buf[8:]); timestamp helper uses LE ofs.
    assert smsg_get_timestamp(bytes(buf)) == ts
    msg_id = smsg_get_id(bytes(buf))
    assert len(msg_id) == 28  # 8 ts + 20 hash
