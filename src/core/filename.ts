/**
 * Filename sanitization — pure, VS-Code-free string logic.
 */

/**
 * Sanitize a string (e.g. a package.json "name" field, which may be a
 * scoped package like "@org/app") into a safe single filesystem path
 * segment: strips characters that are invalid (or awkward) in a filename
 * on Windows/macOS/Linux — including "/", which a scoped package name
 * would otherwise turn into an extra path segment — collapses whitespace,
 * and trims leading/trailing "-". Returns an empty string if nothing
 * meaningful remains, leaving the fallback decision to the caller.
 */
export function sanitizeFilenameSegment(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}
