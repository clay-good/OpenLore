#!/bin/sh
set -eu

tar -C /source --exclude='./bench/results' -cf - . | tar -C /workspace -xf -
ln -s /results /workspace/bench/results
npm ci
npm run build
exec node --import tsx bench/run.ts --inside-container "$@"
