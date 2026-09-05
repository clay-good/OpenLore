/**
 * `node --import ./scripts/optional-absence-register.mjs …` installs the smoke-run module hooks.
 * Split from the hooks themselves because `module.register` loads them on a separate thread.
 */
import { register } from 'node:module';
register('./optional-absence-hook.mjs', import.meta.url);
