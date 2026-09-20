// =============================================================================
// Background Service Worker — YT Reply Assistant
// Handles all cross-origin requests, AI generation, and storage management
// =============================================================================

import { resolveProvider, testProvider } from './providers.js';
import { getTranscript, getCacheInfo, clearCache } from './transcript.js';
import {
  getStyleProfile,
  getStyleInfo,
  buildStyleProfile,
  recordReply,
} from './style.js';
import { buildUserPrompt, parseSuggestions } from './prompts.js';

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => {
      console.error('[YT Reply Assistant] Error:', err);
      sendResponse({ error: err.message });
    });

  return true; // Keep message channel open for async response
});

async function handleMessage(msg) {
  switch (msg.type) {
    // --- Generation ---
    case 'GENERATE_SUGGESTIONS':
      return generateSuggestions(msg);

    // --- Transcript ---
    case 'FETCH_TRANSCRIPT':
      return getTranscript(msg.videoId);

    // --- Style ---
    case 'GET_STYLE_PROFILE':
      return getStyleProfile();
    case 'GET_STYLE_INFO':
      return getStyleInfo();
    case 'BUILD_STYLE_PROFILE':
      return buildStyleProfile(msg.replies);
    case 'RECORD_REPLY':
      return recordReply(msg.replyText);

    // --- Settings ---
    case 'GET_SETTINGS':
      return getSettings();
    case 'SAVE_SETTINGS':
      return saveSettings(msg.settings);
    case 'TEST_PROVIDER':
      return testProvider(msg.provider, msg.apiKey);

    // --- Cache ---
    case 'GET_CACHE_INFO':
      return getCacheInfo();
    case 'CLEAR_CACHE':
      return clearCache();

    // --- Dismissed comments ---
    case 'DISMISS_COMMENT':
      return dismissComment(msg.commentId);
    case 'IS_DISMISSED':
      return isDismissed(msg.commentId);

    // --- Onboarding ---
    case 'GET_ONBOARDING_STATUS':
      return getOnboardingStatus();
    case 'COMPLETE_ONBOARDING':
      return completeOnboarding();

    default:
      return { error: `Unknown message type: ${msg.type}` };
  }
}

// ---------------------------------------------------------------------------
// Suggestion generation
// ---------------------------------------------------------------------------

async function generateSuggestions({
  commentText,
  commentAuthor,
  videoId,
  videoTitle: providedTitle,
}) {
  console.log('[YT Reply Assistant] generateSuggestions:', {
    commentText: commentText?.slice(0, 50),
    commentAuthor,
    videoId,
  });

  // Get transcript (skip if no videoId, don't crash)
  let transcript = { text: '', title: providedTitle || '', partial: true };
  if (videoId) {
    try {
      transcript = await getTranscript(videoId);
    } catch (e) {
      console.warn('[YT Reply Assistant] Transcript fetch failed (non-bloquant):', e.message);
    }
  }

  // Get style profile
  const profile = await getStyleProfile();
  const systemPrompt =
    profile?.systemPrompt ||
    'Tu es un createur YouTube sympa. Reponds de maniere naturelle, engageante et concise. Utilise le tutoiement.';

  // Build user prompt
  const userPrompt = buildUserPrompt({
    commentText,
    commentAuthor: commentAuthor || 'Un viewer',
    videoTitle: providedTitle || transcript.title || 'Video YouTube',
    videoTranscript: transcript.text,
    partialContext: transcript.partial,
  });

  // Resolve AI provider
  const { provider, fallback } = await resolveProvider();
  console.log('[YT Reply Assistant] Provider:', provider?.name || 'AUCUN', 'fallback:', fallback);

  if (!provider) {
    return {
      error: 'Aucun provider IA disponible. Configurez-en un dans les parametres de l\'extension.',
      suggestions: [],
    };
  }

  // Generate
  console.log('[YT Reply Assistant] Appel IA en cours...');
  const rawResponse = await provider.generate(systemPrompt, userPrompt);
  console.log('[YT Reply Assistant] Reponse brute:', rawResponse?.slice(0, 100));
  const suggestions = parseSuggestions(rawResponse);
  console.log('[YT Reply Assistant] Suggestions parsees:', suggestions.length);

  return {
    suggestions,
    provider: provider.name,
    fallback,
    videoTitle: transcript.title,
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return settings || { provider: 'chrome-ai', anthropicKey: '', openaiKey: '' };
}

async function saveSettings(newSettings) {
  const current = await getSettings();
  const merged = { ...current, ...newSettings };
  await chrome.storage.local.set({ settings: merged });
  return merged;
}

// ---------------------------------------------------------------------------
// Dismissed comments
// ---------------------------------------------------------------------------

async function dismissComment(commentId) {
  const { dismissed = [] } = await chrome.storage.local.get('dismissed');
  if (!dismissed.includes(commentId)) {
    dismissed.push(commentId);
    // Keep max 500 dismissed IDs
    if (dismissed.length > 500) dismissed.shift();
    await chrome.storage.local.set({ dismissed });
  }
  return { ok: true };
}

async function isDismissed(commentId) {
  const { dismissed = [] } = await chrome.storage.local.get('dismissed');
  return { dismissed: dismissed.includes(commentId) };
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

async function getOnboardingStatus() {
  const { onboarded } = await chrome.storage.local.get('onboarded');
  return { onboarded: !!onboarded };
}

async function completeOnboarding() {
  await chrome.storage.local.set({ onboarded: true });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Install / badge
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const { onboarded } = await chrome.storage.local.get('onboarded');
  if (!onboarded) {
    chrome.action.setBadgeText({ text: 'NEW' });
    chrome.action.setBadgeBackgroundColor({ color: '#FF0000' });
  }
});
