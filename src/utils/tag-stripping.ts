/**
 * Tag Stripping Utilities
 *
 * Implements the dual-tag system for meta-observation control:
 * 1. <claude-mem-context> - System-level tag for auto-injected observations
 *    (prevents recursive storage when context injection is active)
 * 2. <private> - User-level tag for manual privacy control
 *    (allows users to mark content they don't want persisted)
 *
 * EDGE PROCESSING PATTERN: Filter at hook layer before sending to storage.
 */

/**
 * Maximum number of tags allowed in a single content block
 * Protects against ReDoS attacks with many nested/unclosed tags
 */
const MAX_TAG_COUNT = 100;

/**
 * Count total number of opening tags in content
 */
function countTags(content: string): number {
  const privateCount = (content.match(/<private>/g) || []).length;
  const contextCount = (content.match(/<claude-mem-context>/g) || []).length;
  return privateCount + contextCount;
}

/**
 * Strip memory tags from JSON-serialized content (tool inputs/responses)
 *
 * @param content - Stringified JSON content from tool_input or tool_response
 * @returns Cleaned content with tags removed, or '{}' if non-string/invalid
 */
export function stripMemoryTagsFromJson(content: string): string {
  if (typeof content !== 'string') {
    return '{}';  // Safe default for JSON context
  }

  // ReDoS protection: limit tag count before regex processing
  if (countTags(content) > MAX_TAG_COUNT) {
    // Log and continue - still process the content
    console.error('[tag-stripping] Tag count exceeds limit');
  }

  return content
    .replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g, '')
    .replace(/<private>[\s\S]*?<\/private>/g, '')
    .trim();
}

/**
 * Strip memory tags from user prompt content
 *
 * @param content - Raw user prompt text
 * @returns Cleaned content with tags removed, or '' if non-string/invalid
 */
export function stripMemoryTagsFromPrompt(content: string): string {
  if (typeof content !== 'string') {
    return '';  // Safe default for prompt content
  }

  // ReDoS protection: limit tag count before regex processing
  if (countTags(content) > MAX_TAG_COUNT) {
    console.error('[tag-stripping] Tag count exceeds limit');
  }

  return content
    .replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/g, '')
    .replace(/<private>[\s\S]*?<\/private>/g, '')
    .trim();
}
