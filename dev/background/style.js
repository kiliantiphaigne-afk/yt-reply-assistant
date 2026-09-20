// =============================================================================
// Style Profile Manager
// Builds and maintains the creator's reply style profile
// =============================================================================

const MAX_REPLIES_STORED = 50;
const REGEN_EVERY_N = 20;

/**
 * Get the current style profile (system prompt).
 * Returns null if not yet built.
 */
export async function getStyleProfile() {
  const { styleProfile } = await chrome.storage.local.get('styleProfile');
  return styleProfile || null;
}

/**
 * Get info about the style profile for the settings page.
 */
export async function getStyleInfo() {
  const { styleProfile, styleReplies = [] } =
    await chrome.storage.local.get(['styleProfile', 'styleReplies']);

  return {
    built: !!styleProfile,
    replyCount: styleReplies.length,
    summary: styleProfile?.summary || null,
    systemPrompt: styleProfile?.systemPrompt || null,
  };
}

/**
 * Build the style profile from an array of reply texts.
 * Called during onboarding (with scraped replies) and during regen.
 */
export async function buildStyleProfile(replies) {
  if (!replies || replies.length === 0) {
    return { error: 'No replies to analyze' };
  }

  // Store replies
  await chrome.storage.local.set({ styleReplies: replies.slice(0, MAX_REPLIES_STORED) });

  // Analyze patterns
  const analysis = analyzeReplies(replies);

  // Build system prompt
  const systemPrompt = buildSystemPrompt(analysis, replies);

  const profile = {
    summary: analysis.summary,
    systemPrompt,
    builtAt: Date.now(),
    replyCount: replies.length,
  };

  await chrome.storage.local.set({ styleProfile: profile });

  return profile;
}

/**
 * Record a new reply (posted by the creator) for continuous learning.
 */
export async function recordReply(replyText) {
  if (!replyText || replyText.trim().length < 5) return;

  const { styleReplies = [], styleReplyCounter = 0 } =
    await chrome.storage.local.get(['styleReplies', 'styleReplyCounter']);

  // Add new reply, keep max
  styleReplies.push(replyText.trim());
  if (styleReplies.length > MAX_REPLIES_STORED) {
    styleReplies.shift();
  }

  const newCounter = styleReplyCounter + 1;

  await chrome.storage.local.set({
    styleReplies,
    styleReplyCounter: newCounter,
  });

  // Regen profile every N replies
  if (newCounter >= REGEN_EVERY_N) {
    await buildStyleProfile(styleReplies);
    await chrome.storage.local.set({ styleReplyCounter: 0 });
  }
}

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

function analyzeReplies(replies) {
  const lengths = replies.map((r) => r.length);
  const avgLength = Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length);

  // Word count
  const wordCounts = replies.map((r) => r.split(/\s+/).length);
  const avgWords = Math.round(wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length);

  // Emoji detection
  const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
  const emojiCounts = replies.map((r) => (r.match(emojiRegex) || []).length);
  const totalEmojis = emojiCounts.reduce((a, b) => a + b, 0);
  const emojiFrequency = totalEmojis / replies.length;
  const commonEmojis = findCommonEmojis(replies);

  // Language detection (simple heuristic)
  const frenchMarkers = /\b(je|tu|il|elle|nous|vous|ils|elles|c'est|oui|merci|très|bien|aussi|avec|pour|dans|mais|que|qui|est|les|des|une|pas)\b/gi;
  const englishMarkers = /\b(the|is|are|was|were|have|has|been|this|that|with|for|and|but|not|you|your|they|from|what|which)\b/gi;

  let frenchScore = 0;
  let englishScore = 0;
  for (const r of replies) {
    frenchScore += (r.match(frenchMarkers) || []).length;
    englishScore += (r.match(englishMarkers) || []).length;
  }
  const language = frenchScore > englishScore ? 'french' : 'english';

  // Formality detection
  const tuCount = replies.filter((r) => /\b(tu|toi|ton|ta|tes)\b/i.test(r)).length;
  const vousCount = replies.filter((r) => /\b(vous|votre|vos)\b/i.test(r)).length;
  const formality =
    language === 'french'
      ? tuCount > vousCount
        ? 'informal-tu'
        : 'formal-vous'
      : 'casual';

  // Question frequency
  const questionReplies = replies.filter((r) => r.includes('?')).length;
  const questionRate = questionReplies / replies.length;

  // Opening/closing patterns
  const openings = findPatterns(replies, 'opening');
  const closings = findPatterns(replies, 'closing');

  // Exclamation usage
  const exclamationReplies = replies.filter((r) => r.includes('!')).length;
  const exclamationRate = exclamationReplies / replies.length;

  const summary = [
    `Language: ${language}`,
    `Style: ${formality}`,
    `Average length: ~${avgWords} words`,
    emojiFrequency > 0.3
      ? `Emojis: frequent (${commonEmojis.slice(0, 5).join(' ')})`
      : emojiFrequency > 0
        ? 'Emojis: occasional'
        : 'Emojis: rare',
    questionRate > 0.3 ? 'Often asks questions' : 'Rarely asks questions',
    exclamationRate > 0.5 ? 'Enthusiastic tone (!)' : 'Calm tone',
  ].join(' | ');

  return {
    language,
    formality,
    avgLength,
    avgWords,
    emojiFrequency,
    commonEmojis,
    questionRate,
    exclamationRate,
    openings,
    closings,
    summary,
  };
}

function findCommonEmojis(replies) {
  const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
  const counts = {};
  for (const r of replies) {
    const emojis = r.match(emojiRegex) || [];
    for (const e of emojis) {
      counts[e] = (counts[e] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([e]) => e);
}

function findPatterns(replies, position) {
  const patterns = {};
  for (const r of replies) {
    const words = r.split(/\s+/);
    if (words.length < 2) continue;

    const segment =
      position === 'opening'
        ? words.slice(0, Math.min(3, words.length)).join(' ').toLowerCase()
        : words
            .slice(Math.max(0, words.length - 3))
            .join(' ')
            .toLowerCase();

    patterns[segment] = (patterns[segment] || 0) + 1;
  }

  return Object.entries(patterns)
    .filter(([, count]) => count >= 2)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([p]) => p);
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(analysis, replies) {
  const {
    language,
    formality,
    avgWords,
    emojiFrequency,
    commonEmojis,
    questionRate,
    exclamationRate,
    openings,
    closings,
  } = analysis;

  const langInstruction =
    language === 'french'
      ? 'Reponds TOUJOURS en francais.'
      : 'Always reply in English.';

  const formalityInstruction =
    formality === 'informal-tu'
      ? 'Utilise le tutoiement (tu/toi). Ton informel et proche.'
      : formality === 'formal-vous'
        ? 'Utilise le vouvoiement (vous). Ton respectueux mais chaleureux.'
        : 'Use a casual, friendly tone.';

  const lengthInstruction =
    language === 'french'
      ? `Longueur cible : ~${avgWords} mots par reponse. Pas de pavés.`
      : `Target length: ~${avgWords} words per reply. Keep it concise.`;

  let emojiInstruction = '';
  if (emojiFrequency > 0.5 && commonEmojis.length > 0) {
    emojiInstruction = `Utilise des emojis regulierement, surtout : ${commonEmojis.slice(0, 5).join(' ')}`;
  } else if (emojiFrequency > 0.1) {
    emojiInstruction = 'Utilise des emojis occasionnellement.';
  } else {
    emojiInstruction =
      language === 'french'
        ? "N'utilise pas ou tres peu d'emojis."
        : "Don't use emojis, or very rarely.";
  }

  const questionInstruction =
    questionRate > 0.3
      ? language === 'french'
        ? 'Pose souvent une question de relance pour engager la conversation.'
        : 'Often ask a follow-up question to engage the conversation.'
      : '';

  const exclamationInstruction =
    exclamationRate > 0.5
      ? language === 'french'
        ? 'Ton enthousiaste — utilise des points d\'exclamation.'
        : 'Enthusiastic tone — use exclamation marks.'
      : '';

  // Include a few example replies for few-shot learning
  const exampleReplies = replies
    .slice(0, 5)
    .map((r, i) => `Example ${i + 1}: "${r}"`)
    .join('\n');

  const systemPrompt = `You are a YouTube creator replying to comments on your videos.
Your goal is to write engaging, authentic replies that match the creator's personal style.

STYLE RULES:
- ${langInstruction}
- ${formalityInstruction}
- ${lengthInstruction}
- ${emojiInstruction}
${questionInstruction ? `- ${questionInstruction}` : ''}
${exclamationInstruction ? `- ${exclamationInstruction}` : ''}
${openings.length > 0 ? `- Common openings: "${openings.join('", "')}"` : ''}
${closings.length > 0 ? `- Common closings: "${closings.join('", "')}"` : ''}

ENGAGEMENT RULES:
- Be genuine and personal, never generic or corporate
- When relevant, connect the reply to a specific point from the video
- Ask questions that show genuine interest in the commenter's perspective
- If the comment raises a good point, acknowledge it specifically
- Keep the conversation going — don't give dead-end replies

EXAMPLES OF THE CREATOR'S ACTUAL REPLIES:
${exampleReplies}

CRITICAL: Match the tone, vocabulary, and style of these examples exactly. Do not be more formal or less formal than the examples show.`;

  return systemPrompt;
}
