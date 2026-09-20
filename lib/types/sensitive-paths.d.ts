/**
 * Sensitive-path policy for the Bridge direct-workspace channel.
 *
 * One pure predicate, no configuration toggles and no caller reasoning: given a
 * workspace-RELATIVE path (already proven inside a registered workspace), decide
 * whether the Bridge may read, list, search or write it. The verdict depends
 * only on the path spelling, so it cannot be influenced by Goal free text, tool
 * arguments beyond the path itself, or any model-supplied justification.
 *
 * Denylisted classes (see the lists below for the exact spellings):
 *   - dotenv and shell credential files (.env*, .netrc, .npmrc, ...)
 *   - private keys and keystores (*.pem, *.key, id_rsa, *.p12, *.kdbx, ...)
 *   - SSH / GPG / cloud / container credential directories
 *   - token, secret and credential files by name or extension
 *   - git internals (`.git`): reading it can leak remote URLs with embedded
 *     credentials, and writing it would bypass the read-only git guarantee
 *   - DSH and Bridge's own authentication material (.dsh, *.token, secrets/)
 *
 * The policy is deliberately over-inclusive: a false positive is an explicit
 * SENSITIVE_PATH_DENIED the caller can work around through the Goal channel,
 * while a false negative would leak a secret.
 */
export interface SensitivePathVerdict {
    /** True when the path must be refused. */
    sensitive: boolean;
    /** Short machine-readable class used in error details and tests. */
    reason?: string;
}
/**
 * Classify one workspace-relative path. Accepts either separator (`/` or `\`);
 * absolute paths and `..` segments are the caller's responsibility to reject
 * before this runs.
 */
export declare function classifySensitivePath(relativePath: string): SensitivePathVerdict;
/** Convenience boolean form of {@link classifySensitivePath}. */
export declare function isSensitiveRelativePath(relativePath: string): boolean;
/**
 * Glob patterns that exclude every sensitive directory from a ripgrep search.
 * Kept next to the policy so the search engine cannot drift from it; the
 * per-match classifier is still applied as the authoritative post-filter.
 */
export declare function sensitiveSearchGlobs(): string[];
