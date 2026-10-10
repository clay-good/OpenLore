/**
 * Declared Kotlin capability target (change: add-kotlin-reference-corpus-conformance, #546).
 *
 * `missing` names each capability the language-support registry does not yet derive for Kotlin and
 * the change that adds it. The conformance test compares this with the live registry, so a
 * capability cannot appear or disappear without this file changing in the same pull request.
 */
import type { Capability } from '../language-support.js';
import type { KotlinChange } from './ledger.js';

/** Capabilities Kotlin deliberately never backs, with the reason. */
export const KOTLIN_NEVER_BACKED: Partial<Record<Capability, string>> = {
  iacProjection: 'It applies to infrastructure formats, not to general-purpose languages.',
  literalReflection: 'A Kotlin dispatch table is a map of callable references, and each reference is already an ordinary edge.',
};

export const KOTLIN_CAPABILITY_TARGET: { missing: Partial<Record<Capability, KotlinChange>> } = {
  missing: {},
};
