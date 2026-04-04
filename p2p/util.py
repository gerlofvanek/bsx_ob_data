# Minimal stubs for p2p framework
import time
import threading

MAX_NODES = 12

def assert_equal(a, b):
    assert a == b, f"{a} != {b}"

def p2p_port(n):
    return 11000 + n

def wait_until_helper_internal(predicate, *, attempts=float('inf'), timeout=60, lock=None, timeout_factor=1.0):
    if attempts == float('inf') and timeout == float('inf'):
        timeout = 60
    timeout = timeout * timeout_factor
    attempt = 0
    time_end = time.time() + timeout
    while time.time() < time_end and attempt < attempts:
        if lock:
            with lock:
                if predicate():
                    return
        else:
            if predicate():
                return
        attempt += 1
        time.sleep(0.05)
    raise AssertionError("wait_until timed out")
