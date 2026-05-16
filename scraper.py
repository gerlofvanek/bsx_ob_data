#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
BSX Orderbook Scraper - Self-contained

Connects directly to Particl P2P network, receives SMSG messages,
decrypts BSX offers, and outputs orderbook as JSON.

NO particld. NO BasicSwap. NO blockchain sync. Just raw P2P.

Usage:
    python scraper.py --auto --duration 15 -o orderbook.json

Requirements:
    pip install coincurve pycryptodome
"""

import argparse
import asyncio
import hashlib
import hmac
import json
import logging
import os
import socket
import struct
import sys
import time
from enum import IntEnum

from coincurve.keys import PublicKey, PrivateKey
from Crypto.Cipher import AES

# Local P2P framework (copied from BasicSwap test framework)
from p2p.messages import (
    NODE_NETWORK, NODE_WITNESS, NODE_SMSG,
    ser_string, deser_string,
    msg_verack, msg_pong, msg_headers,
    msg_smsgPing, msg_smsgPong, msg_smsgInv, msg_smsgMsg,
)
from p2p.p2p import P2PInterface, NetworkThread, MESSAGEMAP

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("BSXScraper")

# ============================================================================
# Constants
# ============================================================================

# BSX shared network key (all nodes use this to encrypt/decrypt offers)
NETWORK_KEY_WIF = "7sW2UEcHXvuqEjkpE5mD584zRaQYs6WXYohue4jLFZPTvMSxwvgs"
PARTICL_MAINNET_PORT = 51738
DNS_SEEDS = ["mainnet-seed.particl.io", "dnsseed-mainnet.particl.community"]
SMSG_HDR_LEN = 108
SMSG_ID_LEN = 28


class MessageTypes(IntEnum):
    OFFER = 1
    BID = 2
    BID_ACCEPT = 3
    XMR_OFFER = 4
    XMR_BID_FL = 5
    XMR_BID_SPLIT = 6
    XMR_BID_ACCEPT_LF = 7
    XMR_BID_TXN_SIGS_FL = 8
    XMR_BID_LOCK_SPEND_TX_LF = 9
    XMR_BID_LOCK_RELEASE_LF = 10
    OFFER_REVOKE = 11
    ADS_BID_LF = 12
    ADS_BID_ACCEPT_FL = 13


# Friendly labels for the message-type counter in stats.
MESSAGE_TYPE_LABELS = {
    MessageTypes.OFFER: "offer",
    MessageTypes.BID: "bid",
    MessageTypes.BID_ACCEPT: "bid_accept",
    MessageTypes.XMR_OFFER: "xmr_offer",
    MessageTypes.XMR_BID_FL: "xmr_bid",
    MessageTypes.XMR_BID_SPLIT: "xmr_bid_split",
    MessageTypes.XMR_BID_ACCEPT_LF: "xmr_bid_accept",
    MessageTypes.XMR_BID_TXN_SIGS_FL: "xmr_bid_txn_sigs",
    MessageTypes.XMR_BID_LOCK_SPEND_TX_LF: "xmr_lock_spend",
    MessageTypes.XMR_BID_LOCK_RELEASE_LF: "xmr_lock_release",
    MessageTypes.OFFER_REVOKE: "offer_revoke",
    MessageTypes.ADS_BID_LF: "ads_bid",
    MessageTypes.ADS_BID_ACCEPT_FL: "ads_bid_accept",
}


# Coin ID -> ticker (from BasicSwap chainparams)
COIN_TICKERS = {
    1: "PART", 2: "BTC", 3: "LTC", 4: "DCR", 5: "NMC",
    6: "XMR", 7: "PART_BLIND", 8: "PART_ANON", 9: "WOW",
    11: "PIVX", 12: "DASH", 13: "FIRO", 14: "NAV",
    15: "LTC_MWEB", 17: "BCH", 18: "DOGE",
}

# Coin decimal places. Most are 8 (BTC-style); XMR uses 12, WOW uses 11.
# Mirrors basicswap/chainparams.py (XMR_COIN = 10**12, WOW_COIN = 10**11).
COIN_DECIMALS = {6: 12, 9: 11}
DEFAULT_DECIMALS = 8


# ============================================================================
# Crypto utilities (inlined from basicswap/util/smsg.py)
# ============================================================================


def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def ripemd160(data: bytes) -> bytes:
    return hashlib.new("ripemd160", data).digest()


def hash160(data: bytes) -> bytes:
    return ripemd160(sha256(data))


def aes_decrypt(ciphertext: bytes, key: bytes, iv: bytes) -> bytes:
    cipher = AES.new(key, AES.MODE_CBC, iv)
    plaintext = cipher.decrypt(ciphertext)
    # PKCS7 unpad
    pad_len = plaintext[-1]
    return plaintext[:-pad_len]


def smsg_get_timestamp(msg: bytes) -> int:
    return int.from_bytes(msg[11:19], byteorder="little")


def smsg_get_id(msg: bytes) -> bytes:
    ts = int.from_bytes(msg[11:19], byteorder="big")
    return ts.to_bytes(8, byteorder="big") + ripemd160(msg[8:])


B58_ALPHABET = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def pkh_to_address(version_and_hash: bytes) -> str:
    """Convert version byte + 20-byte pubkey hash to base58check address."""
    checksum = hashlib.sha256(hashlib.sha256(version_and_hash).digest()).digest()[:4]
    data = version_and_hash + checksum
    n = int.from_bytes(data, "big")
    result = b""
    while n > 0:
        n, r = divmod(n, 58)
        result = B58_ALPHABET[r:r + 1] + result
    for b in data:
        if b == 0:
            result = b"1" + result
        else:
            break
    return result.decode("ascii")


def smsg_decrypt(privkey: bytes, encrypted_message: bytes) -> dict:
    """Decrypt an SMSG message. Returns dict with hex payload, timestamp, etc."""
    assert len(encrypted_message) > SMSG_HDR_LEN
    smsg_ts = int.from_bytes(encrypted_message[11:19], byteorder="little")
    smsg_iv = encrypted_message[23:39]
    R = encrypted_message[39:72]
    mac = encrypted_message[72:104]
    ct_len = int.from_bytes(encrypted_message[104:108], byteorder="little")
    ciphertext = encrypted_message[108:]
    assert len(ciphertext) == ct_len

    # ECDH shared secret -> SHA-512 -> key_e (encryption) + key_m (MAC)
    p = PrivateKey(privkey).ecdh(R)
    H = hashlib.sha512(p).digest()
    key_e, key_m = H[:32], H[32:]

    # Verify MAC
    m = hmac.new(key_m, digestmod="SHA256")
    m.update(smsg_ts.to_bytes(8, byteorder="little"))
    m.update(smsg_iv)
    m.update(ciphertext)
    assert mac == m.digest()  # MAC mismatch = not encrypted to our key

    plaintext = aes_decrypt(ciphertext, key_e, smsg_iv)

    # Parse plaintext header
    ofs = 0
    if plaintext[0] == 249:  # payload format version 2
        assert plaintext[1] == 0  # no compression
        ofs += 1
    ofs += 1  # version byte
    pkh_from = plaintext[ofs:ofs + 20]; ofs += 20
    signature = plaintext[ofs:ofs + 65]; ofs += 65
    ofs += 4  # payload length
    payload = plaintext[ofs:]

    # Convert 20-byte pubkey hash to Particl address (base58check, version 0x38)
    addr_from = pkh_to_address(b"\x38" + pkh_from)

    return {"hex": payload.hex(), "sent": smsg_ts,
            "msgid": smsg_get_id(encrypted_message).hex(),
            "addr_from": addr_from}


# ============================================================================
# Protobuf parser (inlined from basicswap/messages_npb.py + util/integer.py)
# ============================================================================


def decode_varint(b: bytes, offset: int = 0):
    i, num_bytes = 0, 0
    while True:
        c = b[offset + num_bytes]
        i += (c & 0x7F) << (num_bytes * 7)
        num_bytes += 1
        if not c & 0x80:
            break
        if num_bytes > 8:
            raise ValueError("Too many bytes")
    return i, num_bytes


class OfferMessage:
    """Minimal protobuf-like parser for BSX OfferMessage."""
    _map = {
        1: ("protocol_version", 0), 2: ("coin_from", 0), 3: ("coin_to", 0),
        4: ("amount_from", 0), 5: ("amount_to", 0), 6: ("min_bid_amount", 0),
        7: ("time_valid", 0), 8: ("lock_type", 0), 9: ("lock_value", 0),
        10: ("swap_type", 0), 11: ("proof_address", 2), 12: ("proof_signature", 2),
        13: ("pkhash_seller", 2), 14: ("secret_hash", 2),
        15: ("fee_rate_from", 0), 16: ("fee_rate_to", 0),
        17: ("amount_negotiable", 0), 18: ("rate_negotiable", 0),
        19: ("proof_utxos", 2), 20: ("auto_accept_type", 0),
        21: ("message_nets", 2),
    }

    def from_bytes(self, b: bytes):
        o = 0
        while o < len(b):
            tag, lv = decode_varint(b, o); o += lv
            wire_type = tag & 7
            field_num = tag >> 3
            if field_num not in self._map:
                # Skip unknown fields
                if wire_type == 0:
                    _, lv = decode_varint(b, o); o += lv
                elif wire_type == 2:
                    flen, lv = decode_varint(b, o); o += lv + flen
                else:
                    break
                continue
            name, expected_wt = self._map[field_num]
            if wire_type == 0:
                val, lv = decode_varint(b, o); o += lv
            elif wire_type == 2:
                flen, lv = decode_varint(b, o); o += lv
                val = b[o:o + flen]; o += flen
            else:
                break
            setattr(self, name, val)


class BidMessage:
    """Minimal protobuf-like parser for BSX BidMessage; we only need offer_msg_id
    so the orderbook can attach bid_count to each offer."""
    _map = {
        1: ("protocol_version", 0), 2: ("offer_msg_id", 2),
        3: ("time_valid", 0), 4: ("amount", 0),
        5: ("pkhash_buyer", 2), 6: ("proof_address", 2),
        7: ("proof_signature", 2), 8: ("proof_utxos", 2),
        9: ("amount_to", 0), 10: ("rate", 0),
    }

    def from_bytes(self, b: bytes):
        o = 0
        while o < len(b):
            tag, lv = decode_varint(b, o); o += lv
            wire_type = tag & 7
            field_num = tag >> 3
            if field_num not in self._map:
                if wire_type == 0:
                    _, lv = decode_varint(b, o); o += lv
                elif wire_type == 2:
                    flen, lv = decode_varint(b, o); o += lv + flen
                else:
                    break
                continue
            name, _ = self._map[field_num]
            if wire_type == 0:
                val, lv = decode_varint(b, o); o += lv
            elif wire_type == 2:
                flen, lv = decode_varint(b, o); o += lv
                val = b[o:o + flen]; o += flen
            else:
                break
            setattr(self, name, val)


class OfferRevokeMessage:
    """Minimal parser for BSX OfferRevokeMessage; we only need offer_msg_id so the
    orderbook can drop offers the maker has explicitly revoked. Mirrors basicswap's
    messages_npb.OfferRevokeMessage (fields 1=offer_msg_id, 2=signature)."""
    _map = {1: ("offer_msg_id", 2), 2: ("signature", 2)}

    def from_bytes(self, b: bytes):
        o = 0
        while o < len(b):
            tag, lv = decode_varint(b, o); o += lv
            wire_type = tag & 7
            field_num = tag >> 3
            if field_num not in self._map:
                if wire_type == 0:
                    _, lv = decode_varint(b, o); o += lv
                elif wire_type == 2:
                    flen, lv = decode_varint(b, o); o += lv + flen
                else:
                    break
                continue
            name, _ = self._map[field_num]
            if wire_type == 0:
                val, lv = decode_varint(b, o); o += lv
            elif wire_type == 2:
                flen, lv = decode_varint(b, o); o += lv
                val = b[o:o + flen]; o += flen
            else:
                break
            setattr(self, name, val)


# ============================================================================
# SMSG Protocol Messages (wire format implementations)
# ============================================================================


class msg_smsgShow_impl:
    __slots__ = ("bucket_times",)
    msgtype = b"smsgShow"

    def __init__(self, bucket_times=None):
        self.bucket_times = bucket_times or []

    def serialize(self):
        r = len(self.bucket_times).to_bytes(4, "little")
        for bt in self.bucket_times:
            r += bt.to_bytes(8, "little")
        return ser_string(r)

    def deserialize(self, f):
        data = deser_string(f)
        self.bucket_times = []
        for i in range(0, len(data), 8):
            self.bucket_times.append(int.from_bytes(data[i:i+8], "little"))

    def __repr__(self):
        return f"msg_smsgShow(buckets={len(self.bucket_times)})"


class msg_smsgHave_impl:
    __slots__ = ("bucket_time", "msg_hashes")
    msgtype = b"smsgHave"

    def __init__(self):
        self.bucket_time = 0
        self.msg_hashes = []

    def serialize(self):
        r = self.bucket_time.to_bytes(8, "little")
        for mh in self.msg_hashes:
            r += mh
        return ser_string(r)

    def deserialize(self, f):
        data = deser_string(f)
        if len(data) < 8:
            return
        self.bucket_time = int.from_bytes(data[0:8], "little")
        self.msg_hashes = []
        ofs = 8
        while ofs + SMSG_ID_LEN <= len(data):
            self.msg_hashes.append(data[ofs:ofs + SMSG_ID_LEN])
            ofs += SMSG_ID_LEN

    def __repr__(self):
        return f"msg_smsgHave(bucket={self.bucket_time}, msgs={len(self.msg_hashes)})"


class msg_smsgWant_impl:
    __slots__ = ("bucket_time", "msg_hashes")
    msgtype = b"smsgWant"

    def __init__(self, bucket_time=0, msg_hashes=None):
        self.bucket_time = bucket_time
        self.msg_hashes = msg_hashes or []

    def serialize(self):
        r = self.bucket_time.to_bytes(8, "little")
        for mh in self.msg_hashes:
            r += mh
        return ser_string(r)

    def deserialize(self, f):
        data = deser_string(f)
        if len(data) < 8:
            return
        self.bucket_time = int.from_bytes(data[0:8], "little")
        self.msg_hashes = []
        ofs = 8
        while ofs + SMSG_ID_LEN <= len(data):
            self.msg_hashes.append(data[ofs:ofs + SMSG_ID_LEN])
            ofs += SMSG_ID_LEN

    def __repr__(self):
        return f"msg_smsgWant(bucket={self.bucket_time}, msgs={len(self.msg_hashes)})"


# ============================================================================
# Helper functions
# ============================================================================


def decode_wif_privkey(wif: str) -> bytes:
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    n = 0
    for c in wif:
        n = n * 58 + alphabet.index(c)
    return n.to_bytes(38, byteorder="big")[1:33]


def resolve_peers() -> list:
    peers = []
    for seed in DNS_SEEDS:
        try:
            ips = socket.getaddrinfo(seed, PARTICL_MAINNET_PORT, socket.AF_INET)
            for info in ips:
                peers.append((info[4][0], PARTICL_MAINNET_PORT))
            log.info(f"Resolved {len(ips)} peers from {seed}")
        except Exception as e:
            log.warning(f"Failed to resolve {seed}: {e}")
    return list(set(peers))


def format_amount(amount: int, coin_id: int) -> str:
    decimals = COIN_DECIMALS.get(coin_id, DEFAULT_DECIMALS)
    return f"{amount / (10 ** decimals):.{decimals}f}"


# ============================================================================
# BSX Offer Listener
# ============================================================================


class BSXOfferListener(P2PInterface):
    def __init__(self, network_privkey: bytes):
        super().__init__()
        self.is_part = True
        self.network_privkey = network_privkey
        self.offers = {}
        self.seen_msg_ids = set()
        self.inv_buckets = {}
        # Stats: "decrypt_errors" is kept for backward compat = not_for_us + parse_errors.
        # not_for_us = SMSGs encrypted to other recipients (not BSX) - normal background traffic.
        # parse_errors = decrypted OK but offer payload failed to parse - actual failures.
        # message_type_counts = histogram of decoded payload type bytes.
        self.stats = {"msgs_received": 0, "msgs_decrypted": 0,
                      "offers_parsed": 0, "decrypt_errors": 0,
                      "not_for_us": 0, "parse_errors": 0,
                      "message_type_counts": {}}
        # Map of offer_msg_id -> count of bid messages observed for it.
        self.bid_counts = {}
        # Map of offer_msg_id -> list of decoded bid dicts (amount, amount_to, rate, time_valid,
        # sent). Lets the orderbook expose the highest *active* open bid per offer, which takers
        # care about more than the raw count.
        self.bids_per_offer = {}
        # Offer ids the maker has explicitly revoked via OFFER_REVOKE; filtered out of the
        # published orderbook so consumers don't act on dead listings.
        self.revoked_offer_ids = set()
        # Track most-recent BSX message timestamp seen, surfaced in JSON for liveness.
        self.last_bsx_msg_ts = 0

    def on_version(self, msg):
        self.send_message(msg_verack())

    def on_verack(self, msg):
        log.info("P2P handshake complete")

    def on_ping(self, msg):
        self.send_message(msg_pong(msg.nonce))

    def on_getheaders(self, msg):
        self.send_message(msg_headers())

    def on_smsgPing(self, msg):
        log.info("SMSG handshake complete")
        self.send_message(msg_smsgPong(1))

    def on_smsgPong(self, msg):
        pass

    def on_smsgInv(self, msg):
        data = msg.data
        if len(data) < 4:
            return
        num_entries = int.from_bytes(data[0:4], "little")
        new_buckets = []
        for i in range(num_entries):
            ofs = 4 + i * 16
            if ofs + 16 > len(data):
                break
            bt = int.from_bytes(data[ofs:ofs+8], "little")
            bh = data[ofs+12:ofs+16]
            if bt not in self.inv_buckets or self.inv_buckets[bt] != bh:
                self.inv_buckets[bt] = bh
                new_buckets.append(bt)
        if new_buckets:
            log.info(f"Requesting {len(new_buckets)} buckets")
            self.send_message(msg_smsgShow_impl(bucket_times=new_buckets))

    def on_smsgHave(self, msg):
        bt = msg.bucket_time
        hashes = [h for h in msg.msg_hashes if h.hex() not in self.seen_msg_ids]
        if hashes:
            log.info(f"Requesting {len(hashes)} messages from bucket")
            self.send_message(msg_smsgWant_impl(bucket_time=bt, msg_hashes=hashes))

    def on_smsgShow(self, msg):
        pass

    def on_smsgWant(self, msg):
        pass

    def on_smsgMsg(self, msg):
        self._process_smsg_data(msg.data)

    def on_smsgIgnore(self, msg):
        pass

    def on_smsgDisabled(self, msg):
        log.warning("Peer has SMSG disabled")


    def _process_smsg_data(self, data: bytes):
        ofs = 0
        while ofs < len(data):
            if ofs + SMSG_HDR_LEN > len(data):
                break
            ct_len = int.from_bytes(data[ofs + 104:ofs + 108], "little")
            msg_len = SMSG_HDR_LEN + ct_len
            if ofs + msg_len > len(data):
                break
            smsg_msg = data[ofs:ofs + msg_len]
            ofs += msg_len
            self.stats["msgs_received"] += 1
            msg_id = smsg_get_id(smsg_msg).hex()
            self.seen_msg_ids.add(msg_id)

            try:
                result = smsg_decrypt(self.network_privkey, smsg_msg)
            except AssertionError:
                # MAC mismatch = SMSG was encrypted to a different recipient pubkey
                # (private chat or other app), not addressed to BSX. Not really an error.
                self.stats["not_for_us"] += 1
                self.stats["decrypt_errors"] += 1
                continue
            except Exception:
                self.stats["parse_errors"] += 1
                self.stats["decrypt_errors"] += 1
                continue

            self.stats["msgs_decrypted"] += 1
            try:
                payload_hex = result["hex"]
                msg_type = int(payload_hex[:2], 16)
                # Track every BSX message type we see (offers, bids, accepts, revokes, ...)
                label = MESSAGE_TYPE_LABELS.get(msg_type, f"type_{msg_type}")
                self.stats["message_type_counts"][label] = (
                    self.stats["message_type_counts"].get(label, 0) + 1
                )
                self.last_bsx_msg_ts = result.get("sent", self.last_bsx_msg_ts)
                # Track bid -> offer linkage so the orderbook can show "interest" per offer.
                if msg_type == MessageTypes.BID:
                    try:
                        bid_data = bytes.fromhex(payload_hex[2:])
                        bm = BidMessage(); bm.from_bytes(bid_data)
                        oid = getattr(bm, "offer_msg_id", b"")
                        if isinstance(oid, (bytes, bytearray)) and oid:
                            oid_hex = oid.hex()
                            self.bid_counts[oid_hex] = self.bid_counts.get(oid_hex, 0) + 1
                            # Capture the negotiable terms so the orderbook can surface the
                            # highest open bid (sent + time_valid drives active-bid filtering).
                            self.bids_per_offer.setdefault(oid_hex, []).append({
                                "amount": int(getattr(bm, "amount", 0) or 0),
                                "amount_to": int(getattr(bm, "amount_to", 0) or 0),
                                "rate": int(getattr(bm, "rate", 0) or 0),
                                "time_valid": int(getattr(bm, "time_valid", 0) or 0),
                                "sent": int(result.get("sent", 0) or 0),
                            })
                    except Exception:
                        pass
                    continue
                # Record explicit revocations so we can drop dead offers before publishing.
                if msg_type == MessageTypes.OFFER_REVOKE:
                    try:
                        rev_data = bytes.fromhex(payload_hex[2:])
                        rm = OfferRevokeMessage(); rm.from_bytes(rev_data)
                        oid = getattr(rm, "offer_msg_id", b"")
                        if isinstance(oid, (bytes, bytearray)) and oid:
                            self.revoked_offer_ids.add(oid.hex())
                    except Exception:
                        pass
                    continue
                if msg_type != MessageTypes.OFFER:
                    continue
                msg_data = bytes.fromhex(payload_hex[2:])
                offer = OfferMessage()
                offer.from_bytes(msg_data)
                coin_from = getattr(offer, "coin_from", None)
                coin_to = getattr(offer, "coin_to", None)
                if coin_from is None or coin_to is None:
                    continue
                ticker_from = COIN_TICKERS.get(coin_from, f"?{coin_from}")
                ticker_to = COIN_TICKERS.get(coin_to, f"?{coin_to}")
                amount_from = getattr(offer, "amount_from", 0)
                amount_to = getattr(offer, "amount_to", 0)
                min_bid = getattr(offer, "min_bid_amount", 0)
                # Proof address is a length-prefixed string field; decode to ascii if ascii-safe.
                proof_addr_raw = getattr(offer, "proof_address", b"")
                proof_addr = ""
                if isinstance(proof_addr_raw, (bytes, bytearray)) and proof_addr_raw:
                    try:
                        proof_addr = proof_addr_raw.decode("ascii")
                    except UnicodeDecodeError:
                        proof_addr = proof_addr_raw.hex()
                self.offers[msg_id] = {
                    "msg_id": msg_id,
                    "timestamp": result.get("sent", 0),
                    "protocol_version": getattr(offer, "protocol_version", 0),
                    "coin_from": ticker_from,
                    "coin_to": ticker_to,
                    "coin_from_id": coin_from,
                    "coin_to_id": coin_to,
                    "amount_from": amount_from,
                    "amount_to": amount_to,
                    "amount_from_str": format_amount(amount_from, coin_from),
                    "amount_to_str": format_amount(amount_to, coin_to),
                    "min_bid_amount": min_bid,
                    "min_bid_amount_str": format_amount(min_bid, coin_from),
                    "swap_type": getattr(offer, "swap_type", 0),
                    "lock_type": getattr(offer, "lock_type", 0),
                    "lock_value": getattr(offer, "lock_value", 0),
                    "fee_rate_from": getattr(offer, "fee_rate_from", 0),
                    "fee_rate_to": getattr(offer, "fee_rate_to", 0),
                    "amount_negotiable": bool(getattr(offer, "amount_negotiable", 0)),
                    "rate_negotiable": bool(getattr(offer, "rate_negotiable", 0)),
                    "auto_accept_type": getattr(offer, "auto_accept_type", 0),
                    "time_valid": getattr(offer, "time_valid", 0),
                    "rate": amount_to / amount_from if amount_from > 0 else 0,
                    "proof_address": proof_addr,
                    "addr_from": result.get("addr_from", ""),
                }
                self.stats["offers_parsed"] += 1
                log.info(f"  OFFER: {ticker_from}->{ticker_to} "
                         f"amt={format_amount(amount_from, coin_from)} "
                         f"id={msg_id[:16]}...")
            except Exception:
                self.stats["parse_errors"] += 1

        log.info(f"  Processed batch: {self.stats['offers_parsed']} offers, "
                 f"{self.stats['msgs_decrypted']} decrypted, "
                 f"{self.stats['msgs_received']} total")

    def get_orderbook_dict(self, anonymize_makers: bool = False) -> dict:
        now = int(time.time())
        # Tolerate listeners constructed without going through __init__ (test fixtures).
        revoked = getattr(self, "revoked_offer_ids", set()) or set()
        bids_per_offer = getattr(self, "bids_per_offer", {}) or {}
        offers = []
        revoked_dropped = 0
        for o in self.offers.values():
            if o.get("msg_id", "") in revoked:
                revoked_dropped += 1
                continue
            o2 = dict(o)
            # Attach observed bid count for this offer (defaults to 0 when no BIDs seen).
            mid = o2.get("msg_id", "")
            o2["bid_count"] = self.bid_counts.get(mid, 0)
            # Compute the highest *active* open bid (max amount_to, the side the maker receives).
            # Active = sent + time_valid > now. Falls back to None if no live bids.
            best, active_n = None, 0
            for bd in bids_per_offer.get(mid, []):
                exp = bd["sent"] + bd["time_valid"]
                if exp <= now:
                    continue
                active_n += 1
                if best is None or bd["amount_to"] > best["amount_to"]:
                    best = {**bd, "expires_in_s": exp - now}
            if best is not None:
                cf, ct = o2.get("coin_from_id"), o2.get("coin_to_id")
                o2["highest_bid"] = {
                    "amount": best["amount"],
                    "amount_to": best["amount_to"],
                    "amount_str": format_amount(best["amount"], cf) if cf else "",
                    "amount_to_str": format_amount(best["amount_to"], ct) if ct else "",
                    "expires_in_s": best["expires_in_s"],
                    "active_bid_count": active_n,
                }
            else:
                o2["highest_bid"] = None
            if anonymize_makers and o2.get("addr_from"):
                a = o2["addr_from"]
                # Keep first 4 / last 4 of the base58 address; preserves uniqueness signal
                # without publishing the full identifier.
                o2["addr_from"] = (a[:4] + "…" + a[-4:]) if len(a) > 9 else a
            offers.append(o2)
        unique_makers = len({o.get("addr_from", "") for o in offers if o.get("addr_from")})
        unique_pairs = len({
            tuple(sorted([o.get("coin_from", ""), o.get("coin_to", "")]))
            for o in offers if o.get("coin_from") and o.get("coin_to")
        })
        active = sum(1 for o in offers if (o.get("timestamp", 0) + o.get("time_valid", 0)) > now)
        # Record how many offers were suppressed so /health and the UI can show coverage.
        self.stats["revoked_offers_dropped"] = revoked_dropped
        return {
            "timestamp": now,
            "updated_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(now)),
            "num_offers": len(offers),
            "active_offers": active,
            "unique_makers": unique_makers,
            "unique_pairs": unique_pairs,
            "last_bsx_msg_ts": self.last_bsx_msg_ts,
            "stats": self.stats,
            "offers": offers,
        }

    def get_orderbook_json(self, anonymize_makers: bool = False) -> str:
        return json.dumps(self.get_orderbook_dict(anonymize_makers), indent=2)



# ============================================================================
# Main
# ============================================================================


def main():
    parser = argparse.ArgumentParser(description="BSX Orderbook Scraper")
    parser.add_argument("--peer", help="Particl node IP:port")
    parser.add_argument("--auto", action="store_true", help="Auto-discover peers via DNS")
    parser.add_argument("-o", "--output", help="Output JSON file path")
    parser.add_argument("--duration", type=int, default=15, help="Seconds to listen (default: 15)")
    parser.add_argument("--debug", action="store_true", help="Debug logging")
    parser.add_argument("--anonymize-makers", action="store_true",
                        help="Truncate maker addresses in published JSON (privacy mode)")
    parser.add_argument("--history-dir",
                        help="If set, also write a timestamped snapshot file under this dir "
                             "and update <history-dir>/manifest.json")
    parser.add_argument("--health-file",
                        help="If set, write a small liveness JSON (last-run + msg rate) here")
    args = parser.parse_args()

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    # Decode network key
    privkey = decode_wif_privkey(NETWORK_KEY_WIF)

    # Build the candidate peer list. --auto used to pick only the first resolved peer; we now
    # try each in turn so a single dead/refused IP doesn't abort the whole scrape.
    if args.peer:
        parts = args.peer.split(":")
        candidates = [(parts[0], int(parts[1]) if len(parts) > 1 else PARTICL_MAINNET_PORT)]
    elif args.auto:
        candidates = resolve_peers()
        if not candidates:
            log.error("No peers found"); return 1
        log.info(f"Resolved {len(candidates)} candidate peer(s)")
    else:
        parser.print_help()
        print("\nSpecify --peer or --auto")
        return 1

    # Patch MESSAGEMAP with our SMSG implementations
    MESSAGEMAP[b"smsgShow"] = msg_smsgShow_impl
    MESSAGEMAP[b"smsgHave"] = msg_smsgHave_impl
    MESSAGEMAP[b"smsgWant"] = msg_smsgWant_impl

    # Connect
    net = NetworkThread()
    net.start()
    listener = None
    connected = False

    try:
        for idx, (cand_ip, cand_port) in enumerate(candidates):
            log.info(f"[{idx + 1}/{len(candidates)}] Trying peer {cand_ip}:{cand_port}")
            listener = BSXOfferListener(privkey)
            listener.p2p_connected_to_node = True
            try:
                listener.peer_connect(
                    dstaddr=cand_ip, dstport=cand_port,
                    services=NODE_NETWORK | NODE_WITNESS | NODE_SMSG,
                    send_version=True, net="mainnet",
                    timeout_factor=1, supports_v2_p2p=False,
                )()
                listener.wait_for_connect(timeout=8)
                listener.wait_for_verack(timeout=8)
            except (AssertionError, OSError, ConnectionError) as e:
                log.warning(f"  peer failed ({type(e).__name__}); trying next")
                try:
                    listener.peer_disconnect()
                except Exception:
                    pass
                continue

            listener.send_message(msg_smsgPing())
            log.info(f"Connected to {cand_ip}:{cand_port}. Listening for {args.duration}s...")
            connected = True
            for _ in range(args.duration):
                time.sleep(1)
            break

        if not connected:
            log.error(f"All {len(candidates)} peer(s) failed to connect")
            return 1

    except KeyboardInterrupt:
        log.info("Interrupted")
    finally:
        net.close()
        time.sleep(0.5)

    # Output
    started_ts = int(time.time()) - args.duration
    book_dict = listener.get_orderbook_dict(anonymize_makers=args.anonymize_makers)
    orderbook = json.dumps(book_dict, indent=2)
    if args.output:
        with open(args.output, "w") as f:
            f.write(orderbook)
        log.info(f"Saved {len(listener.offers)} offers to {args.output}")
    else:
        print(orderbook)

    # Snapshot manifest: <history-dir>/<UTC-iso>.json + manifest.json with last 200 entries.
    if args.history_dir:
        try:
            os.makedirs(args.history_dir, exist_ok=True)
            snap_name = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + ".json"
            snap_path = os.path.join(args.history_dir, snap_name)
            with open(snap_path, "w") as f:
                f.write(orderbook)
            manifest_path = os.path.join(args.history_dir, "manifest.json")
            try:
                with open(manifest_path) as f:
                    manifest = json.load(f)
            except Exception:
                manifest = {"snapshots": []}
            # Per-pair offer counts (canonical pair = sorted ticker pair) so the
            # UI can draw per-pair sparklines without fetching every snapshot file.
            pair_counts = {}
            for o in book_dict.get("offers", []):
                cf, ct = o.get("coin_from"), o.get("coin_to")
                if not cf or not ct:
                    continue
                key = "/".join(sorted([cf, ct]))
                pair_counts[key] = pair_counts.get(key, 0) + 1
            manifest.setdefault("snapshots", []).append({
                "file": snap_name, "ts": book_dict["timestamp"],
                "num_offers": book_dict["num_offers"],
                "active_offers": book_dict.get("active_offers", 0),
                "pair_counts": pair_counts,
            })
            manifest["snapshots"] = manifest["snapshots"][-200:]
            with open(manifest_path, "w") as f:
                json.dump(manifest, f, indent=2)
            log.info(f"Wrote snapshot {snap_name} + updated manifest")
        except Exception as e:
            log.warning(f"history-dir write failed: {e}")

    if args.health_file:
        try:
            duration = max(1, int(time.time()) - started_ts)
            health = {
                "last_run_ts": book_dict["timestamp"],
                "last_run_iso": book_dict["updated_at"],
                "last_bsx_msg_ts": listener.last_bsx_msg_ts,
                "duration_s": duration,
                "msgs_received": listener.stats.get("msgs_received", 0),
                "msgs_decrypted": listener.stats.get("msgs_decrypted", 0),
                "offers_parsed": listener.stats.get("offers_parsed", 0),
                "msg_rate_per_s": round(listener.stats.get("msgs_received", 0) / duration, 3),
                "ok": True,
            }
            with open(args.health_file, "w") as f:
                json.dump(health, f, indent=2)
        except Exception as e:
            log.warning(f"health-file write failed: {e}")

    log.info(f"Done. {listener.stats}")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
