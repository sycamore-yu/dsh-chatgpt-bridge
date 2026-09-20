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
/** Directory names denied anywhere in the path (case-insensitive). */
const SENSITIVE_DIRECTORY_SEGMENTS = new Set([
    '.ssh',
    '.gnupg',
    '.aws',
    '.azure',
    '.kube',
    '.docker',
    '.terraform',
    '.dsh',
    '.git',
    'secrets',
    '.secrets',
]);
/** Two-segment directory prefixes denied as a pair (case-insensitive). */
const SENSITIVE_DIRECTORY_PREFIXES = [
    ['.config', 'gcloud'],
    ['.config', 'gh'],
    ['.config', 'git'],
    ['.config', 'dsh'],
];
/** Exact basenames denied (case-insensitive). */
const SENSITIVE_BASENAMES = new Set([
    '.env',
    '.envrc',
    '.netrc',
    '_netrc',
    '.npmrc',
    '.pypirc',
    '.git-credentials',
    '.gitconfig',
    '.htpasswd',
    '.pgpass',
    '.my.cnf',
    '.vault-token',
    '.dockercfg',
    '.terraformrc',
    'credentials',
    'credentials.json',
    'credential.json',
    'service-account.json',
    'serviceaccount.json',
    'chatgpt-bridge.token',
    'id_rsa',
    'id_dsa',
    'id_ecdsa',
    'id_ed25519',
    'authorized_keys',
]);
/** File extensions denied (lowercase, without the dot). */
const SENSITIVE_EXTENSIONS = new Set([
    'pem',
    'key',
    'p12',
    'pfx',
    'jks',
    'keystore',
    'ppk',
    'kdbx',
    'asc',
    'token',
    'secret',
    'secrets',
    'credentials',
]);
/** Final-extension stems denied when the stem IS the sensitive word. */
const SENSITIVE_STEMS = new Set([
    'credentials',
    'credential',
    '.credentials',
    'secret',
    'secrets',
    'token',
    'tokens',
    'apikey',
    'api-key',
    'api_key',
    'password',
    'passwd',
]);
/** `.env` and every dotfile variant of it (`.env.local`, `.env.production`). */
const DOTENV_NAME = /^\.env(\.|$)/;
/** `.credentials` and every dotted variant (`.credentials.yaml`). */
const DOTCREDENTIALS_NAME = /^\.credentials(\.|$)/;
const ALLOWED = { sensitive: false };
/**
 * Classify one workspace-relative path. Accepts either separator (`/` or `\`);
 * absolute paths and `..` segments are the caller's responsibility to reject
 * before this runs.
 */
export function classifySensitivePath(relativePath) {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (normalized === '' || normalized === '.')
        return ALLOWED;
    const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.');
    if (segments.length === 0)
        return ALLOWED;
    for (const segment of segments) {
        if (SENSITIVE_DIRECTORY_SEGMENTS.has(segment.toLowerCase())) {
            return { sensitive: true, reason: `directory:${segment.toLowerCase()}` };
        }
    }
    const lowerSegments = segments.map((segment) => segment.toLowerCase());
    for (const prefix of SENSITIVE_DIRECTORY_PREFIXES) {
        for (let index = 0; index + prefix.length <= lowerSegments.length; index += 1) {
            if (prefix.every((part, offset) => lowerSegments[index + offset] === part)) {
                return { sensitive: true, reason: `directory:${prefix.join('/')}` };
            }
        }
    }
    const basename = segments[segments.length - 1].toLowerCase();
    if (SENSITIVE_BASENAMES.has(basename))
        return { sensitive: true, reason: `basename:${basename}` };
    if (DOTENV_NAME.test(basename))
        return { sensitive: true, reason: 'dotenv' };
    if (DOTCREDENTIALS_NAME.test(basename))
        return { sensitive: true, reason: 'credentials' };
    if (/^\.env/i.test(basename))
        return { sensitive: true, reason: 'dotenv' };
    const dot = basename.lastIndexOf('.');
    if (dot > 0) {
        const extension = basename.slice(dot + 1);
        if (SENSITIVE_EXTENSIONS.has(extension))
            return { sensitive: true, reason: `extension:${extension}` };
        const stem = basename.slice(0, dot);
        if (SENSITIVE_STEMS.has(stem))
            return { sensitive: true, reason: `stem:${stem}` };
    }
    return ALLOWED;
}
/** Convenience boolean form of {@link classifySensitivePath}. */
export function isSensitiveRelativePath(relativePath) {
    return classifySensitivePath(relativePath).sensitive;
}
/**
 * Glob patterns that exclude every sensitive directory from a ripgrep search.
 * Kept next to the policy so the search engine cannot drift from it; the
 * per-match classifier is still applied as the authoritative post-filter.
 */
export function sensitiveSearchGlobs() {
    const globs = [];
    for (const segment of SENSITIVE_DIRECTORY_SEGMENTS) {
        globs.push(`!**/${segment}/**`);
        globs.push(`!${segment}/**`);
    }
    for (const prefix of SENSITIVE_DIRECTORY_PREFIXES) {
        globs.push(`!**/${prefix.join('/')}/**`);
    }
    return globs;
}
