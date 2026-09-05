#!/usr/bin/env python3
"""
An independent verifier for the agent-eval evidence format.

Run:  python conformance/verify.py

This file exists to answer one objection. agent-eval's TypeScript verifier
already shares no tree-walking code with its prover, which is better than most
implementations manage -- but it is still the same language, the same repo and
the same author, and an implementation that only ever agrees with itself is not
a format. It is a habit.

So this is a second implementation, and it is deliberately different where
difference is load-bearing:

  Merkle roots       computed by ITERATIVE left-to-right pairing with odd-node
                     promotion. The TypeScript computes them by RECURSIVE
                     splitting at the largest power of two below n. These are
                     different algorithms that must agree at all 41 sizes; if
                     the equivalence the project claims is wrong, this file
                     finds it rather than restating it.
  Ed25519            implemented here from RFC 8032 in pure Python. Node uses
                     OpenSSL. A signature produced by one and verified by the
                     other has crossed a real boundary.
  Canonical JSON     re-derived from RFC 8785, including the ECMAScript
                     Number::toString rules, which Python's repr() does NOT
                     match at either end of the exponent range.
  Key ordering       explicitly by UTF-16 code unit. Python's sorted() orders
                     str by CODE POINT, which silently reverses any pair of
                     keys spanning U+FFFF. There is a vector for exactly this.

Dependencies: none. Python 3.8+ and the standard library, so a reviewer can run
it on a locked-down machine without a package index.

Exit code 0 if every vector passes, 1 otherwise.
"""

import base64
import hashlib
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
VECTORS = os.path.join(HERE, "vectors")


# ---------------------------------------------------------------- reporting

class Report(object):
    def __init__(self):
        self.passed = 0
        self.failed = []

    def check(self, ok, label, detail=""):
        if ok:
            self.passed += 1
        else:
            self.failed.append((label, detail))
        return ok

    def section(self, name):
        sys.stdout.write("\n%s\n%s\n" % (name, "-" * len(name)))

    def line(self, ok, label, detail=""):
        mark = "ok  " if ok else "FAIL"
        sys.stdout.write("  %s  %s\n" % (mark, label))
        if not ok and detail:
            sys.stdout.write("        %s\n" % detail)


def load(name):
    with open(os.path.join(VECTORS, name), "rb") as fh:
        return json.loads(fh.read().decode("utf-8"))


# ------------------------------------------------------- canonical JSON (8785)

def es_number_to_string(x):
    """
    ECMAScript Number::toString, which RFC 8785 adopts verbatim for numbers.

    Python's repr() produces the same *digits* -- both use the shortest decimal
    that round-trips -- but formats them differently at the extremes:

        1e20   ECMAScript "100000000000000000000"   Python "1e+20"
        5.0    ECMAScript "5"                       Python "5.0"

    So the digits are taken from repr() and re-laid-out under the ECMAScript
    rules (ECMA-262 Number::toString): with the value written as s x 10^(n-k),
    where s has k digits, the decimal form is used when -6 < n <= 21 and the
    exponential form otherwise.
    """
    if x != x or x in (float("inf"), float("-inf")):
        raise ValueError("non-finite numbers have no JSON representation")

    if x == 0:
        # RFC 8785 would serialize -0 as "0", losing the sign. agent-eval
        # rejects it instead: a value that changes on the way into an audit
        # record is worse than one that fails loudly.
        if math.copysign(1.0, x) < 0:
            raise ValueError("negative zero does not round-trip through JSON")
        return "0"

    sign = "-" if x < 0 else ""
    r = repr(abs(float(x)))

    if "e" in r:
        mantissa, exponent = r.split("e")
        exponent = int(exponent)
    else:
        mantissa, exponent = r, 0

    if "." in mantissa:
        int_part, frac_part = mantissa.split(".")
    else:
        int_part, frac_part = mantissa, ""

    digits = int_part + frac_part
    # Position of the decimal point, counted from the left of `digits`.
    n = len(int_part) + exponent

    stripped = digits.lstrip("0")
    n -= len(digits) - len(stripped)
    digits = stripped.rstrip("0") or "0"
    k = len(digits)

    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    # Exponential form.
    e = n - 1
    esign = "+" if e >= 0 else "-"
    if k == 1:
        return sign + digits + "e" + esign + str(abs(e))
    return sign + digits[0] + "." + digits[1:] + "e" + esign + str(abs(e))


_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


def es_quote(s):
    """JSON string escaping as ECMAScript JSON.stringify performs it."""
    out = ['"']
    for ch in s:
        esc = _ESCAPES.get(ch)
        if esc is not None:
            out.append(esc)
        elif ch < " ":
            out.append("\\u%04x" % ord(ch))
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def utf16_sort_key(s):
    """
    RFC 8785 orders keys by UTF-16 code unit.

    Encoding to UTF-16 big-endian and comparing the bytes gives exactly that
    ordering. Comparing the Python str directly would order by code point,
    which puts U+FFFF before U+10000 -- the reverse of what the spec requires,
    because U+10000's leading surrogate is D800.

    `surrogatepass` so a lone surrogate is an ordering question rather than an
    exception.
    """
    return s.encode("utf-16-be", "surrogatepass")


def canonicalize(value):
    """RFC 8785 canonical JSON. Independent of the TypeScript implementation."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return es_quote(value)
    if isinstance(value, (int, float)):
        # ECMAScript has one numeric type. An int from json.load must go
        # through the double it would have been in the producing runtime, or
        # 2^53+1 canonicalizes here to a value the producer could not hold.
        return es_number_to_string(float(value))
    if isinstance(value, list):
        return "[" + ",".join(canonicalize(v) for v in value) + "]"
    if isinstance(value, dict):
        items = sorted(value.items(), key=lambda kv: utf16_sort_key(kv[0]))
        return "{" + ",".join(es_quote(k) + ":" + canonicalize(v) for k, v in items) + "}"
    raise TypeError("no canonical form for %r" % type(value))


# ------------------------------------------------------------ merkle (RFC 6962)

def sha256(*parts):
    h = hashlib.sha256()
    for p in parts:
        h.update(p)
    return h.digest()


LEAF = b"\x00"
NODE = b"\x01"


def hash_leaf(data):
    return sha256(LEAF, data)


def hash_node(left, right):
    return sha256(NODE, left, right)


def merkle_root_iterative(leaf_hashes):
    """
    MTH by iterative left-to-right pairing, promoting the odd node.

    Deliberately NOT the recursive largest-power-of-two-below-n split that
    merkle-tree.ts uses. The project claims the two are equivalent at every
    size; running both and comparing is what makes that a measurement rather
    than an assertion.

    Note this promotes the odd node rather than duplicating it. Duplicating is
    the Bitcoin construction and yields different roots -- it is also the
    source of CVE-2012-2459, so the distinction is not academic.
    """
    if not leaf_hashes:
        return sha256(b"")
    level = list(leaf_hashes)
    while len(level) > 1:
        nxt = []
        for i in range(0, len(level) - 1, 2):
            nxt.append(hash_node(level[i], level[i + 1]))
        if len(level) % 2 == 1:
            nxt.append(level[-1])
        level = nxt
    return level[0]


def verify_inclusion(leaf_hash, leaf_index, tree_size, path):
    """RFC 6962 section 2.1.1: rebuild the root from the leaf and its audit path."""
    if tree_size <= 0 or not (0 <= leaf_index < tree_size):
        return None
    fn, sn = leaf_index, tree_size - 1
    h = leaf_hash
    for sibling in path:
        if sn == 0:
            return None
        if fn % 2 == 1 or fn == sn:
            h = hash_node(sibling, h)
            while fn != 0 and fn % 2 == 0:
                fn >>= 1
                sn >>= 1
        else:
            h = hash_node(h, sibling)
        fn >>= 1
        sn >>= 1
    return h if sn == 0 else None


def is_power_of_two(n):
    return n > 0 and (n & (n - 1)) == 0


def verify_consistency(first_size, second_size, first_root, second_root, path):
    """RFC 6962 section 2.1.2: prove the later tree extends the earlier one."""
    if first_size > second_size:
        return False
    if first_size == second_size:
        return not path and first_root == second_root
    if first_size == 0:
        return not path

    fn, sn = first_size - 1, second_size - 1
    while fn % 2 == 1:
        fn >>= 1
        sn >>= 1

    idx = 0
    if is_power_of_two(first_size):
        fr = first_root
    else:
        if not path:
            return False
        fr = path[0]
        idx = 1
    sr = fr

    while idx < len(path):
        if sn == 0:
            return False
        node = path[idx]
        idx += 1
        if fn % 2 == 1 or fn == sn:
            fr = hash_node(node, fr)
            sr = hash_node(node, sr)
            while fn != 0 and fn % 2 == 0:
                fn >>= 1
                sn >>= 1
        else:
            sr = hash_node(sr, node)
        fn >>= 1
        sn >>= 1

    return sn == 0 and fr == first_root and sr == second_root


# ------------------------------------------------------------ ed25519 (RFC 8032)
#
# The reference implementation from RFC 8032, transcribed for verification
# only. It is slow -- affine coordinates with a modular inversion per point
# addition -- and that is the right trade here: this code is meant to be read
# and checked against the RFC by someone deciding whether to trust a bundle,
# not to verify a million signatures.

_P = 2 ** 255 - 19
_L = 2 ** 252 + 27742317777372353535851937790883648493


def _inv(x):
    return pow(x, _P - 2, _P)


_D = -121665 * _inv(121666) % _P
_I = pow(2, (_P - 1) // 4, _P)


def _x_recover(y):
    xx = (y * y - 1) * _inv(_D * y * y + 1)
    x = pow(xx, (_P + 3) // 8, _P)
    if (x * x - xx) % _P != 0:
        x = (x * _I) % _P
    if x % 2 != 0:
        x = _P - x
    return x


_BY = 4 * _inv(5) % _P
_BX = _x_recover(_BY)
_B = (_BX % _P, _BY % _P)


def _edwards_add(p, q):
    x1, y1 = p
    x2, y2 = q
    k = _D * x1 * x2 * y1 * y2
    x3 = (x1 * y2 + x2 * y1) * _inv(1 + k)
    y3 = (y1 * y2 + x1 * x2) * _inv(1 - k)
    return (x3 % _P, y3 % _P)


def _scalar_mult(p, e):
    result = (0, 1)
    addend = p
    while e > 0:
        if e & 1:
            result = _edwards_add(result, addend)
        addend = _edwards_add(addend, addend)
        e >>= 1
    return result


def _is_on_curve(p):
    x, y = p
    return (-x * x + y * y - 1 - _D * x * x * y * y) % _P == 0


def _decode_point(b):
    y = int.from_bytes(b, "little") & ((1 << 255) - 1)
    x = _x_recover(y)
    if (x & 1) != ((b[31] >> 7) & 1):
        x = _P - x
    p = (x, y)
    if not _is_on_curve(p):
        raise ValueError("point is not on the curve")
    return p


def ed25519_verify(signature, message, public_key):
    """RFC 8032 section 5.1.7. True if `signature` is valid over `message`."""
    if len(signature) != 64 or len(public_key) != 32:
        return False
    try:
        r_point = _decode_point(signature[:32])
        a_point = _decode_point(public_key)
    except (ValueError, IndexError):
        return False
    s = int.from_bytes(signature[32:], "little")
    if s >= _L:
        # A non-canonical S is malleable; RFC 8032 requires rejecting it.
        return False
    h = int.from_bytes(
        hashlib.sha512(signature[:32] + public_key + message).digest(), "little"
    )
    return _scalar_mult(_B, s) == _edwards_add(r_point, _scalar_mult(a_point, h))


def raw_public_key_from_pem(pem):
    """
    The 32 raw key bytes out of an SPKI PEM.

    An Ed25519 SPKI is a fixed 44-byte structure whose last 32 bytes are the
    key, so this needs no DER parser.
    """
    body = "".join(
        line.strip() for line in pem.splitlines() if "-----" not in line and line.strip()
    )
    der = base64.b64decode(body)
    if len(der) != 44:
        raise ValueError("expected a 44-byte Ed25519 SPKI, got %d" % len(der))
    return der[-32:]


# ----------------------------------------------------------------- the checks

def check_canonicalization(rep):
    rep.section("Canonical JSON (RFC 8785)")
    data = load("canonicalization.json")

    for vector in data["vectors"]:
        expected = vector["canonical"]
        try:
            actual = canonicalize(vector["input"])
            ok = actual == expected
            detail = "" if ok else "expected %r\n        actual   %r" % (expected, actual)
        except Exception as exc:  # noqa: BLE001 - report, never abort the suite
            ok, detail = False, "raised %s: %s" % (type(exc).__name__, exc)
        rep.check(ok, vector["description"], detail)
        rep.line(ok, vector["description"], detail)

    # The rejected cases have no JSON representation, so they are constructed
    # here rather than read from the vector file.
    rejects = [
        ("negative zero", -0.0),
        ("NaN", float("nan")),
        ("Infinity", float("inf")),
    ]
    for label, value in rejects:
        try:
            canonicalize(value)
            ok = False
        except (ValueError, TypeError):
            ok = True
        rep.check(ok, "rejects %s" % label)
        rep.line(ok, "rejects %s" % label)


def check_merkle(rep):
    rep.section("Merkle tree (RFC 6962)")
    data = load("merkle.json")

    leaf_hashes = [bytes.fromhex(h) for h in data["leafHashes"]]

    # Leaf hashes, rebuilt from the documented encoding rather than trusted.
    rebuilt = all(
        hash_leaf(("leaf-%d" % i).encode("utf-8")) == leaf_hashes[i]
        for i in range(len(leaf_hashes))
    )
    rep.check(rebuilt, "leaf hashes rebuild from `leaf-<i>`")
    rep.line(rebuilt, "leaf hashes rebuild from `leaf-<i>`")

    empty_ok = merkle_root_iterative([]).hex() == data["emptyRoot"]
    rep.check(empty_ok, "MTH({}) = SHA-256(empty)")
    rep.line(empty_ok, "MTH({}) = SHA-256(empty)")

    # The equivalence claim: iterative pairing vs recursive power-of-two split,
    # at every size from 0 to 40.
    mismatches = []
    for n, expected in enumerate(data["roots"]):
        actual = merkle_root_iterative(leaf_hashes[:n]).hex()
        if actual != expected:
            mismatches.append("n=%d expected %s got %s" % (n, expected[:16], actual[:16]))
    ok = not mismatches
    detail = "; ".join(mismatches[:3])
    rep.check(ok, "iterative pairing agrees with recursive split at n=0..%d" % (len(data["roots"]) - 1), detail)
    rep.line(ok, "iterative pairing agrees with recursive split at n=0..%d" % (len(data["roots"]) - 1), detail)

    bad = []
    for case in data["inclusion"]:
        computed = verify_inclusion(
            bytes.fromhex(case["leafHash"]),
            case["leafIndex"],
            case["treeSize"],
            [bytes.fromhex(h) for h in case["path"]],
        )
        if computed is None or computed.hex() != case["root"]:
            bad.append("leaf %d of %d" % (case["leafIndex"], case["treeSize"]))
    ok = not bad
    rep.check(ok, "%d inclusion proofs reconstruct their root" % len(data["inclusion"]), "; ".join(bad[:3]))
    rep.line(ok, "%d inclusion proofs reconstruct their root" % len(data["inclusion"]), "; ".join(bad[:3]))

    # A proof must fail for a leaf that is not the one it was made for.
    first = data["inclusion"][0]
    wrong = verify_inclusion(
        hash_leaf(b"not-the-logged-leaf"),
        first["leafIndex"],
        first["treeSize"],
        [bytes.fromhex(h) for h in first["path"]],
    )
    ok = wrong is None or wrong.hex() != first["root"]
    rep.check(ok, "an inclusion proof rejects a substituted leaf")
    rep.line(ok, "an inclusion proof rejects a substituted leaf")

    bad = []
    for case in data["consistency"]:
        if not verify_consistency(
            case["firstSize"],
            case["secondSize"],
            bytes.fromhex(case["firstRoot"]),
            bytes.fromhex(case["secondRoot"]),
            [bytes.fromhex(h) for h in case["path"]],
        ):
            bad.append("%d->%d" % (case["firstSize"], case["secondSize"]))
    ok = not bad
    rep.check(ok, "%d consistency proofs verify" % len(data["consistency"]), "; ".join(bad[:3]))
    rep.line(ok, "%d consistency proofs verify" % len(data["consistency"]), "; ".join(bad[:3]))

    # A rewritten history has no consistency proof. Corrupt the old root and
    # the same proof must stop verifying.
    case = data["consistency"][-1]
    forged = bytearray(bytes.fromhex(case["firstRoot"]))
    forged[0] ^= 0x01
    ok = not verify_consistency(
        case["firstSize"],
        case["secondSize"],
        bytes(forged),
        bytes.fromhex(case["secondRoot"]),
        [bytes.fromhex(h) for h in case["path"]],
    )
    rep.check(ok, "a consistency proof rejects an altered earlier root")
    rep.line(ok, "a consistency proof rejects an altered earlier root")


def check_chain(rep):
    rep.section("Hash-chained audit log")
    data = load("audit-chain.json")

    entries = data["entries"]
    previous = data["genesisHash"]
    broken = []
    for i, entry in enumerate(entries):
        if entry["seq"] != i:
            broken.append("entry %d has seq %s" % (i, entry["seq"]))
        if entry["previousHash"] != previous:
            broken.append("entry %d does not follow its predecessor" % i)
        body = dict(entry)
        claimed = body.pop("entryHash")
        recomputed = hashlib.sha256(canonicalize(body).encode("utf-8")).hexdigest()
        if recomputed != claimed:
            broken.append("entry %d hash mismatch" % i)
        previous = claimed

    ok = not broken
    rep.check(ok, "%d entries: hashes recompute and the chain links" % len(entries), "; ".join(broken[:3]))
    rep.line(ok, "%d entries: hashes recompute and the chain links" % len(entries), "; ".join(broken[:3]))

    # The tampered entry must not recompute to the hash it carries.
    tampered = dict(data["tamperedEntry"]["entry"])
    claimed = tampered.pop("entryHash")
    recomputed = hashlib.sha256(canonicalize(tampered).encode("utf-8")).hexdigest()
    ok = recomputed != claimed
    rep.check(ok, "a single edited field breaks its entry hash")
    rep.line(ok, "a single edited field breaks its entry hash", data["tamperedEntry"]["note"])


def check_signature(rep):
    rep.section("Ed25519 signature (RFC 8032)")
    data = load("signature.json")

    # The public key derived from the RFC's own seed must match what the RFC
    # publishes. This validates the Ed25519 code here before it is asked to
    # judge anything.
    seed = bytes.fromhex(data["privateKeySeed"])
    h = bytearray(hashlib.sha512(seed).digest()[:32])
    h[0] &= 248
    h[31] &= 127
    h[31] |= 64
    a = int.from_bytes(bytes(h), "little")
    point = _scalar_mult(_B, a)
    x, y = point
    encoded = bytearray((y % _P).to_bytes(32, "little"))
    encoded[31] |= (x & 1) << 7
    ok = bytes(encoded).hex() == data["publicKeyRaw"]
    rep.check(ok, "derives RFC 8032 test vector 1's public key from its seed", "" if ok else "got %s" % bytes(encoded).hex())
    rep.line(ok, "derives RFC 8032 test vector 1's public key from its seed", "" if ok else "got %s" % bytes(encoded).hex())

    pem_key = raw_public_key_from_pem(data["publicKeyPem"])
    ok = pem_key.hex() == data["publicKeyRaw"]
    rep.check(ok, "the PEM in the bundle carries the same key")
    rep.line(ok, "the PEM in the bundle carries the same key")

    # The canonical form of the payload, computed here, must match the bytes
    # the signer says it signed. If canonicalization disagrees across
    # implementations, this is where it surfaces.
    payload = data["envelope"]["payload"]
    signed_bytes = canonicalize(payload)
    ok = signed_bytes == data["signedBytes"]
    rep.check(ok, "canonical form of the payload matches the signed bytes",
              "" if ok else "expected %r\n        actual   %r" % (data["signedBytes"], signed_bytes))
    rep.line(ok, "canonical form of the payload matches the signed bytes",
             "" if ok else "expected %r\n        actual   %r" % (data["signedBytes"], signed_bytes))

    signature = base64.b64decode(data["envelope"]["signature"]["value"])
    ok = ed25519_verify(signature, signed_bytes.encode("utf-8"), pem_key)
    rep.check(ok, "pure-Python Ed25519 accepts the signature Node produced")
    rep.line(ok, "pure-Python Ed25519 accepts the signature Node produced")

    tampered_payload = data["tampered"]["envelope"]["payload"]
    ok = not ed25519_verify(
        signature, canonicalize(tampered_payload).encode("utf-8"), pem_key
    )
    rep.check(ok, "and rejects the payload with one field changed")
    rep.line(ok, "and rejects the payload with one field changed", data["tampered"]["note"])


def main():
    sys.stdout.write(
        "agent-eval conformance verifier\n"
        "independent implementation: pure Python 3, standard library only\n"
    )

    rep = Report()
    for check in (check_canonicalization, check_merkle, check_chain, check_signature):
        try:
            check(rep)
        except Exception as exc:  # noqa: BLE001
            rep.check(False, "%s crashed" % check.__name__, "%s: %s" % (type(exc).__name__, exc))
            rep.line(False, "%s crashed" % check.__name__, "%s: %s" % (type(exc).__name__, exc))

    total = rep.passed + len(rep.failed)
    sys.stdout.write("\n%s\n" % ("=" * 60))
    if rep.failed:
        sys.stdout.write("FAILED  %d of %d checks\n\n" % (len(rep.failed), total))
        for label, detail in rep.failed:
            sys.stdout.write("  %s\n" % label)
            if detail:
                sys.stdout.write("      %s\n" % detail)
        return 1

    sys.stdout.write(
        "PASSED  all %d checks\n\n"
        "Two implementations in two languages, sharing no code, agree on every\n"
        "vector. The format is reproducible from the RFCs.\n" % total
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
