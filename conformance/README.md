# Conformance vectors

Frozen inputs and expected outputs for the agent-eval evidence format, plus an
independent verifier that passes them.

```bash
python conformance/verify.py      # no dependencies, Python 3.8+
pnpm --filter @agent-eval/server test -- conformance
```

The first runs a second implementation against the vectors. The second runs the
*first* implementation against them, which is a different claim: one proves the
format is reproducible, the other proves this repository still produces it.

---

## Why this exists

A verifier that only ever agrees with the prover it ships beside proves that the
prover is self-consistent. It would confirm a wrong-but-consistent tree just as
readily as a right one.

agent-eval's TypeScript verifier already shares no tree-walking code with its
prover, which is further than most implementations go. But it is the same
language, the same repository and the same author, and three of those are
correlated failure modes. A misread of RFC 6962 lands in both halves at once.

So the format is pinned three ways:

| | |
| --- | --- |
| **Known answers** | Vectors are checked against published constants — RFC 8785's worked example, `MTH({}) = SHA-256()`, RFC 8032 test vector 1 — before they are written. The generator refuses to emit a file if any check fails. |
| **A second implementation** | `verify.py`, pure Python, standard library only, different algorithms where difference is load-bearing. |
| **A drift test** | `conformance.test.ts` re-runs the frozen vectors against the TypeScript on every CI run. |

The Python job in CI installs no Node.js. If it needed anything the build
produced, it would not be independent.

---

## What is deliberately different in the Python verifier

Porting the TypeScript to Python would produce a second implementation that
shares every assumption with the first. These four differ where it matters:

**Merkle roots are computed by a different algorithm.** The TypeScript recurses,
splitting at the largest power of two below `n`, exactly as RFC 6962 §2.1
defines `MTH`. The Python iterates: pair leaves left to right, promote the odd
one, repeat. The project claims these are equivalent at every size; the suite
checks it at n=0..40 rather than restating it.

Note the odd leaf is *promoted*, not duplicated. Duplicating is the Bitcoin
construction, yields different roots, and is the source of CVE-2012-2459.

**Ed25519 is implemented from RFC 8032 in pure Python.** Node signs through
OpenSSL. A signature that crosses that boundary has been verified by two
unrelated field arithmetic implementations. The Python derives test vector 1's
public key from its published seed before it is trusted to judge anything.

**Canonical JSON is re-derived from RFC 8785**, including ECMAScript's
`Number::toString`, which Python's `repr()` does *not* match at either end of
the exponent range:

| value | ECMAScript | Python `repr` |
| --- | --- | --- |
| `1e20` | `100000000000000000000` | `1e+20` |
| `5.0` | `5` | `5.0` |
| `1e21` | `1e+21` | `1e+21` |

**Keys are sorted by UTF-16 code unit, explicitly.** Python's `sorted()` orders
`str` by code point. There is a vector for exactly this, and it is the one most
likely to catch a third implementation — see below.

---

## The vectors

### `canonicalization.json` — RFC 8785

Nine cases plus four documented rejections. The one worth reading first:

> **non-BMP key sorts before U+FFFF**

`U+10000` encodes in UTF-16 as the surrogate pair `D800 DC00`. Under RFC 8785's
code-unit ordering it sorts **before** `U+FFFF`, because `D800 < FFFF`. Under
code-point ordering it sorts after, because `0xFFFF < 0x10000`.

JavaScript's default sort gets this right for free. Python, Go and Rust all sort
strings by code point and get it wrong unless told otherwise. Two
implementations that disagree here produce different digests for the same
record, each internally consistent, and the failure surfaces as "tampering"
against data nobody touched.

**agent-eval is RFC 8785 conformant over the domain of valid JSON**, verified
against the specification's own §3.2.3 worked example byte for byte. Outside
that domain it is *stricter*, never looser — four values that RFC 8785 would
serialize lossily are rejected instead:

| rejected | because RFC 8785 would |
| --- | --- |
| `-0` | serialize it as `0`, losing the sign |
| `NaN`, `Infinity` | serialize both as `null`, collapsing two values into a third |
| `BigInt` | throw, less clearly |
| circular references | recurse until the stack ends |

An audit record that cannot be represented exactly should fail at the point of
writing, not hash to something that does not mean what it says.

### `merkle.json` — RFC 6962

Leaf *i* is the UTF-8 bytes of the ASCII string `leaf-<i>`, so a third party can
rebuild every input from the spec alone.

- 41 roots, `n = 0` through `40`
- 33 inclusion proofs across 12 tree sizes, chosen to cover powers of two and
  the ragged right edge either side of them
- 11 consistency proofs, including both degenerate cases (`m = n`, and `m` a
  power of two, where the old root is not carried in the proof)

Two properties break interoperability and neither is where you would expect:

**Child hashes concatenate as raw bytes, never as hex text.** An implementation
that joins the hex strings computes a different root at 39 of the first 40
sizes — `n=1` agreeing only because nothing is concatenated. Both are internally
consistent and they never interoperate.

**Domain separation is mandatory.** `0x00` prefixes a leaf, `0x01` an internal
node. Without it an internal node can be presented as a leaf and an inclusion
proof forged for data that was never logged.

### `audit-chain.json`

Five entries. `entryHash` is SHA-256 over the canonical JSON of the entry with
`entryHash` removed; `entry[i].previousHash` is `entry[i-1].entryHash`, and
entry 0 uses the all-zeroes genesis hash.

Includes a tampered entry — one field changed, hash left alone — that a
conforming verifier must reject.

### `signature.json` — RFC 8032

Ed25519 over the UTF-8 bytes of the canonical JSON of `payload`.

The key pair is **RFC 8032 §7.1 test vector 1**. It is published, it is in the
RFC, and it is in this file: it is not a secret and must never be used for
anything. Using it means a third implementation can check its own Ed25519
against the RFC's numbers before it checks anything here.

`signature.signedAt` is deliberately **outside** the signed bytes. Including it
would mean re-signing to correct a clock, and the timestamp that carries
evidentiary weight is a timestamp authority's, not the signer's.

---

## Writing a third implementation

You need SHA-256, SHA-512 and Ed25519 verification. Everything else is in the
RFCs.

1. Canonical JSON per RFC 8785. Sort by **UTF-16 code unit**. Format numbers per
   ECMAScript `Number::toString`, not your language's float formatter.
2. Merkle per RFC 6962 §2.1. Concatenate **bytes**. Prefix `0x00` / `0x01`.
3. Verify proofs by reconstructing the root from the proof alone. Do not call
   into a tree implementation — that is the mistake this suite exists to make
   visible.
4. Run against `vectors/`. All 26 checks, or you are not compatible.

`verify.py` is about 500 lines including its comments and is meant to be read
rather than imported.

---

## Regenerating

```bash
pnpm conformance:generate
```

Changing these files changes the evidence format, and every bundle already
issued verifies differently afterwards. That is a deliberate act and belongs in
its own commit with its own reasoning. `conformance.test.ts` fails on any drift,
so it cannot happen quietly.
