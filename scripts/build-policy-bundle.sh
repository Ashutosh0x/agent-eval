#!/usr/bin/env bash
#
# Compile policies/*.rego to a WebAssembly bundle the server evaluates in-process.
#
# WHY IN-PROCESS RATHER THAN AN OPA SIDECAR. A tool-call gate that has to cross
# a network boundary fails open the moment the sidecar is unreachable, unless
# every call site remembers to treat a connection error as a deny. Compiling to
# WASM puts the decision in the same process as the thing being gated, so
# "the policy engine is down" and "the policy said no" cannot be confused.
#
# The .wasm is committed so a deployment can run the server without the OPA
# toolchain. Re-run this script whenever a .rego changes, and commit the result;
# CI verifies the two are in sync.
#
# Requires the `opa` binary (https://openpolicyagent.org/docs/latest/#running-opa).
# Set OPA_BIN to point at it, otherwise the script looks on PATH and then in
# .tools/.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/packages/server/policy-bundle"

# Resolve the binary: explicit override, then PATH, then the local .tools copy.
if [[ -n "${OPA_BIN:-}" ]]; then
  OPA="$OPA_BIN"
elif command -v opa >/dev/null 2>&1; then
  OPA="opa"
elif [[ -x "$ROOT/.tools/opa.exe" ]]; then
  OPA="$ROOT/.tools/opa.exe"
elif [[ -x "$ROOT/.tools/opa" ]]; then
  OPA="$ROOT/.tools/opa"
else
  echo "error: opa binary not found. Install it or set OPA_BIN." >&2
  exit 1
fi

echo "==> opa: $("$OPA" version | head -1)"

# The policies must pass their own tests before they are compiled. Shipping a
# bundle built from failing policy is worse than shipping no bundle: the engine
# fails closed without one, but a wrong bundle denies and allows confidently.
echo "==> testing policies"
"$OPA" test "$ROOT/policies/" --format pretty

# Entrypoints are named explicitly. Building "everything" would also export the
# test rules (data.agenteval.*.test_*), which are not decisions and must not be
# reachable from the evaluator.
echo "==> compiling to wasm"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

"$OPA" build \
  --target wasm \
  --entrypoint agenteval/approval/require_approval \
  --entrypoint agenteval/egress/allow_egress \
  --entrypoint agenteval/budget/deny_budget \
  --entrypoint agenteval/authz/allow \
  --ignore 'tests' \
  --output "$TMP/bundle.tar.gz" \
  "$ROOT/policies/"

mkdir -p "$OUT_DIR"
tar xzf "$TMP/bundle.tar.gz" -C "$TMP"
cp "$TMP/policy.wasm" "$OUT_DIR/policy.wasm"
cp "$TMP/.manifest" "$OUT_DIR/manifest.json"

echo "==> wrote $OUT_DIR/policy.wasm ($(wc -c < "$OUT_DIR/policy.wasm") bytes)"
echo "==> entrypoints:"
node -e '
  const m = require(process.argv[1]);
  for (const w of m.wasm ?? []) console.log("    " + w.entrypoint);
' "$OUT_DIR/manifest.json"
