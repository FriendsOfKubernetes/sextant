#!/bin/sh
# Builds the test backend into ../fixtures/guest.wasm (needs the wasm32-wasip2 target: rustup target add wasm32-wasip2).
set -eu
cd "$(dirname "$0")"
cargo build --release --target wasm32-wasip2 --target-dir ../../../../target/ext-guest
mkdir -p ../fixtures
cp ../../../../target/ext-guest/wasm32-wasip2/release/sextant_test_backend.wasm ../fixtures/guest.wasm
ls -l ../fixtures/guest.wasm
