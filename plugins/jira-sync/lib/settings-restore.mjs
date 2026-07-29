/**
 * settings-restore.mjs — Settings restore utilities (pure functions, no I/O).
 *
 * Responsibilities:
 *  - isPlainObject / deepMerge — deep-merge two settings objects with a
 *    key-level callback for conflict resolution.
 *  - SECRET_KEY_RE — regex matching secret/token/api-key field names
 *    that must be preserved from the LOCAL file during a restore merge.
 *
 * These are extracted from mcp-server/index.mjs so they can be unit-tested
 * and imported independently.
 */

// ---------------------------------------------------------------------------
// deep merge helpers
// ---------------------------------------------------------------------------

/**
 * True when `v` is a plain object (not null, not an array).
 */
export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep-merge two settings objects.
 *
 * Traversal rules:
 *  - A key that exists **only** in `cloud` → imported as-is.
 *  - A key that is a plain object in BOTH → recursive merge.
 *  - Otherwise (both exist, but at least one is NOT a plain object) →
 *    the `decide(key, localVal, cloudVal)` callback picks the winner.
 *
 * The callback may return:
 *  - any value   → used as the merged result for that key
 *  - null        → (shouldn't happen) falls back to a recursive merge attempt
 *
 * @param {object}   local  - the local settings (secrets intact)
 * @param {object}   cloud  - the cloud backup (secrets REDACTED)
 * @param {function} decide - (key: string, localVal: any, cloudVal: any) => any
 * @returns {object} merged result
 */
export function deepMerge(local, cloud, decide) {
  const result = { ...local };
  for (const key of Object.keys(cloud)) {
    const localVal = local[key];
    const cloudVal = cloud[key];
    if (localVal === undefined) {
      // Only in cloud — import
      result[key] = cloudVal;
    } else if (isPlainObject(localVal) && isPlainObject(cloudVal)) {
      // Both objects — recurse
      result[key] = deepMerge(localVal, cloudVal, decide);
    } else {
      // Both exist, not both objects — ask callback
      const decision = decide(key, localVal, cloudVal);
      if (decision !== null) {
        result[key] = decision;
      } else {
        // null means recurse (shouldn't happen here but be safe)
        result[key] = deepMerge(
          isPlainObject(localVal) ? localVal : {},
          isPlainObject(cloudVal) ? cloudVal : {},
          decide
        );
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Secret-key heuristic
// ---------------------------------------------------------------------------

/**
 * Regex that matches JSON keys whose VALUES should be kept from the LOCAL
 * file during a merge (because the cloud backup has them redacted).
 *
 * Applied case-insensitively against the key name.
 */
export const SECRET_KEY_RE = /token|secret|password|api[_-]?key|credential|access[_-]?key|private[_-]?key/i;
