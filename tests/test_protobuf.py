"""Tests for the inlined protobuf parsers (OfferMessage, BidMessage)."""
import pytest

pytest.importorskip("coincurve")
pytest.importorskip("Crypto")

from scraper import BidMessage, MESSAGE_TYPE_LABELS, MessageTypes, OfferMessage  # noqa: E402


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


def _field(field_num: int, wire_type: int, payload: bytes) -> bytes:
    tag = (field_num << 3) | wire_type
    return _varint(tag) + payload


def _varint_field(field_num: int, value: int) -> bytes:
    return _field(field_num, 0, _varint(value))


def _len_field(field_num: int, raw: bytes) -> bytes:
    return _field(field_num, 2, _varint(len(raw)) + raw)


def test_offer_message_basic_fields():
    """OFFER protobuf with the most common fields."""
    payload = (
        _varint_field(1, 2)                       # protocol_version=2
        + _varint_field(2, 2)                     # coin_from=BTC
        + _varint_field(3, 6)                     # coin_to=XMR
        + _varint_field(4, 100_000_000)           # amount_from=1 BTC
        + _varint_field(5, 50_000_000_000_000)    # amount_to=50 XMR
        + _varint_field(6, 1_000_000)             # min_bid_amount
        + _varint_field(7, 3600)                  # time_valid=1h
        + _varint_field(8, 1)                     # lock_type=Seq blocks
        + _varint_field(9, 144)                   # lock_value=144
        + _varint_field(10, 5)                    # swap_type=Adaptor sig
        + _len_field(11, b"PaddrPaddrPaddrPaddr")  # proof_address
    )
    o = OfferMessage()
    o.from_bytes(payload)
    assert o.protocol_version == 2
    assert o.coin_from == 2
    assert o.coin_to == 6
    assert o.amount_from == 100_000_000
    assert o.amount_to == 50_000_000_000_000
    assert o.min_bid_amount == 1_000_000
    assert o.time_valid == 3600
    assert o.lock_type == 1
    assert o.lock_value == 144
    assert o.swap_type == 5
    assert o.proof_address == b"PaddrPaddrPaddrPaddr"


def test_offer_message_skips_unknown_fields():
    """Forward-compat: a future protobuf field number should not break parsing."""
    payload = (
        _varint_field(2, 2)
        + _varint_field(3, 6)
        + _varint_field(99, 12345)        # unknown varint field
        + _len_field(98, b"future-bytes") # unknown length-delimited field
        + _varint_field(4, 1)
    )
    o = OfferMessage()
    o.from_bytes(payload)
    assert o.coin_from == 2
    assert o.coin_to == 6
    assert o.amount_from == 1
    assert not hasattr(o, "field_99")


def test_offer_message_negotiable_flags():
    payload = (
        _varint_field(2, 2) + _varint_field(3, 6) + _varint_field(4, 1)
        + _varint_field(17, 1)   # amount_negotiable
        + _varint_field(18, 1)   # rate_negotiable
        + _varint_field(20, 2)   # auto_accept_type
    )
    o = OfferMessage()
    o.from_bytes(payload)
    assert o.amount_negotiable == 1
    assert o.rate_negotiable == 1
    assert o.auto_accept_type == 2


def test_bid_message_offer_id_extraction():
    """The scraper only needs offer_msg_id from BidMessage; the rest is bonus."""
    fake_offer_id = bytes.fromhex("deadbeefcafef00d" * 2)  # 16 bytes
    payload = (
        _varint_field(1, 2)
        + _len_field(2, fake_offer_id)
        + _varint_field(3, 7200)
        + _varint_field(4, 50_000_000)
    )
    bm = BidMessage()
    bm.from_bytes(payload)
    assert bm.offer_msg_id == fake_offer_id
    assert bm.time_valid == 7200
    assert bm.amount == 50_000_000


def test_message_type_labels_cover_all_types():
    """Every IntEnum member must have a human-readable label so the
    UI never displays a bare integer."""
    for mt in MessageTypes:
        assert mt in MESSAGE_TYPE_LABELS, f"missing label for {mt!r}"
        assert isinstance(MESSAGE_TYPE_LABELS[mt], str)
        assert MESSAGE_TYPE_LABELS[mt]  # non-empty


def test_message_types_enum_values_stable():
    # These wire-format byte values are the contract with the BSX network -
    # changing them silently would corrupt the message_type_counts histogram.
    assert MessageTypes.OFFER == 1
    assert MessageTypes.BID == 2
    assert MessageTypes.OFFER_REVOKE == 11
    assert MessageTypes.ADS_BID_LF == 12
