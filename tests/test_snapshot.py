"""Validate the on-disk snapshot (orderbook.json) against the schema the UI
expects, and exercise the anonymisation / bid-count attachment paths on
``BSXOfferListener.get_orderbook_dict``.

These tests skip cleanly when ``orderbook.json`` is absent or when the
runtime deps aren't installed.
"""
import json
import os

import pytest

pytest.importorskip("coincurve")
pytest.importorskip("Crypto")

import scraper  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SNAPSHOT = os.path.join(os.path.dirname(HERE), "orderbook.json")

REQUIRED_TOPLEVEL = {
    "timestamp", "updated_at", "num_offers", "active_offers",
    "unique_makers", "unique_pairs", "stats", "offers",
}
# These per-offer keys are consumed by the UI in app.js.
REQUIRED_OFFER_KEYS = {
    "msg_id", "timestamp", "coin_from", "coin_to",
    "amount_from", "amount_to", "amount_from_str", "amount_to_str",
    "rate", "swap_type", "time_valid", "addr_from", "bid_count",
    "min_bid_amount_str", "amount_negotiable", "rate_negotiable",
    "lock_type", "lock_value", "fee_rate_from", "fee_rate_to",
    "auto_accept_type", "proof_address", "protocol_version",
}


@pytest.fixture(scope="module")
def snapshot():
    if not os.path.exists(SNAPSHOT):
        pytest.skip("orderbook.json absent; run `scraper.py --auto -o orderbook.json`")
    with open(SNAPSHOT) as f:
        return json.load(f)


def test_snapshot_toplevel_schema(snapshot):
    missing = REQUIRED_TOPLEVEL - set(snapshot.keys())
    assert not missing, f"orderbook.json missing top-level keys: {missing}"
    assert isinstance(snapshot["offers"], list)
    assert snapshot["num_offers"] == len(snapshot["offers"])


def test_snapshot_per_offer_schema(snapshot):
    if not snapshot["offers"]:
        pytest.skip("snapshot has no offers")
    sample = snapshot["offers"][0]
    missing = REQUIRED_OFFER_KEYS - set(sample.keys())
    assert not missing, f"offer missing keys consumed by app.js: {missing}"


def test_snapshot_amount_strings_are_numeric(snapshot):
    """amount_from_str / amount_to_str must round-trip through float()."""
    for o in snapshot["offers"][:25]:
        float(o["amount_from_str"])  # raises ValueError if malformed
        float(o["amount_to_str"])
        if o.get("min_bid_amount_str"):
            float(o["min_bid_amount_str"])


def test_snapshot_active_offers_count(snapshot):
    """active_offers must equal a fresh recomputation against the wire data."""
    now = snapshot["timestamp"]
    expected = sum(
        1 for o in snapshot["offers"]
        if (o.get("timestamp", 0) + o.get("time_valid", 0)) > now
    )
    assert snapshot["active_offers"] == expected


def test_snapshot_unique_counts_match(snapshot):
    addrs = {o["addr_from"] for o in snapshot["offers"] if o.get("addr_from")}
    pairs = {
        tuple(sorted([o["coin_from"], o["coin_to"]]))
        for o in snapshot["offers"]
        if o.get("coin_from") and o.get("coin_to")
    }
    assert snapshot["unique_makers"] == len(addrs)
    assert snapshot["unique_pairs"] == len(pairs)


def test_snapshot_stats_message_type_histogram(snapshot):
    """The histogram must be a dict[str,int]; offer count >= len(offers)."""
    mt = snapshot["stats"].get("message_type_counts", {})
    assert isinstance(mt, dict)
    for k, v in mt.items():
        assert isinstance(k, str) and isinstance(v, int) and v >= 0
    if snapshot["offers"]:
        # We saw at least as many OFFER messages as we have offers in the book.
        assert mt.get("offer", 0) >= len(snapshot["offers"])


# -----------------------------------------------------------------------------
# get_orderbook_dict() in-memory behaviour
# -----------------------------------------------------------------------------

def _fake_listener_with_offers():
    """Construct a listener without bringing up the P2PInterface machinery."""
    listener = scraper.BSXOfferListener.__new__(scraper.BSXOfferListener)
    listener.offers = {
        "id-A": {"msg_id": "id-A", "timestamp": 1, "time_valid": 0,
                 "coin_from": "BTC", "coin_to": "XMR",
                 "addr_from": "PparticlAddressFullForLength12345"},
        # "PshortAdd" is exactly 9 chars - the threshold below which
        # the anonymiser leaves the address untouched.
        "id-B": {"msg_id": "id-B", "timestamp": 1, "time_valid": 0,
                 "coin_from": "LTC", "coin_to": "XMR",
                 "addr_from": "PshortAdd"},
    }
    listener.bid_counts = {"id-A": 7}
    listener.last_bsx_msg_ts = 0
    listener.stats = {"msgs_received": 0, "msgs_decrypted": 0,
                      "offers_parsed": 2, "decrypt_errors": 0,
                      "not_for_us": 0, "parse_errors": 0,
                      "message_type_counts": {}}
    return listener


def test_bid_counts_attached_to_offers():
    out = _fake_listener_with_offers().get_orderbook_dict()
    by_id = {o["msg_id"]: o for o in out["offers"]}
    assert by_id["id-A"]["bid_count"] == 7
    assert by_id["id-B"]["bid_count"] == 0


def test_anonymize_makers_truncates_addresses():
    out = _fake_listener_with_offers().get_orderbook_dict(anonymize_makers=True)
    by_id = {o["msg_id"]: o for o in out["offers"]}
    a = by_id["id-A"]["addr_from"]
    assert "…" in a and len(a) == 9     # first 4 + ellipsis + last 4
    assert a.startswith("Ppar") and a.endswith("2345")
    # Addresses at or below the 9-char threshold are passed through unchanged.
    assert by_id["id-B"]["addr_from"] == "PshortAdd"


def test_anonymize_disabled_keeps_full_address():
    out = _fake_listener_with_offers().get_orderbook_dict(anonymize_makers=False)
    by_id = {o["msg_id"]: o for o in out["offers"]}
    assert by_id["id-A"]["addr_from"] == "PparticlAddressFullForLength12345"


def test_revoked_offers_are_dropped_and_counted():
    """Offers whose msg_id appears in revoked_offer_ids must be excluded from the
    published orderbook and tallied in stats.revoked_offers_dropped."""
    listener = _fake_listener_with_offers()
    listener.revoked_offer_ids = {"id-B"}
    out = listener.get_orderbook_dict()
    ids = {o["msg_id"] for o in out["offers"]}
    assert ids == {"id-A"}
    assert out["num_offers"] == 1
    assert out["stats"]["revoked_offers_dropped"] == 1


def test_revoke_filter_tolerates_missing_attribute():
    """Listeners built without __init__ (older test fixtures, partial deserialisation)
    must not crash get_orderbook_dict — the attribute defaults to empty."""
    listener = _fake_listener_with_offers()
    # Intentionally don't set revoked_offer_ids — emulate pre-init / legacy state.
    out = listener.get_orderbook_dict()
    assert out["num_offers"] == 2
    assert out["stats"]["revoked_offers_dropped"] == 0


def _maker_key_and_address():
    """Deterministic Particl P2PKH keypair for signing revoke messages in tests."""
    from coincurve.keys import PrivateKey
    k = PrivateKey(b"\x01" * 32)
    pkh = scraper.hash160(k.public_key.format(compressed=True))
    return k, scraper.pkh_to_address(b"\x38" + pkh)


def _sign_message(privkey, message: str) -> bytes:
    """Produce a Bitcoin-style 65-byte compact signature (compressed key)."""
    sig = privkey.sign_recoverable(
        scraper.signed_message_hash(message.encode()), hasher=None
    )  # r||s||recid
    return bytes([31 + sig[64]]) + sig[:64]


def test_revoke_with_valid_signature_drops_offer():
    """A revoke request is only honoured when its signature over
    "<offer_msg_id>_revoke" verifies against the offer's addr_from."""
    key, addr = _maker_key_and_address()
    listener = _fake_listener_with_offers()
    listener.offers["id-A"]["addr_from"] = addr
    listener.revoke_requests = {"id-A": _sign_message(key, "id-A_revoke")}
    out = listener.get_orderbook_dict()
    assert {o["msg_id"] for o in out["offers"]} == {"id-B"}
    assert out["stats"]["revoked_offers_dropped"] == 1
    assert out["stats"]["revokes_invalid_sig"] == 0


def test_revoke_with_invalid_signature_keeps_offer():
    """Revokes signed by a third party (address mismatch) must be ignored and
    counted, so they can't censor live offers off the orderbook."""
    key, _addr = _maker_key_and_address()
    listener = _fake_listener_with_offers()
    # Offer's addr_from is NOT the signer's address.
    listener.revoke_requests = {
        "id-A": _sign_message(key, "id-A_revoke"),  # wrong signer
        "id-B": b"\x00" * 65,                       # garbage signature
    }
    out = listener.get_orderbook_dict()
    assert {o["msg_id"] for o in out["offers"]} == {"id-A", "id-B"}
    assert out["stats"]["revoked_offers_dropped"] == 0
    assert out["stats"]["revokes_invalid_sig"] == 2


def test_bid_message_parses_extended_fields():
    """BidMessage must decode amount / amount_to / rate / time_valid alongside offer_msg_id."""
    fake_offer_id = bytes.fromhex("cd" * 28)
    # Tag = (field_num << 3) | wire_type. Field 4 (amount) varint => tag 0x20.
    # Field 9 (amount_to) varint => tag 0x48. Field 10 (rate) varint => tag 0x50.
    # Field 3 (time_valid) varint => tag 0x18. Field 2 (offer_msg_id) bytes => tag 0x12.
    payload = (
        b"\x12" + bytes([len(fake_offer_id)]) + fake_offer_id
        + b"\x18" + b"\xb4\x60"      # time_valid = 12340
        + b"\x20" + b"\x80\xad\xe2\x04"  # amount = 10_000_000 (0.1 BTC)
        + b"\x48" + b"\xc0\xc4\x07"      # amount_to = 123_456 (XMR atomic)
        + b"\x50" + b"\x95\x9a\xef\x3a"  # rate = 123456789
    )
    bm = scraper.BidMessage()
    bm.from_bytes(payload)
    assert getattr(bm, "offer_msg_id", b"").hex() == "cd" * 28
    assert getattr(bm, "amount", 0) == 10_000_000
    assert getattr(bm, "amount_to", 0) == 123_456
    assert getattr(bm, "rate", 0) == 123_456_789
    assert getattr(bm, "time_valid", 0) == 12340


def test_highest_bid_aggregated_per_offer():
    """get_orderbook_dict must surface the largest active (non-expired) bid per offer."""
    import time as _time
    listener = _fake_listener_with_offers()
    listener.offers["id-A"]["coin_from_id"] = 1   # PART
    listener.offers["id-A"]["coin_to_id"] = 6     # XMR
    now = int(_time.time())
    listener.bids_per_offer = {
        "id-A": [
            # Live: small bid
            {"amount": 100_000_000, "amount_to": 50_000_000_000,
             "rate": 0, "time_valid": 3600, "sent": now - 60},
            # Live: bigger bid - should win.
            {"amount": 200_000_000, "amount_to": 90_000_000_000,
             "rate": 0, "time_valid": 3600, "sent": now - 120},
            # Already expired - must be ignored.
            {"amount": 999_000_000_000, "amount_to": 999_000_000_000_000,
             "rate": 0, "time_valid": 60, "sent": now - 7200},
        ],
    }
    out = listener.get_orderbook_dict()
    by_id = {o["msg_id"]: o for o in out["offers"]}
    hb = by_id["id-A"]["highest_bid"]
    assert hb is not None
    assert hb["amount_to"] == 90_000_000_000
    assert hb["active_bid_count"] == 2
    assert hb["expires_in_s"] > 0
    # No bids tracked for id-B => highest_bid is None.
    assert by_id["id-B"]["highest_bid"] is None


def test_highest_bid_tolerates_missing_attribute():
    """Listeners built without bids_per_offer (legacy / partial state) must not crash."""
    listener = _fake_listener_with_offers()
    out = listener.get_orderbook_dict()
    for o in out["offers"]:
        assert o["highest_bid"] is None


def test_offer_revoke_message_parser_round_trip():
    """OfferRevokeMessage.from_bytes must extract offer_msg_id from the standard
    tag-prefixed wire format used by basicswap.messages_npb."""
    # Field 1, wire type 2 (LEN): tag = (1<<3)|2 = 0x0a, then length, then bytes.
    fake_offer_id = bytes.fromhex("aa" * 28)
    fake_sig = bytes.fromhex("bb" * 65)
    payload = (
        b"\x0a" + bytes([len(fake_offer_id)]) + fake_offer_id
        + b"\x12" + bytes([len(fake_sig)]) + fake_sig
    )
    rm = scraper.OfferRevokeMessage()
    rm.from_bytes(payload)
    assert getattr(rm, "offer_msg_id", b"").hex() == "aa" * 28
    assert getattr(rm, "signature", b"") == fake_sig
