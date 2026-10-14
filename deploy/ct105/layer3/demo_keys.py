"""The 3 fixed demo unlock keys for the Layer 3 lockout demo, and nothing else.

These are demo-only values, printed on screen during the presentation, never secrets. They are fixed
(not regenerated per run) so the whole demo is rehearsable: run lockout, show the keys, run unlock with
the same 2 keys every time. Do not reuse this pattern or these values for anything real.

Unlock needs any 2 of the 3, matching the "2 of 3 key holders" design on the witness page.
"""

import hashlib

DEMO_KEYS = {
    "SOC lead": "SOC-7F3A-9C21-LEAD",
    "Auditor": "AUD-4B88-E015-CHEK",
    "Compliance officer": "CMP-2D9F-77AB-OKAY",
}

NEEDED = 2

_HASHES = {holder: hashlib.sha256(key.encode("utf-8")).hexdigest() for holder, key in DEMO_KEYS.items()}


def holder_for_key(key):
    """The holder name a key belongs to, or None if it matches no known demo key."""
    digest = hashlib.sha256(key.strip().encode("utf-8")).hexdigest()
    for holder, expected in _HASHES.items():
        if digest == expected:
            return holder
    return None


def verify(keys):
    """True if `keys` contains at least NEEDED distinct, correct demo keys."""
    holders = {holder_for_key(key) for key in keys}
    holders.discard(None)
    return len(holders) >= NEEDED
