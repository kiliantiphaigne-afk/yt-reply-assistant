// =============================================================================
// Prompt Builder
// Constructs the user prompt for suggestion generation
// =============================================================================

/**
 * Construit le prompt utilisateur pour generer les suggestions de reponse.
 */
export function buildUserPrompt({
  commentText,
  commentAuthor,
  videoTitle,
  videoTranscript,
  partialContext,
}) {
  const contextSection = videoTranscript
    ? `TRANSCRIPT DE LA VIDEO (pour le contexte) :
---
${truncate(videoTranscript, 3000)}
---`
    : partialContext
      ? `(Pas de transcript disponible — base-toi uniquement sur le titre et le commentaire)`
      : '';

  return `VIDEO : "${videoTitle}"

${contextSection}

COMMENTAIRE de ${commentAuthor} :
"${commentText}"

Genere exactement 3 suggestions de reponse, chacune sur sa propre ligne, prefixee par [1], [2], [3].

[1] = Reponse directe et engageante : reponds au point specifique + pose une question de relance
[2] = Reponse approfondie : fais le lien avec un element de la video + ouvre la discussion
[3] = Reponse courte et chaleureuse : remerciement bref + micro-question (1-2 phrases max)

Regles :
- Chaque reponse doit etre naturelle et personnelle, PAS un template generique
- Ne commence PAS les 3 reponses de la meme maniere
- N'utilise PAS de phrases generiques comme "Super question !" ou "Merci pour le partage !"
- Chaque reponse est autonome (ne reference pas les autres suggestions)
- Reproduis exactement le style du createur (voir le system prompt)

Ecris UNIQUEMENT les 3 reponses, rien d'autre.`;
}

/**
 * Parse la reponse IA en 3 suggestions individuelles.
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
