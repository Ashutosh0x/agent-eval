/**
 * Generates the frozen conformance vectors in `conformance/vectors/`.
 *
 * Run: pnpm conformance:generate
 *
 * The point of this file is NOT to record what the implementation does. A
 * vector suite generated from an implementation freezes that implementation's
 * bugs and calls them a spec. So every vector here is checked against a
 * published known answer *before* it is written, and the generator refuses to
 * emit anything if a check fails:
 *
 *   RFC 8785  the §3.2.3 worked example, verbatim
 *   RFC 6962  MTH({}) = SHA-256(), and the empty-string digest is a constant
 *             anyone can look up
 *   RFC 8032  test vector 1's key pair, so a third-party verifier can check
 *             its Ed25519 against the same numbers the RFC publishes
 *
 * What is generated rather than asserted -- the 41 tree roots, the proof
 * paths, the chain -- is generated from an implementation that has already
 * been pinned at its boundary conditions by the above, and is then checked a
 * second time by an independent verifier in another language
 * (`conformance/verify.py`) that shares no code with it.
 *
 * Regenerating changes the frozen file. That is a deliberate act: if the
 * output moves, the format moved, and every existing bundle in the world
 * stopped verifying. `conformance.test.ts` fails on any drift so this cannot
 * happen by accident.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as ed25519Sign,
} from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalize } from '../packages/server/src/evidence/canonical.js';
import { MerkleTree, hashLeaf } from '../packages/server/src/evidence/merkle-tree.js';
import { entryDigest, GENESIS_HASH } from '../packages/server/src/evidence/audit-log.js';
import { Signer, type KeySource } from '../packages/server/src/evidence/signer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'conformance', 'vectors');

/** A known answer that did not match. Nothing is written after one of these. */
class KnownAnswerFailure extends Error {
  constructor(what: string, expected: string, actual: string) {
    super(`${what}\n  expected: ${expected}\n  actual:   ${actual}`);
    this.name = 'KnownAnswerFailure';
  }
}

function mustEqual(what: string, actual: string, expected: string): void {
  if (actual !== expected) throw new KnownAnswerFailure(what, expected, actual);
}

// ---------------------------------------------------------------- 1. canonical

/**
 * RFC 8785 §3.2.3, the worked example, exactly as published.
 *
 * It is the single densest test in the spec: key reordering, ECMAScript number
 * formatting at five different magnitudes, and the full escape table including
 * a control character, a newline, a quote and two backslashes.
 */
const RFC8785_INPUT = {
  numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
  string: "€$\u000f\nA'B\"\\\\\"/",
  literals: [null, true, false],
};

const RFC8785_EXPECTED =
  '{"literals":[null,true,false],' +
  '"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
  '"string":"€$' +
  String.raw`\u000f\nA'B\"\\\\\"` +
  '/"}';

interface CanonicalVector {
  description: string;
  /** Why this case exists, for someone writing a third implementation. */
  rationale: string;
  input: unknown;
  canonical: string;
}

interface RejectedVector {
  description: string;
  rationale: string;
  /** How to construct the value; it has no JSON representation. */
  construct: string;
  rejected: true;
}

function canonicalVectors(): {
  vectors: CanonicalVector[];
  rejected: RejectedVector[];
} {
  const vectors: CanonicalVector[] = [];

  const add = (description: string, rationale: string, input: unknown) => {
    vectors.push({ description, rationale, input, canonical: canonicalize(input) });
  };

  // Pinned to the RFC before anything else is emitted.
  mustEqual('RFC 8785 §3.2.3 worked example', canonicalize(RFC8785_INPUT), RFC8785_EXPECTED);
  vectors.push({
    description: 'RFC 8785 section 3.2.3 worked example',
    rationale:
      'The reference case from the JCS specification. Covers key ordering, ECMAScript number ' +
      'formatting across five magnitudes, and the complete string escape table.',
    input: RFC8785_INPUT,
    canonical: RFC8785_EXPECTED,
  });

  add(
    'keys sort by UTF-16 code unit, not insertion order',
    'ASCII uppercase sorts before lowercase because 0x41 < 0x61. An implementation using a ' +
      'locale-aware or case-insensitive comparison produces a different byte string here.',
    { b: 1, a: 2, C: 3, A: 4, '1': 5 },
  );

  // The case that separates UTF-16 code-unit ordering from code-point ordering.
  //
  // U+10000 is the surrogate pair D800 DC00. By code unit, D800 < FFFF, so it
  // sorts FIRST. By code point, 0xFFFF < 0x10000, so it would sort LAST. RFC
  // 8785 mandates code units. JavaScript's default sort does this for free;
  // Python's sorted() does the opposite and must be corrected explicitly.
  const astral = {
    '\u{10000}': 'non-BMP, surrogate pair D800 DC00',
    '￿': 'BMP maximum',
    a: 'ascii',
  };
  const astralOut = canonicalize(astral);
  if (astralOut.indexOf('￿') < astralOut.indexOf('\u{10000}')) {
    throw new KnownAnswerFailure(
      'UTF-16 code-unit ordering: U+10000 must sort before U+FFFF',
      'U+10000 first (leading surrogate D800 < FFFF)',
      astralOut,
    );
  }
  vectors.push({
    description: 'non-BMP key sorts before U+FFFF (code units, not code points)',
    rationale:
      'THE interoperability trap. U+10000 encodes as the surrogate pair D800 DC00, so under ' +
      'RFC 8785 UTF-16 code-unit ordering it sorts BEFORE U+FFFF. Sorting by code point -- ' +
      "which is what Python's sorted() does on str -- reverses these two keys and yields a " +
      'different digest. Any verifier that passes this vector is doing the right comparison.',
    input: astral,
    canonical: astralOut,
  });

  add(
    'Unicode is not normalized',
    'U+00E9 and U+0065 U+0301 both render as e-acute but are distinct keys. JCS canonicalizes ' +
      'JSON, not Unicode; normalizing here would silently merge two different records.',
    { 'é': 'precomposed', 'é': 'decomposed' },
  );

  add(
    'nested structures sort at every level',
    'Sorting only the top level is a common shortcut that passes flat test cases.',
    { z: { b: 1, a: 2 }, a: [{ d: 1, c: 2 }] },
  );

  add(
    'array order is data and is never sorted',
    'Objects are unordered and get sorted; arrays are ordered and must not be. Sorting both ' +
      'is a real implementation error that only shows up on arrays of scalars.',
    { list: [3, 1, 2, 'b', 'a'] },
  );

  add(
    'integers at the edge of exact representation',
    'ECMAScript numbers are IEEE 754 doubles. 2^53 and above lose integer precision, and the ' +
      'canonical form must show what was actually stored rather than what was written.',
    { max: 9007199254740991, over: 9007199254740993, neg: -9007199254740991 },
  );

  add('empty containers', 'Trivially different from null, and easy to conflate.', {
    obj: {},
    arr: [],
    str: '',
  });

  add(
    'an undefined property is absent, matching JSON.stringify',
    'The one lossy case allowed. Rejecting it would make ordinary optional fields unusable, ' +
      'and every JSON serializer in the ecosystem behaves this way.',
    { a: 1, b: undefined, c: 3 },
  );

  // Deviations from strict JCS. These are stricter, never looser: each is a
  // value RFC 8785 would serialize lossily, and losing a byte inside an audit
  // record is the failure this whole layer exists to prevent.
  const rejected: RejectedVector[] = [
    {
      description: 'negative zero',
      rationale:
        'RFC 8785 serializes -0 as "0", so the value does not round-trip. In an audit record a ' +
        'silent value change is worse than a loud failure.',
      construct: '{ "value": -0 }',
      rejected: true,
    },
    {
      description: 'NaN and Infinity',
      rationale:
        'JSON.stringify emits null for both, collapsing two distinct values into a third.',
      construct: '{ "value": NaN } and { "value": Infinity }',
      rejected: true,
    },
    {
      description: 'BigInt',
      rationale: 'JSON.stringify throws. Caught here with a message that says to format it as a string.',
      construct: '{ "value": 1n }',
      rejected: true,
    },
    {
      description: 'circular reference',
      rationale: 'Would recurse until the stack ends.',
      construct: 'const a = {}; a.self = a;',
      rejected: true,
    },
  ];

  return { vectors, rejected };
}

// ------------------------------------------------------------------ 2. merkle

const SHA256_OF_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Leaf i is the UTF-8 string `leaf-<i>`. Chosen so a third party can rebuild them. */
function leafData(i: number): string {
  return `leaf-${i}`;
}

const MAX_TREE = 40;

function merkleVectors() {
  // MTH({}) = SHA-256() -- RFC 6962 §2.1. The digest of the empty string is a
  // constant that appears in every SHA-256 test suite ever written, so this
  // check needs no trust in anything local.
  const empty = new MerkleTree();
  mustEqual('RFC 6962 MTH({}) = SHA-256()', empty.root(), SHA256_OF_EMPTY);
  mustEqual(
    'SHA-256 of the empty string',
    createHash('sha256').update('').digest('hex'),
    SHA256_OF_EMPTY,
  );

  // MTH({d0}) = SHA-256(0x00 || d0): a single leaf is the leaf hash itself,
  // with no node prefix anywhere. Verified against a direct construction that
  // does not go through the tree.
  const one = new MerkleTree();
  one.append(leafData(0));
  mustEqual(
    'RFC 6962 MTH({d(0)}) = SHA-256(0x00 || d(0))',
    one.root(),
    createHash('sha256').update(Buffer.concat([Buffer.from([0x00]), Buffer.from(leafData(0), 'utf8')])).digest('hex'),
  );
  mustEqual('hashLeaf agrees with the single-leaf root', one.root(), hashLeaf(leafData(0)).toString('hex'));

  const roots: string[] = [];
  const leafHashes: string[] = [];
  const tree = new MerkleTree();
  roots.push(tree.root()); // n = 0
  for (let i = 0; i < MAX_TREE; i++) {
    tree.append(leafData(i));
    leafHashes.push(hashLeaf(leafData(i)).toString('hex'));
    roots.push(tree.root());
  }

  // Inclusion proofs: first, last, and a middle leaf at several tree sizes,
  // including sizes that are and are not powers of two, because the odd-leaf
  // promotion path is where implementations diverge.
  const inclusion: Array<{ treeSize: number; leafIndex: number; leafHash: string; root: string; path: string[] }> = [];
  for (const size of [1, 2, 3, 4, 5, 7, 8, 9, 16, 17, 31, 40]) {
    const t = new MerkleTree();
    for (let i = 0; i < size; i++) t.append(leafData(i));
    const indices = size === 1 ? [0] : [0, Math.floor(size / 2), size - 1];
    for (const idx of new Set(indices)) {
      const proof = t.inclusionProof(idx);
      inclusion.push({
        treeSize: size,
        leafIndex: idx,
        leafHash: hashLeaf(leafData(idx)).toString('hex'),
        root: t.root(),
        path: proof.path,
      });
    }
  }

  // Consistency proofs, including the two degenerate cases (m = 0 and m = n)
  // where the path is empty and a verifier must still return true.
  const consistency: Array<{ firstSize: number; secondSize: number; firstRoot: string; secondRoot: string; path: string[] }> = [];
  for (const [m, n] of [[1, 1], [1, 2], [1, 8], [2, 3], [3, 7], [4, 8], [5, 9], [6, 11], [8, 16], [13, 29], [31, 40]] as const) {
    const first = new MerkleTree();
    for (let i = 0; i < m; i++) first.append(leafData(i));
    const second = new MerkleTree();
    for (let i = 0; i < n; i++) second.append(leafData(i));
    consistency.push({
      firstSize: m,
      secondSize: n,
      firstRoot: first.root(),
      secondRoot: second.root(),
      path: second.consistencyProof(m).path,
    });
  }

  return {
    algorithm: 'RFC 6962 Merkle hash tree, SHA-256',
    leafEncoding: 'leaf i is the UTF-8 bytes of the ASCII string `leaf-<i>`',
    domainSeparation: { leaf: '0x00', node: '0x01' },
    concatenation: 'raw 32-byte digests, never their hex text',
    emptyRoot: SHA256_OF_EMPTY,
    leafHashes,
    /** roots[n] is the root of the tree over the first n leaves. */
    roots,
    inclusion,
    consistency,
  };
}

// ------------------------------------------------------------------- 3. chain

function chainVectors() {
  const base = Date.parse('2026-01-15T09:00:00.000Z');
  const events = [
    { action: 'run.started', actor: 'you@example.test', subject: 'run_01', payload: { manifestDigest: 'sha256:abc' } },
    { action: 'provider.called', actor: 'system', subject: 'run_01', payload: { provider: 'ollama', model: 'gemma3:4b' } },
    { action: 'approval.requested', actor: 'system', subject: 'apr_01', payload: { reason: 'egress to an unlisted host' } },
    { action: 'approval.granted', actor: 'reviewer@example.test', subject: 'apr_01', payload: { rationale: 'host is on the customer allowlist' } },
    { action: 'run.completed', actor: 'system', subject: 'run_01', payload: { status: 'succeeded' } },
  ];

  const entries: Array<Record<string, unknown>> = [];
  let previousHash = GENESIS_HASH;
  events.forEach((e, i) => {
    const withoutHash = {
      seq: i,
      recordedAt: new Date(base + i * 1000).toISOString(),
      action: e.action,
      actor: e.actor,
      tenantId: 'acme',
      subject: e.subject,
      payload: e.payload,
      previousHash,
    };
    const entryHash = entryDigest(withoutHash as never);
    entries.push({ ...withoutHash, entryHash });
    previousHash = entryHash;
  });

  // The tree over the chain, which is what gets signed and anchored.
  const tree = new MerkleTree();
  for (const entry of entries) {
    tree.append(canonicalize({ ...entry, entryHash: undefined }));
  }

  return {
    genesisHash: GENESIS_HASH,
    entryHash: 'SHA-256 over the canonical JSON of the entry with `entryHash` removed',
    chaining: 'entry[i].previousHash === entry[i-1].entryHash; entry[0] uses the genesis hash',
    entries,
    /** A single-field edit, for checking that a verifier actually rejects. */
    tamperedEntry: (() => {
      const bad = JSON.parse(JSON.stringify(entries[4]));
      bad.payload.status = 'failed';
      return { entry: bad, expectBroken: true, note: 'status changed from succeeded to failed; entryHash left alone' };
    })(),
  };
}

// --------------------------------------------------------------- 4. signature

/**
 * RFC 8032 §7.1 test vector 1.
 *
 * Using a published key pair means a third-party verifier can confirm its
 * Ed25519 implementation against the RFC's own numbers before it trusts
 * anything produced here. The private key is public by construction and
 * exists only in this file.
 */
const RFC8032_SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const RFC8032_PUBLIC = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';

/** PKCS#8 wrapper for a raw Ed25519 seed: the prefix is fixed for the algorithm. */
function ed25519PrivateKeyFromSeed(seedHex: string) {
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(seedHex, 'hex'),
  ]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

async function signatureVectors() {
  const privateKey = ed25519PrivateKeyFromSeed(RFC8032_SEED);
  const publicKey = createPublicKey(privateKey);

  // The raw 32-byte public key sits at the end of the SPKI DER.
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const rawPublic = spki.subarray(spki.length - 32).toString('hex');
  mustEqual('RFC 8032 test vector 1 public key', rawPublic, RFC8032_PUBLIC);

  const keySource: KeySource = {
    keyId: 'conformance-rfc8032-tv1',
    sign: (data) => ed25519Sign(null, data, privateKey),
    publicKeyPem: () => publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };

  const signer = new Signer(keySource);

  const payload = {
    bundleId: 'bnd_conformance_0001',
    runId: 'run_01',
    tenantId: 'acme',
    merkleRoot: chainMerkleRoot(),
    entryCount: 5,
    generatedAt: '2026-01-15T09:00:05.000Z',
  };

  const envelope = await signer.sign(payload);

  return {
    algorithm: 'Ed25519 over the UTF-8 bytes of the canonical JSON of `payload`',
    note:
      '`signature.signedAt` is deliberately OUTSIDE the signed bytes. Including it would mean ' +
      're-signing to correct a clock, and the timestamp that carries weight is a timestamp ' +
      "authority's, not the signer's.",
    keySource: 'RFC 8032 section 7.1 test vector 1 -- a published key pair, not a real one',
    privateKeySeed: RFC8032_SEED,
    publicKeyRaw: RFC8032_PUBLIC,
    publicKeyPem: keySource.publicKeyPem(),
    signedBytes: canonicalize(envelope.payload),
    envelope,
    tampered: {
      envelope: { ...envelope, payload: { ...envelope.payload, entryCount: 6 } },
      expectValid: false,
      note: 'entryCount changed from 5 to 6; the signature is untouched',
    },
  };
}

function chainMerkleRoot(): string {
  const { entries } = chainVectors();
  const tree = new MerkleTree();
  for (const entry of entries) {
    tree.append(canonicalize({ ...entry, entryHash: undefined }));
  }
  return tree.root();
}

// ------------------------------------------------------------------- 5. write

async function main() {
  mkdirSync(OUT, { recursive: true });

  const { vectors, rejected } = canonicalVectors();
  const files: Array<[string, unknown]> = [
    [
      'canonicalization.json',
      {
        spec: 'RFC 8785 (JSON Canonicalization Scheme)',
        conformance:
          'agent-eval is RFC 8785 conformant over the domain of valid JSON. It is STRICTER ' +
          'outside that domain: values RFC 8785 would serialize lossily are rejected rather ' +
          'than silently changed. Those cases are listed under `rejected`.',
        keyOrdering: 'UTF-16 code units, ascending -- NOT code points, NOT locale collation',
        vectors,
        rejected,
      },
    ],
    ['merkle.json', merkleVectors()],
    ['audit-chain.json', chainVectors()],
    ['signature.json', await signatureVectors()],
  ];

  for (const [name, data] of files) {
    writeFileSync(join(OUT, name), JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.log(`wrote conformance/vectors/${name}`);
  }

  console.log('\nAll known answers matched. Vectors are pinned to RFC 8785, 6962 and 8032.');
}

main().catch((e) => {
  console.error(`\nRefusing to write vectors.\n\n${e.message}\n`);
  process.exit(1);
});
