#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"

# Install wasm-pack if not present
if ! command -v wasm-pack &>/dev/null; then
  echo "Installing wasm-pack..."
  curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
fi

# Install Rust wasm32 target if not present
if ! rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown; then
  echo "Adding wasm32-unknown-unknown target..."
  rustup target add wasm32-unknown-unknown
fi

wasm-pack build wasm \
  --target bundler \
  --out-dir ../frontend/src/wasm-pkg \
  --release

echo "WASM build complete → frontend/src/wasm-pkg/"
