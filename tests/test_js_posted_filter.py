"""Run the Node smoke-test for the posted-time (activity-heatmap) filter.

Delegates to ``js_filter_by_hour.mjs``: that script loads ``app.js`` in a
vm context with a minimal DOM stub, then exercises ``filterByHour`` /
``getFilteredOffers`` / ``writeHash`` / ``readHash`` / ``clearPostedFilter``
and asserts the round-trip behaviour. The pytest skips when Node is
unavailable on the runner.
"""
import os
import shutil
import subprocess

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "js_filter_by_hour.mjs")


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_filter_by_hour_round_trip():
    result = subprocess.run(
        ["node", SCRIPT],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, (
        f"node assertions failed (rc={result.returncode})\n"
        f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    assert "OK:" in result.stdout, f"unexpected node stdout: {result.stdout!r}"
