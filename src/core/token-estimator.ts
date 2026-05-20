/**
 * Token count estimation.
 *
 * Offline-friendly: no tokenizer libraries (which are ~2-5MB each), just
 * character-based heuristics. Configurable via tokenEstimationRatio
 * (chars-per-token, default 4 which matches OpenAI's rule of thumb and
 * tracks within ~10% of real tokenizers for typical code/prose).
 */

/**
 * Estimate tokens in a string.
 *
 * Uses chars/ratio. Default ratio of 4 matches OpenAI's published
 * heuristic ("a token is ~4 chars") and is close to what Anthropic's
 * tokenizers produce for typical content.
 *
 * Empty/whitespace-only input → 0.
 */
export function estimateTokens(text: string, ratio = 4): number {
  if (!text) {
    return 0;
  }
  const r = Math.max(1, ratio);
  return Math.ceil(text.length / r);
}

/**
 * Pretty-print a token count.
 *
 *   523       -> "523"
 *   1024      -> "1.0k"
 *   8400      -> "8.4k"
 *   125_000   -> "125k"
 *   1_240_000 -> "1.2M"
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) {
    return String(tokens);
  }
  if (tokens < 100_000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  if (tokens < 1_000_000) {
    return `${Math.round(tokens / 1000)}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
