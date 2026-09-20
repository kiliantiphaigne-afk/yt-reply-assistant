// =============================================================================
// Prompt Builder
// Constructs the user prompt for suggestion generation
// =============================================================================

/**
 * Build the user prompt for generating reply suggestions.
 *
 * @param {object} params
 * @param {string} params.commentText - The comment to reply to
 * @param {string} params.commentAuthor - Name of the commenter
 * @param {string} params.videoTitle - Title of the video
 * @param {string} params.videoTranscript - Transcript text (may be empty)
 * @param {boolean} params.partialContext - True if transcript is unavailable
 * @returns {string} The user prompt
 */
export function buildUserPrompt({
  commentText,
  commentAuthor,
  videoTitle,
  videoTranscript,
  partialContext,
}) {
  const contextSection = videoTranscript
    ? `VIDEO TRANSCRIPT (for context):
---
${truncate(videoTranscript, 3000)}
---`
    : partialContext
      ? `(No transcript available for this video — rely on the title and comment only)`
      : '';

  return `VIDEO: "${videoTitle}"

${contextSection}

COMMENT by ${commentAuthor}:
"${commentText}"

Generate exactly 3 reply suggestions, each on its own line, prefixed with [1], [2], [3].

[1] = Engaging direct reply: respond to their specific point + ask a follow-up question
[2] = Deeper reply: connect their comment to something from the video + open discussion
[3] = Short & warm reply: brief acknowledgment + micro-question (1-2 sentences max)

Rules:
- Each reply must feel natural and personal, NOT template-like
- Do NOT start all 3 replies the same way
- Do NOT use generic phrases like "Great question!" or "Thanks for sharing!"
- Each reply should be self-contained (not reference the other suggestions)
- Match the creator's style exactly (see system prompt)

Output ONLY the 3 replies, nothing else.`;
}

/**
 * Parse the AI response into 3 individual suggestions.
 */
export function parseSuggestions(rawResponse) {
  const lines = rawResponse.split('\n').filter((l) => l.trim());
  const suggestions = [];

  for (const line of lines) {
    // Match [1], [2], [3] prefixes (with optional space/dash after)
    const match = line.match(/^\[([123])\][\s\-:]*(.+)/);
    if (match) {
      suggestions.push(match[2].trim());
    }
  }

  // If parsing failed, try splitting by numbered lines
  if (suggestions.length < 3) {
    suggestions.length = 0;
    for (const line of lines) {
      const altMatch = line.match(/^([123])[\.\)\-:]\s*(.+)/);
      if (altMatch) {
        suggestions.push(altMatch[2].trim());
      }
    }
  }

  // Last resort: take the first 3 non-empty lines
  if (suggestions.length < 3) {
    suggestions.length = 0;
    for (const line of lines) {
      const cleaned = line.replace(/^\[?\d\]?[\.\)\-:\s]*/, '').trim();
      if (cleaned.length > 10) {
        suggestions.push(cleaned);
        if (suggestions.length >= 3) break;
      }
    }
  }

  // Ensure we always return exactly 3 (pad if needed)
  while (suggestions.length < 3) {
    suggestions.push('');
  }

  return suggestions.slice(0, 3);
}

function truncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}
