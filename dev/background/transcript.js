// =============================================================================
// YouTube Transcript Fetcher
// Fetches and caches video transcripts by scraping YouTube's player data
// =============================================================================

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_CACHE_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Get transcript for a video. Returns cached version if available.
 * @param {string} videoId
 * @returns {Promise<{text: string, title: string, partial: boolean}>}
 */
export async function getTranscript(videoId) {
  // Check cache first
  const cached = await getCachedTranscript(videoId);
  if (cached) return cached;

  // Fetch fresh
  const result = await fetchTranscript(videoId);

  // Cache it
  await cacheTranscript(videoId, result);

  return result;
}

/**
 * Fetch transcript from YouTube video page.
 */
async function fetchTranscript(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const html = await res.text();

    // Extract video title
    const titleMatch = html.match(/<title>(.+?)<\/title>/);
    const title = titleMatch
      ? titleMatch[1].replace(' - YouTube', '').trim()
      : 'Unknown';

    // Extract player response JSON
    const playerMatch = html.match(
      /var\s+ytInitialPlayerResponse\s*=\s*({.+?})\s*;/
    );
    if (!playerMatch) {
      // Try alternative pattern
      const altMatch = html.match(
        /ytInitialPlayerResponse"\s*:\s*({.+?})\s*,\s*"/
      );
      if (!altMatch) {
        return { text: '', title, partial: true };
      }
    }

    let playerResponse;
    try {
      playerResponse = JSON.parse(playerMatch?.[1] || '{}');
    } catch {
      return { text: '', title, partial: true };
    }

    // Navigate to caption tracks
    const captionTracks =
      playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!captionTracks || captionTracks.length === 0) {
      // Try extracting description as fallback context
      const description = extractDescription(html);
      return {
        text: description,
        title,
        partial: true,
      };
    }

    // Prefer manual captions, fall back to auto-generated
    const track =
      captionTracks.find((t) => t.kind !== 'asr') || captionTracks[0];

    // Fetch caption XML
    const captionUrl = track.baseUrl;
    const captionRes = await fetch(captionUrl);
    if (!captionRes.ok) throw new Error('Caption fetch failed');

    const captionXml = await captionRes.text();
    const transcript = parseCaptionXml(captionXml);

    return { text: transcript, title, partial: false };
  } catch (e) {
    console.warn('[YT Reply Assistant] Transcript fetch error:', e.message);
    return { text: '', title: 'Unknown', partial: true };
  }
}

/**
 * Parse YouTube caption XML into plain text.
 */
function parseCaptionXml(xml) {
  const textSegments = [];
  // Match <text> elements and extract content
  const regex = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let match;

  while ((match = regex.exec(xml)) !== null) {
    let text = match[1];
    // Decode HTML entities
    text = text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\n/g, ' ');
    textSegments.push(text.trim());
  }

  return textSegments.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract video description from page HTML as fallback context.
 */
function extractDescription(html) {
  const descMatch = html.match(
    /"shortDescription"\s*:\s*"((?:[^"\\]|\\.)*)"/
  );
  if (!descMatch) return '';

  return descMatch[1]
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .slice(0, 2000); // Cap at 2000 chars
}

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

async function getCachedTranscript(videoId) {
  const key = `transcript_${videoId}`;
  const data = await chrome.storage.local.get(key);
  const entry = data[key];

  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    // Expired — remove
    await chrome.storage.local.remove(key);
    return null;
  }

  return entry.data;
}

async function cacheTranscript(videoId, data) {
  const key = `transcript_${videoId}`;
  await chrome.storage.local.set({
    [key]: { data, cachedAt: Date.now() },
  });

  // Check cache size and evict if needed
  await evictIfNeeded();
}

async function evictIfNeeded() {
  const all = await chrome.storage.local.get(null);
  const transcriptEntries = Object.entries(all)
    .filter(([k]) => k.startsWith('transcript_'))
    .map(([k, v]) => ({ key: k, cachedAt: v.cachedAt || 0 }));

  // Rough size estimate (2 bytes per char in JSON)
  const totalSize = JSON.stringify(
    Object.fromEntries(
      Object.entries(all).filter(([k]) => k.startsWith('transcript_'))
    )
  ).length * 2;

  if (totalSize <= MAX_CACHE_BYTES) return;

  // Sort by oldest first, remove until under limit
  transcriptEntries.sort((a, b) => a.cachedAt - b.cachedAt);
  const toRemove = transcriptEntries.slice(
    0,
    Math.ceil(transcriptEntries.length * 0.25)
  );
  await chrome.storage.local.remove(toRemove.map((e) => e.key));
}

/**
 * Get cache stats for the settings page.
 */
export async function getCacheInfo() {
  const all = await chrome.storage.local.get(null);
  const transcriptEntries = Object.entries(all).filter(([k]) =>
    k.startsWith('transcript_')
  );

  const totalSize = JSON.stringify(
    Object.fromEntries(transcriptEntries)
  ).length;

  return {
    videoCount: transcriptEntries.length,
    sizeMB: (totalSize / (1024 * 1024)).toFixed(1),
  };
}

/**
 * Clear all cached transcripts.
 */
export async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('transcript_'));
  if (keys.length > 0) {
    await chrome.storage.local.remove(keys);
  }
  return { removed: keys.length };
}
