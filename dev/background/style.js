// =============================================================================
// Style Profile Manager
// Construit et maintient le profil de style du createur
// =============================================================================

const MAX_REPLIES_STORED = 50;
const REGEN_EVERY_N = 20;

export async function getStyleProfile() {
  const { styleProfile } = await chrome.storage.local.get('styleProfile');
  return styleProfile || null;
}

export async function getStyleInfo() {
  const { styleProfile, styleReplies = [] } = await chrome.storage.local.get([
    'styleProfile',
    'styleReplies',
  ]);
  return {
    built: !!styleProfile,
    replyCount: styleReplies.length,
    summary: styleProfile?.summary || null,
    systemPrompt: styleProfile?.systemPrompt || null,
  };
}

export async function buildStyleProfile(replies) {
  if (!replies || replies.length === 0) {
    return { error: 'Aucune reponse a analyser' };
  }

  await chrome.storage.local.set({
    styleReplies: replies.slice(0, MAX_REPLIES_STORED),
  });

  const analysis = analyzeReplies(replies);
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

export async function recordReply(replyText) {
  if (!replyText || replyText.trim().length < 5) return;

  const { styleReplies = [], styleReplyCounter = 0 } =
    await chrome.storage.local.get(['styleReplies', 'styleReplyCounter']);

  styleReplies.push(replyText.trim());
  if (styleReplies.length > MAX_REPLIES_STORED) styleReplies.shift();

  const newCounter = styleReplyCounter + 1;
  await chrome.storage.local.set({ styleReplies, styleReplyCounter: newCounter });

  if (newCounter >= REGEN_EVERY_N) {
    await buildStyleProfile(styleReplies);
    await chrome.storage.local.set({ styleReplyCounter: 0 });
  }
}

// ---------------------------------------------------------------------------
// Analyse
// ---------------------------------------------------------------------------

function analyzeReplies(replies) {
  const wordCounts = replies.map((r) => r.split(/\s+/).length);
  const avgWords = Math.round(
    wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length
  );

  const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
  const emojiCounts = replies.map((r) => (r.match(emojiRegex) || []).length);
  const totalEmojis = emojiCounts.reduce((a, b) => a + b, 0);
  const emojiFreq = totalEmojis / replies.length;
  const commonEmojis = findCommonEmojis(replies);

  // Detection de langue
  const fr = /\b(je|tu|il|elle|nous|vous|ils|elles|c'est|oui|merci|très|bien|aussi|avec|pour|dans|mais|que|qui|est|les|des|une|pas)\b/gi;
  const en = /\b(the|is|are|was|were|have|has|been|this|that|with|for|and|but|not|you|your|they|from|what|which)\b/gi;
  let frScore = 0,
    enScore = 0;
  for (const r of replies) {
    frScore += (r.match(fr) || []).length;
    enScore += (r.match(en) || []).length;
  }
  const language = frScore > enScore ? 'francais' : 'anglais';

  // Formalite
  const tuCount = replies.filter((r) => /\b(tu|toi|ton|ta|tes)\b/i.test(r)).length;
  const vousCount = replies.filter((r) =>
    /\b(vous|votre|vos)\b/i.test(r)
  ).length;
  const formality =
    language === 'francais'
      ? tuCount > vousCount
        ? 'tutoiement'
        : 'vouvoiement'
      : 'casual';

  const questionRate = replies.filter((r) => r.includes('?')).length / replies.length;
  const exclamationRate = replies.filter((r) => r.includes('!')).length / replies.length;

  const openings = findPatterns(replies, 'opening');
  const closings = findPatterns(replies, 'closing');

  // Resume en francais
  const parts = [
    `Langue : ${language}`,
    `Style : ${formality}`,
    `~${avgWords} mots/reponse`,
    emojiFreq > 0.3
      ? `Emojis frequents (${commonEmojis.slice(0, 4).join(' ')})`
      : emojiFreq > 0
        ? 'Emojis occasionnels'
        : 'Peu d\'emojis',
    questionRate > 0.3 ? 'Pose souvent des questions' : '',
    exclamationRate > 0.5 ? 'Ton enthousiaste' : '',
  ].filter(Boolean);

  return {
    language,
    formality,
    avgWords,
    emojiFreq,
    commonEmojis,
    questionRate,
    exclamationRate,
    openings,
    closings,
    summary: parts.join(' | '),
  };
}

function findCommonEmojis(replies) {
  const regex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
  const counts = {};
  for (const r of replies) {
    for (const e of r.match(regex) || []) {
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
    const seg =
      position === 'opening'
        ? words.slice(0, 3).join(' ').toLowerCase()
        : words.slice(-3).join(' ').toLowerCase();
    patterns[seg] = (patterns[seg] || 0) + 1;
  }
  return Object.entries(patterns)
    .filter(([, c]) => c >= 2)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([p]) => p);
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(analysis, replies) {
  const {
    language,
    formality,
    avgWords,
    emojiFreq,
    commonEmojis,
    questionRate,
    exclamationRate,
    openings,
    closings,
  } = analysis;

  const langInstruction =
    language === 'francais'
      ? 'Reponds TOUJOURS en francais.'
      : 'Always reply in English.';

  const formalityInstruction =
    formality === 'tutoiement'
      ? 'Utilise le tutoiement (tu/toi). Ton informel et proche.'
      : formality === 'vouvoiement'
        ? 'Utilise le vouvoiement (vous). Ton respectueux mais chaleureux.'
        : 'Use a casual, friendly tone.';

  const lengthInstruction = `Longueur cible : ~${avgWords} mots par reponse. Pas de pavés.`;

  let emojiInstruction = '';
  if (emojiFreq > 0.5 && commonEmojis.length > 0) {
    emojiInstruction = `Utilise des emojis regulierement, surtout : ${commonEmojis.slice(0, 5).join(' ')}`;
  } else if (emojiFreq > 0.1) {
    emojiInstruction = 'Utilise des emojis occasionnellement.';
  } else {
    emojiInstruction = "N'utilise pas ou tres peu d'emojis.";
  }

  const exampleReplies = replies
    .slice(0, 5)
    .map((r, i) => `Exemple ${i + 1}: "${r}"`)
    .join('\n');

  return `Tu es un createur YouTube qui repond aux commentaires sur ses videos.
Ton objectif : ecrire des reponses engageantes et authentiques qui correspondent au style personnel du createur.

REGLES DE STYLE :
- ${langInstruction}
- ${formalityInstruction}
- ${lengthInstruction}
- ${emojiInstruction}
${questionRate > 0.3 ? '- Pose souvent une question de relance pour engager la conversation.' : ''}
${exclamationRate > 0.5 ? "- Ton enthousiaste — utilise des points d'exclamation." : ''}
${openings.length > 0 ? `- Ouvertures frequentes : "${openings.join('", "')}"` : ''}
${closings.length > 0 ? `- Fermetures frequentes : "${closings.join('", "')}"` : ''}

REGLES D'ENGAGEMENT :
- Sois authentique et personnel, jamais generique ou corporate
- Quand c'est pertinent, fais le lien avec un point precis de la video
- Pose des questions qui montrent un interet sincere pour le point de vue du commentateur
- Si le commentaire souleve un bon point, reconnais-le specifiquement
- Fais en sorte que la conversation continue — pas de reponses fermees

EXEMPLES DE REPONSES DU CREATEUR :
${exampleReplies}

CRITIQUE : Reproduis exactement le ton, le vocabulaire et le style de ces exemples.`;
}
