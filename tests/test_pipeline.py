"""End-to-end pipeline tests: build real encrypted SMSG envelopes (as a peer
would deliver them), feed them through BSXOfferListener._process_smsg_data,
and check offers appear / revokes drop them - no network required.

Also covers the Phase-1/2 helpers: atomic writes, PKCS7 validation,
legacy-id lookup, and merge_previous_offers.
"""
import hashlib
import hmac as hmac_mod
import json
import os
import time

import pytest

pytest.importorskip("coincurve")
pytest.importorskip("Crypto")

from coincurve.keys import PrivateKey  # noqa: E402
from Crypto.Cipher import AES  # noqa: E402

import scraper  # noqa: E402


# -----------------------------------------------------------------------------
# SMSG envelope construction (mirror of scraper.smsg_decrypt, encrypt side)
# -----------------------------------------------------------------------------

NETWORK_PRIVKEY = scraper.decode_wif_privkey(scraper.NETWORK_KEY_WIF)
NETWORK_PUBKEY = PrivateKey(NETWORK_PRIVKEY).public_key.format(compressed=True)


def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _varint_field(field_num: int, value: int) -> bytes:
    return _varint((field_num << 3) | 0) + _varint(value)


def _len_field(field_num: int, raw: bytes) -> bytes:
    return _varint((field_num << 3) | 2) + _varint(len(raw)) + raw


def build_smsg_envelope(payload: bytes, pkh_from: bytes, ts: int,
                        eph_seed: bytes = b"\x02" * 32) -> bytes:
    """Encrypt `payload` (type byte + protobuf) into a full SMSG wire message
    addressed to the BSX network key, matching scraper.smsg_decrypt's layout."""
    # Plaintext v1: version byte + pkh_from(20) + signature(65) + payload_len(4) + payload
    plaintext = bytes([1]) + pkh_from + b"\x00" * 65 + len(payload).to_bytes(4, "little") + payload

    eph = PrivateKey(eph_seed)
    R = eph.public_key.format(compressed=True)
    shared = eph.ecdh(NETWORK_PUBKEY)
    H = hashlib.sha512(shared).digest()
    key_e, key_m = H[:32], H[32:]

    iv = bytes(range(16))
    pad_len = 16 - (len(plaintext) % 16) or 16
    padded = plaintext + bytes([pad_len]) * pad_len
    ciphertext = AES.new(key_e, AES.MODE_CBC, iv).encrypt(padded)

    mac = hmac_mod.new(key_m, digestmod="SHA256")
    mac.update(ts.to_bytes(8, "little"))
    mac.update(iv)
    mac.update(ciphertext)

    hdr = bytearray(scraper.SMSG_HDR_LEN)
    hdr[11:19] = ts.to_bytes(8, "little")
    hdr[23:39] = iv
    hdr[39:72] = R
    hdr[72:104] = mac.digest()
    hdr[104:108] = len(ciphertext).to_bytes(4, "little")
    return bytes(hdr) + ciphertext


def make_maker():
    """Maker keypair whose Particl address matches the pkh embedded in envelopes."""
    key = PrivateKey(b"\x07" * 32)
    pkh = scraper.hash160(key.public_key.format(compressed=True))
    return key, pkh, scraper.pkh_to_address(b"\x38" + pkh)


def sign_revoke(privkey, message: str) -> bytes:
    sig = privkey.sign_recoverable(
        scraper.signed_message_hash(message.encode()), hasher=None)
    return bytes([31 + sig[64]]) + sig[:64]


def offer_payload() -> bytes:
    proto = (
        _varint_field(1, 4)                     # protocol_version
        + _varint_field(2, 2)                   # coin_from = BTC
        + _varint_field(3, 6)                   # coin_to = XMR
        + _varint_field(4, 100_000_000)         # amount_from = 1 BTC
        + _varint_field(5, 50_000_000_000_000)  # amount_to = 50 XMR
        + _varint_field(6, 1_000_000)           # min_bid_amount
        + _varint_field(7, 3600)                # time_valid
        + _varint_field(10, 5)                  # swap_type
    )
    return bytes([scraper.MessageTypes.OFFER]) + proto


def fresh_listener():
    return scraper.BSXOfferListener(NETWORK_PRIVKEY)


# -----------------------------------------------------------------------------
# End-to-end: offer envelope -> parsed offer
# -----------------------------------------------------------------------------

def test_encrypted_offer_roundtrip():
    _, pkh, addr = make_maker()
    ts = int(time.time())
    env = build_smsg_envelope(offer_payload(), pkh, ts)
    listener = fresh_listener()
    listener._process_smsg_data(env)

    assert listener.stats["msgs_received"] == 1
    assert listener.stats["msgs_decrypted"] == 1
    assert listener.stats["offers_parsed"] == 1
    assert listener.stats["parse_errors"] == 0
    (offer,) = listener.offers.values()
    assert offer["coin_from"] == "BTC" and offer["coin_to"] == "XMR"
    assert offer["amount_from"] == 100_000_000
    assert offer["addr_from"] == addr
    assert offer["timestamp"] == ts
    # msg_id must be the canonical big-endian form.
    assert offer["msg_id"] == scraper.smsg_get_id(env).hex()


def test_encrypted_revoke_drops_offer_end_to_end():
    key, pkh, _addr = make_maker()
    ts = int(time.time())
    offer_env = build_smsg_envelope(offer_payload(), pkh, ts, eph_seed=b"\x02" * 32)
    offer_id = scraper.smsg_get_id(offer_env)

    sig = sign_revoke(key, offer_id.hex() + "_revoke")
    revoke_proto = _len_field(1, offer_id) + _len_field(2, sig)
    revoke_payload = bytes([scraper.MessageTypes.OFFER_REVOKE]) + revoke_proto
    revoke_env = build_smsg_envelope(revoke_payload, pkh, ts + 1, eph_seed=b"\x03" * 32)

    listener = fresh_listener()
    listener._process_smsg_data(offer_env + revoke_env)

    assert listener.stats["revokes_seen"] == 1
    book = listener.get_orderbook_dict()
    assert book["num_offers"] == 0
    assert book["stats"]["revoked_offers_dropped"] == 1
    assert book["stats"]["revokes_matched_offer"] == 1
    assert book["stats"]["revokes_orphan"] == 0
    assert book["stats"]["revokes_invalid_sig"] == 0


def test_orphan_revoke_counted():
    """A revoke whose offer we never saw must count as orphan, not invalid."""
    listener = fresh_listener()
    listener.revoke_requests["ab" * 28] = b"\x00" * 65
    book = listener.get_orderbook_dict()
    assert book["stats"]["revokes_orphan"] == 1
    assert book["stats"]["revokes_matched_offer"] == 0
    assert book["stats"]["revokes_invalid_sig"] == 0


def test_third_party_revoke_end_to_end_is_rejected():
    """Revoke signed by a key that is not the offer's maker must be ignored."""
    _, pkh, _ = make_maker()
    attacker = PrivateKey(b"\x09" * 32)
    ts = int(time.time())
    offer_env = build_smsg_envelope(offer_payload(), pkh, ts)
    offer_id = scraper.smsg_get_id(offer_env)

    listener = fresh_listener()
    listener._process_smsg_data(offer_env)
    listener.revoke_requests[offer_id.hex()] = sign_revoke(
        attacker, offer_id.hex() + "_revoke")

    book = listener.get_orderbook_dict()
    assert book["num_offers"] == 1
    assert book["stats"]["revoked_offers_dropped"] == 0
    assert book["stats"]["revokes_invalid_sig"] == 1


# -----------------------------------------------------------------------------
# Helpers: PKCS7, atomic writes, legacy lookup
# -----------------------------------------------------------------------------

def test_aes_decrypt_rejects_bad_padding():
    key, iv = b"\x01" * 32, b"\x02" * 16
    # Craft ciphertext whose plaintext ends with an invalid pad byte (0x00).
    bad_plain = b"A" * 15 + b"\x00"
    ct = AES.new(key, AES.MODE_CBC, iv).encrypt(bad_plain)
    with pytest.raises(ValueError):
        scraper.aes_decrypt(ct, key, iv)


def test_aes_decrypt_roundtrip_valid_padding():
    key, iv = b"\x01" * 32, b"\x02" * 16
    plain = b"hello world"
    pad = 16 - len(plain) % 16
    ct = AES.new(key, AES.MODE_CBC, iv).encrypt(plain + bytes([pad]) * pad)
    assert scraper.aes_decrypt(ct, key, iv) == plain


def test_write_json_atomic(tmp_path):
    path = str(tmp_path / "out.json")
    scraper.write_json_atomic(path, {"a": 1})
    with open(path) as f:
        assert json.load(f) == {"a": 1}
    # No stray temp files left behind.
    assert os.listdir(tmp_path) == ["out.json"]


def test_lookup_by_offer_id_matches_legacy_form():
    canonical = ("00" * 7 + "01") + "cd" * 20
    legacy = scraper.legacy_to_canonical_id(canonical)  # involution: swaps back
    mapping = {legacy: "value"}
    val, key = scraper.lookup_by_offer_id(mapping, canonical)
    assert val == "value" and key == legacy
    assert scraper.lookup_by_offer_id({}, canonical) == (None, None)
    assert scraper.lookup_by_offer_id(mapping, "") == (None, None)


# -----------------------------------------------------------------------------
# merge_previous_offers
# -----------------------------------------------------------------------------

def test_merge_previous_offers(tmp_path):
    now = int(time.time())
    prev = {
        "offers": [
            # Still active -> carried over (derived fields stripped).
            {"msg_id": "keep-1", "timestamp": now - 60, "time_valid": 3600,
             "coin_from": "BTC", "coin_to": "XMR",
             "bid_count": 3, "highest_bid": {"amount": 1}},
            # Expired -> dropped.
            {"msg_id": "old-1", "timestamp": now - 7200, "time_valid": 60},
            # Collides with a freshly scraped offer -> fresh wins.
            {"msg_id": "dup-1", "timestamp": now - 60, "time_valid": 3600,
             "coin_from": "LTC", "coin_to": "XMR"},
        ]
    }
    path = str(tmp_path / "prev.json")
    with open(path, "w") as f:
        json.dump(prev, f)

    listener = fresh_listener()
    listener.offers["dup-1"] = {"msg_id": "dup-1", "timestamp": now,
                                "time_valid": 3600, "coin_from": "FRESH", "coin_to": "XMR"}
    merged = scraper.merge_previous_offers(listener, path)

    assert merged == 1
    assert set(listener.offers) == {"keep-1", "dup-1"}
    assert listener.offers["dup-1"]["coin_from"] == "FRESH"
    carried = listener.offers["keep-1"]
    assert "bid_count" not in carried and "highest_bid" not in carried
    assert listener.stats["offers_merged_from_previous"] == 1


def test_merge_previous_offers_missing_file():
    listener = fresh_listener()
    assert scraper.merge_previous_offers(listener, "/nonexistent/prev.json") == 0
    assert listener.offers == {}
