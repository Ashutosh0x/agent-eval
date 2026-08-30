#!/usr/bin/env bash
#
# DGX Spark environment check.
#
# Every line of output below comes from running something. There is no branch
# that prints a tick because a variable was set: if a check cannot be
# performed, it says so and why. A preflight script that reports success it
# did not verify is worse than no script, because it is believed once and
# then trusted afterwards.
#
# Exit codes:
#   0  every required check passed
#   1  a required check failed
#   2  the script could not run its checks at all
#
# Optional checks (Docker, the NVIDIA container runtime, a serving runtime)
# report their state and do not fail the run: agent-eval executes remote
# providers without any of them.

set -uo pipefail

PASS=0
FAIL=0
WARN=0

green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
amber() { printf '\033[33m%s\033[0m' "$1"; }
dim()   { printf '\033[2m%s\033[0m' "$1"; }

pass() { printf '  %s  %-26s %s\n' "$(green PASS)" "$1" "$2"; PASS=$((PASS + 1)); }
fail() { printf '  %s  %-26s %s\n' "$(red FAIL)" "$1" "$2"; FAIL=$((FAIL + 1)); }
warn() { printf '  %s  %-26s %s\n' "$(amber '----')" "$1" "$2"; WARN=$((WARN + 1)); }

have() { command -v "$1" >/dev/null 2>&1; }

echo
echo "  agent-eval — DGX Spark environment check"
echo "  $(dim "$(date -u '+%Y-%m-%dT%H:%M:%SZ')")"
echo

# ---------------------------------------------------------------- platform

OS="$(uname -s 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"

if [ "$OS" = "Linux" ]; then
  pass "operating system" "Linux"
else
  fail "operating system" "$OS — DGX Spark runs Linux (DGX OS, Ubuntu 24.04 base)"
fi

# DGX Spark is an Arm platform. This is the check that most often explains a
# container failing to start later, so it is required rather than advisory.
case "$ARCH" in
  aarch64|arm64) pass "architecture" "$ARCH" ;;
  *)             fail "architecture" "$ARCH — DGX Spark is arm64; x86-only images will not run" ;;
esac

if [ -r /etc/dgx-release ]; then
  pass "DGX OS" "$(grep -m1 -o 'DGX_PRETTY_NAME="[^"]*"' /etc/dgx-release 2>/dev/null | cut -d'"' -f2 || echo 'present')"
elif [ -r /etc/os-release ]; then
  warn "DGX OS" "not found; base OS is $(grep -m1 PRETTY_NAME /etc/os-release | cut -d'"' -f2)"
else
  warn "DGX OS" "no /etc/dgx-release or /etc/os-release to read"
fi

# ---------------------------------------------------------------- GPU

if have nvidia-smi; then
  GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)"
  if [ -n "$GPU_NAME" ]; then
    pass "NVIDIA GPU" "$GPU_NAME"

    # GB10 is the DGX Spark part. Anything else is a working NVIDIA GPU that
    # is not this platform, which is worth saying rather than glossing.
    if printf '%s' "$GPU_NAME" | grep -qiE 'GB10|grace[[:space:]]*blackwell'; then
      pass "GB10 / Grace Blackwell" "$GPU_NAME"
    else
      warn "GB10 / Grace Blackwell" "GPU present but not identified as a DGX Spark part"
    fi

    DRIVER="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)"
    [ -n "$DRIVER" ] && pass "driver" "$DRIVER" || warn "driver" "nvidia-smi did not report a version"

    CC="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1)"
    [ -n "$CC" ] && [ "$CC" != "[N/A]" ] && pass "compute capability" "$CC" \
      || warn "compute capability" "not reported by this driver"
  else
    fail "NVIDIA GPU" "nvidia-smi ran but listed no GPUs"
  fi
else
  fail "NVIDIA GPU" "nvidia-smi not found — no NVIDIA driver stack on PATH"
fi

# CUDA: the toolkit and the driver's maximum are different numbers, and
# conflating them has sent people to debug the wrong one.
if have nvcc; then
  pass "CUDA toolkit" "$(nvcc --version 2>/dev/null | grep -o 'release [0-9.]*' | head -1 | cut -d' ' -f2)"
elif have nvidia-smi; then
  CUDA_MAX="$(nvidia-smi 2>/dev/null | grep -o 'CUDA Version: *[0-9.]*' | head -1 | grep -o '[0-9.]*')"
  warn "CUDA toolkit" "nvcc not found; driver supports up to ${CUDA_MAX:-unknown}"
else
  warn "CUDA toolkit" "neither nvcc nor nvidia-smi available"
fi

# ---------------------------------------------------------------- memory

if [ -r /proc/meminfo ]; then
  MEM_KB="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
  MEM_GIB=$((MEM_KB / 1024 / 1024))
  pass "system memory" "${MEM_GIB} GiB total"
  # DGX Spark ships 128 GB of unified LPDDR5x. Reported as information, never
  # as a threshold: agent-eval runs on far less when using remote providers.
  if [ "$MEM_GIB" -lt 100 ]; then
    warn "unified memory" "${MEM_GIB} GiB — DGX Spark specifies 128 GB unified"
  fi
else
  warn "system memory" "no /proc/meminfo"
fi

# ---------------------------------------------------------------- containers

if have docker; then
  if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    pass "docker" "server $(docker version --format '{{.Server.Version}}' 2>/dev/null)"

    # The NVIDIA Container Toolkit registers a runtime named "nvidia". Its
    # presence is the difference between --gpus all working and failing, so it
    # is checked through docker rather than by looking for a file on disk.
    if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"nvidia"'; then
      pass "NVIDIA container runtime" "runtime \"nvidia\" registered with Docker"
    else
      warn "NVIDIA container runtime" "not registered; GPU containers will not start"
    fi
  else
    warn "docker" "installed but the daemon did not respond"
  fi
else
  warn "docker" "not installed — needed only for containerised runtimes"
fi

# ---------------------------------------------------------------- runtimes

check_http() {
  local name="$1" url="$2" hint="$3"
  if [ -z "$url" ]; then
    warn "$name" "$hint"
    return
  fi
  if have curl && curl -fsS --max-time 4 "$url" >/dev/null 2>&1; then
    pass "$name" "answered at $url"
  else
    warn "$name" "no response at $url"
  fi
}

check_http "ollama" "${OLLAMA_BASE_URL:-http://127.0.0.1:11434}/api/tags" "set OLLAMA_BASE_URL"
check_http "vLLM" "${VLLM_BASE_URL:-}" "set VLLM_BASE_URL to an OpenAI-compatible endpoint"
check_http "TensorRT-LLM" "${TENSORRT_LLM_BASE_URL:-}" "set TENSORRT_LLM_BASE_URL (trtllm-serve)"
check_http "NIM" "${NIM_BASE_URL:-}" "set NIM_BASE_URL to a running NIM container"

# ---------------------------------------------------------------- toolchain

if have node; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
  if [ "${NODE_MAJOR:-0}" -ge 20 ]; then
    pass "node" "$(node -v) on $(node -p 'process.arch')"
  else
    fail "node" "$(node -v) — 20 or newer required"
  fi
else
  fail "node" "not installed"
fi

have pnpm && pass "pnpm" "$(pnpm --version)" || warn "pnpm" "not installed — corepack enable"

# agent-eval stores provider credentials encrypted and refuses to store them
# at all without this. Checked here because the failure otherwise appears
# much later, when somebody tries to save a key.
if [ -n "${AGENT_EVAL_ENCRYPTION_KEY:-}" ]; then
  if printf '%s' "$AGENT_EVAL_ENCRYPTION_KEY" | grep -qE '^[0-9a-fA-F]{64}$'; then
    pass "encryption key" "64 hex characters"
  else
    fail "encryption key" "AGENT_EVAL_ENCRYPTION_KEY must be exactly 64 hex characters"
  fi
else
  warn "encryption key" "AGENT_EVAL_ENCRYPTION_KEY unset — provider credentials cannot be stored"
fi

# ---------------------------------------------------------------- summary

echo
printf '  %s passed, %s failed, %s advisory\n' "$PASS" "$FAIL" "$WARN"

if [ "$FAIL" -gt 0 ]; then
  echo
  echo "  $(red 'This host does not meet the DGX Spark requirements above.')"
  echo "  $(dim 'agent-eval still runs here against remote providers; local GPU execution does not.')"
  echo
  exit 1
fi

echo
echo "  $(green 'Required checks passed.')"
[ "$WARN" -gt 0 ] && echo "  $(dim 'Advisory items above are optional for remote-provider evaluation.')"
echo
exit 0
