# Certified Scale Envelope

OpenLore certifies the `ci-small-v1` tier: the deterministic, measured
`certified-scale-typescript-v1` fixture with 24 files, 1,721 source bytes, 1 language, and 24
expected symbols. The authoritative machine-readable record is
[`benchmarks/certified-scale-v1.json`](../benchmarks/certified-scale-v1.json); regenerate its
measured observations with `npm run measure:certified-scale`.

## Certified objectives

| Surface | Certified ceiling |
|---|---:|
| Cold analyze | 5,000 ms |
| Warm query | 100 ms |
| Single-file publication | 10,000 ms |
| Peak memory | 536,870,912 bytes |

## Published observations

All values below are **measured**, not extrapolated. They were observed on 2026-08-23 with
`darwin-arm64-node-26.7.0`: darwin 25.6.0, Apple M4, 10 logical CPUs,
34,359,738,368 bytes of memory, and Node.js 26.7.0. The source command was
`npm run measure:certified-scale`.

| Operation | Metric | Observation | Label |
|---|---|---:|---|
| cold | elapsed | 609.43 ms | measured |
| warm | elapsed | 2.051 ms | measured |
| edit | elapsed | 4,887.198 ms | measured |
| add | elapsed | 4,606.903 ms | measured |
| delete | elapsed | 4,536.25 ms | measured |
| rename | elapsed | 4,525.402 ms | measured |
| peak-memory | maximum-resident-set | 231,964,672 bytes | measured |

Certification also requires all 9 registered `semantic-answer-v1` equivalence rows to pass via
`npm run test:equivalence`. CI checks those outcomes and this document's exact agreement with the
manifest; it does not treat machine-specific wall-clock observations as portable thresholds.

## Beyond the certified tier

Repositories larger or more complex than this fixture remain supported on a **best-effort**
performance basis. The certified objectives above do not apply until a larger tier has a complete
cold, warm, edit, add, delete, rename, and peak-memory matrix plus a passing equivalence suite.
