"""Tests for plain stats artifact generation."""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from scripts import plain_stats  # noqa: E402


@pytest.fixture
def book():
    path = os.path.join(ROOT, "orderbook.json")
    if not os.path.isfile(path):
        pytest.skip("orderbook.json not present")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def test_build_stats_txt_contains_sections(book):
    offers = plain_stats.live_offers(book)
    text = plain_stats.build_stats_txt(book, offers, {}, [], int(book["timestamp"]))
    assert "Now" in text
    assert "Top pairs" in text
    assert "Liquidity by coin" in text
    assert "Offer freshness" in text


def test_build_summary_includes_prices(book):
    offers = plain_stats.live_offers(book)
    summary = plain_stats.build_summary(book, offers, {"bitcoin": 100000.0})
    assert "usd_prices" in summary
    assert summary["usd_prices"].get("BTC") == 100000.0


def test_render_diff_pair_churn():
    manifest = [
        {"file": "a.json", "active_offers": 10, "num_offers": 20, "pair_counts": {"BTC/LTC": 3}},
        {"file": "b.json", "active_offers": 12, "num_offers": 22, "pair_counts": {"BTC/LTC": 5, "XMR/BTC": 1}},
    ]
    diff = plain_stats.render_diff_section(manifest)
    assert "pair offer churn" in diff
    assert "BTC/LTC" in diff


def test_build_ops_data(book):
    health = {"ok": True, "msgs_received": 100, "msg_rate_per_s": 10.0, "duration_s": 10}
    manifest = [{"active_offers": 90, "msg_rate_per_s": 8.0, "revokes_invalid_sig": 0}] * 5
    ops = plain_stats.build_ops_data(book, health, manifest, int(book["timestamp"]))
    assert ops["threat_label"] in ("LOW", "WATCH", "ELEVATED", "HIGH")
    assert "alerts" in ops
    assert "maker_watch" in ops
    assert "scores" in ops


def test_build_ops_data_invalid_revokes(book):
    book = dict(book)
    book["stats"] = dict(book.get("stats") or {})
    book["stats"]["revokes_invalid_sig"] = 2
    ops = plain_stats.build_ops_data(book, {"ok": True, "msgs_received": 1}, [], int(book["timestamp"]))
    assert ops["threat_level"] >= 3
    assert any("Invalid revokes" in a["msg"] for a in ops["alerts"])


def test_render_offer_diff():
    old = {
        "timestamp": 1000,
        "updated_at": "old",
        "offers": [
            {"msg_id": "a", "coin_from": "BTC", "coin_to": "LTC", "amount_from_str": "1",
             "timestamp": 900, "time_valid": 500},
            {"msg_id": "b", "coin_from": "XMR", "coin_to": "BTC", "amount_from_str": "2",
             "timestamp": 900, "time_valid": 500},
        ],
    }
    new = {
        "timestamp": 1100,
        "updated_at": "new",
        "offers": [
            {"msg_id": "a", "coin_from": "BTC", "coin_to": "LTC", "amount_from_str": "1",
             "timestamp": 900, "time_valid": 500},
            {"msg_id": "c", "coin_from": "LTC", "coin_to": "BTC", "amount_from_str": "3",
             "timestamp": 1000, "time_valid": 500},
        ],
    }
    diff = plain_stats.render_offer_diff(old, new)
    assert "offer-level churn" in diff
    assert "appeared     1" in diff
    assert "vanished     1" in diff
    assert "still active: 1" in diff


def test_stats_txt_golden_structure(book):
    offers = plain_stats.live_offers(book)
    now = int(book["timestamp"])
    text = plain_stats.build_stats_txt(book, offers, {}, [], now)
    lines = text.splitlines()
    assert lines[0] == "plain text market stats"
    assert "BasicSwap · Particl SMSG network" in text
    section_order = ["Now", "Top pairs", "Liquidity by coin", "Offer freshness", "New offers · 24h", "Makers"]
    positions = [text.index(s) for s in section_order]
    assert positions == sorted(positions)
    assert text.rstrip().endswith("full view: /")
    assert "=" * plain_stats.RULE_MIN in text


def test_build_bulletins_manifest(tmp_path):
    bdir = tmp_path / "bulletins"
    bdir.mkdir()
    (bdir / "2026-07-27.txt").write_text("daily\n", encoding="utf-8")
    (bdir / "week-2026-W31.txt").write_text("weekly\n", encoding="utf-8")
    manifest = plain_stats.build_bulletins_manifest(str(bdir))
    assert len(manifest) == 2
    kinds = {e["kind"] for e in manifest}
    assert kinds == {"daily", "weekly"}


def test_generate_plain_artifacts(tmp_path, book):
    out = str(tmp_path / "plain")
    manifest = os.path.join(ROOT, "snapshots", "manifest.json")
    plain_stats.generate_plain_artifacts(
        book, out, manifest_path=manifest if os.path.isfile(manifest) else None,
        fetch_usd=False, repo_root=str(tmp_path),
    )
    assert os.path.isfile(os.path.join(out, "stats.txt"))
    assert os.path.isfile(os.path.join(out, "summary.json"))
    assert os.path.isfile(os.path.join(out, "feed.json"))
    assert os.path.isfile(os.path.join(tmp_path, "status.txt"))
    assert os.path.isfile(os.path.join(tmp_path, "stats.txt"))
    bulletins_manifest = os.path.join(out, "bulletins", "manifest.json")
    if os.path.isfile(bulletins_manifest):
        with open(bulletins_manifest, encoding="utf-8") as f:
            assert "bulletins" in json.load(f)
    pairs_dir = os.path.join(out, "pairs")
    if os.path.isdir(pairs_dir):
        assert any(f.endswith(".txt") for f in os.listdir(pairs_dir))
