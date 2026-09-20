// =============================================================================
// YT Reply Assistant — Popup (parametres + onboarding) — Redesign v2
// =============================================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function sendBg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(res);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  const { onboarded } = await sendBg({ type: 'GET_ONBOARDING_STATUS' });
  if (onboarded) {
    showSettings();
  } else {
    showOnboarding();
  }
});

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

function showOnboarding() {
  $('#onboarding').style.display = 'block';
  $('#settings').style.display = 'none';

  const textarea = $('#manual-replies');
  const charCount = $('#char-count');

  textarea.addEventListener('input', () => {
    const len = textarea.value.length;
    charCount.textContent = `${len} / 2000`;
    if (len > 2000) {
      textarea.value = textarea.value.slice(0, 2000);
      charCount.textContent = '2000 / 2000';
    }
  });

  $('#btn-analyze').addEventListener('click', async () => {
    const text = textarea.value.trim();
    if (!text) {
      alert('Collez au moins quelques reponses pour analyser votre style.');
      return;
    }

    const replies = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 5);

    if (replies.length < 3) {
      alert('Il faut au moins 3 reponses (une par ligne) pour une bonne analyse.');
      return;
    }

    await analyzeReplies(replies);
  });

  $('#btn-skip').addEventListener('click', async () => {
    await sendBg({
      type: 'BUILD_STYLE_PROFILE',
      replies: [
        "Merci pour ton retour ! Ca fait plaisir de savoir que la video t'aide.",
        "Bonne question ! En fait ca depend de ton contexte.",
        "Ahah je comprends ! L'important c'est de commencer petit 💪",
        "Super interessant comme point de vue ! Tu penses que ca marcherait aussi dans un autre contexte ?",
        "Content que ca t'ait parle ! Des sujets que tu aimerais que j'aborde ?",
      ],
    });
    await sendBg({ type: 'COMPLETE_ONBOARDING' });
    chrome.action.setBadgeText({ text: '' });
    showSettings();
  });

  $('#btn-complete').addEventListener('click', async () => {
    await sendBg({ type: 'COMPLETE_ONBOARDING' });
    chrome.action.setBadgeText({ text: '' });
    showSettings();
  });
}

async function analyzeReplies(replies) {
  $('#btn-analyze').style.display = 'none';
  $('#btn-skip').style.display = 'none';
  $('#step-analyzing').style.display = 'block';
  $('#analysis-status').textContent = 'Construction du profil de style...';
  $('#progress-fill').style.width = '60%';

  const profile = await sendBg({
    type: 'BUILD_STYLE_PROFILE',
    replies,
  });

  $('#progress-fill').style.width = '100%';

  if (profile?.error) {
    $('#analysis-status').textContent = 'Erreur : ' + profile.error;
    return;
  }

  setTimeout(() => {
    $('#step-analyzing').style.display = 'none';
    $('#step-result').style.display = 'block';
    $('#style-summary').textContent = profile.summary || 'Profil de style construit !';
    $('#btn-complete').style.display = 'block';
  }, 400);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

let currentProvider = 'chrome-ai';

async function showSettings() {
  $('#onboarding').style.display = 'none';
  $('#settings').style.display = 'block';

  const settings = await sendBg({ type: 'GET_SETTINGS' });
  currentProvider = settings.provider || 'chrome-ai';

  // Setup provider cards
  setupProviderCards(settings);

  // Load data
  checkChromeAI();
  checkApiProviders(settings);
  loadStyleInfo();
  loadCacheInfo();

  // Edit style
  $('#btn-edit-style').addEventListener('click', () => {
    const panel = $('#edit-style-panel');
    const btn = $('#btn-edit-style');
    if (panel.style.display === 'none') {
      panel.style.display = 'block';
      btn.textContent = 'Annuler';
    } else {
      panel.style.display = 'none';
      btn.textContent = 'Modifier';
    }
  });

  $('#btn-save-style').addEventListener('click', async () => {
    const text = $('#edit-replies').value.trim();
    if (!text) return;
    const replies = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 5);
    if (replies.length < 3) {
      alert('Il faut au moins 3 reponses.');
      return;
    }
    $('#btn-save-style').textContent = 'Analyse...';
    $('#btn-save-style').disabled = true;
    await sendBg({ type: 'BUILD_STYLE_PROFILE', replies });
    await loadStyleInfo();
    $('#edit-style-panel').style.display = 'none';
    $('#btn-edit-style').textContent = 'Modifier';
    $('#btn-save-style').textContent = 'Sauvegarder';
    $('#btn-save-style').disabled = false;
    $('#edit-replies').value = '';
  });

  // Clear cache
  $('#btn-clear-cache').addEventListener('click', async () => {
    const result = await sendBg({ type: 'CLEAR_CACHE' });
    $('#cache-info').textContent = result.removed + ' videos supprimees du cache.';
    setTimeout(loadCacheInfo, 2000);
  });
}

// ---------------------------------------------------------------------------
// Provider cards
// ---------------------------------------------------------------------------

function setupProviderCards(settings) {
  const cards = $$('.provider-card');

  // Select the current provider
  selectProviderCard(currentProvider);

  // Click handlers
  cards.forEach((card) => {
    card.addEventListener('click', async () => {
      const provider = card.dataset.provider;
      currentProvider = provider;
      selectProviderCard(provider);
      await sendBg({ type: 'SAVE_SETTINGS', settings: { provider } });
    });
  });

  // Pre-fill keys
  if (settings.anthropicKey) {
    $('#api-key-input').value = settings.anthropicKey;
  }

  // Test button
  $('#btn-test-key').addEventListener('click', async () => {
    const key = $('#api-key-input').value.trim();
    if (!key) return;

    const statusEl = $('#api-key-status');
    statusEl.style.display = 'flex';
    statusEl.className = 'conn-status testing';
    statusEl.textContent = 'Test en cours...';

    const result = await sendBg({
      type: 'TEST_PROVIDER',
      provider: currentProvider,
      apiKey: key,
    });

    if (result.ok) {
      statusEl.className = 'conn-status ok';
      statusEl.innerHTML = '✓ Connexion OK';

      // Save key
      const keyField = currentProvider === 'anthropic' ? 'anthropicKey' : 'openaiKey';
      await sendBg({ type: 'SAVE_SETTINGS', settings: { [keyField]: key } });

      // Update badge
      const badgeId = currentProvider === 'anthropic' ? '#anthropic-badge' : '#openai-badge';
      setBadge(badgeId, 'connected', 'Connecte');
    } else {
      statusEl.className = 'conn-status error';
      statusEl.textContent = '✕ ' + (result.error || 'Echec de connexion');
    }
  });
}

function selectProviderCard(providerName) {
  // Reset all cards
  $$('.provider-card').forEach((card) => {
    card.classList.remove('selected');
    const dot = card.querySelector('.radio-dot');
    if (dot) {
      dot.classList.remove('selected');
    }
  });

  // Select the target
  const target = $(`.provider-card[data-provider="${providerName}"]`);
  if (target) {
    target.classList.add('selected');
    const dot = target.querySelector('.radio-dot');
    if (dot) {
      dot.classList.add('selected');
    }
  }

  // Show/hide API key zone
  const apiZone = $('#api-key-zone');
  const isApiProvider = providerName === 'anthropic' || providerName === 'openai';
  apiZone.style.display = isApiProvider ? 'block' : 'none';

  if (isApiProvider) {
    const label = providerName === 'anthropic' ? 'Cle API Anthropic' : 'Cle API OpenAI';
    const placeholder = providerName === 'anthropic' ? 'sk-ant-api03-...' : 'sk-...';
    const helpLink = providerName === 'anthropic'
      ? '<a href="https://console.anthropic.com/settings/keys" target="_blank">Obtenir une cle</a> · ~0.25€/1 000 reponses'
      : '<a href="https://platform.openai.com/api-keys" target="_blank">Obtenir une cle</a> · ~0.20€/1 000 reponses';

    $('#api-key-label').textContent = label;
    $('#api-key-input').placeholder = placeholder;
    $('#api-key-help').innerHTML = helpLink;

    // Load saved key
    loadSavedKey(providerName);
  }

  // Reset status
  $('#api-key-status').style.display = 'none';
}

async function loadSavedKey(providerName) {
  const settings = await sendBg({ type: 'GET_SETTINGS' });
  const key = providerName === 'anthropic' ? settings.anthropicKey : settings.openaiKey;
  $('#api-key-input').value = key || '';
}

// ---------------------------------------------------------------------------
// Provider checks
// ---------------------------------------------------------------------------

async function checkChromeAI() {
  const statusEl = $('#chrome-ai-status');
  const result = await sendBg({ type: 'TEST_PROVIDER', provider: 'chrome-ai' });
  if (result.ok) {
    setBadge('#chrome-ai-status', 'available', 'Disponible');
  } else {
    setBadge('#chrome-ai-status', 'error', 'Non disponible');
  }
}

async function checkApiProviders(settings) {
  // Anthropic
  if (settings.anthropicKey) {
    setBadge('#anthropic-badge', 'connected', 'Connecte');
  }
  // OpenAI
  if (settings.openaiKey) {
    setBadge('#openai-badge', 'connected', 'Connecte');
  }
}

function setBadge(selector, status, text) {
  const el = $(selector);
  if (!el) return;
  el.className = `provider-status ${status}`;
  el.innerHTML = `<div class="status-dot"></div><span>${text}</span>`;
}

// ---------------------------------------------------------------------------
// Style info
// ---------------------------------------------------------------------------

async function loadStyleInfo() {
  const info = await sendBg({ type: 'GET_STYLE_INFO' });
  const tagsContainer = $('#style-tags');
  const countEl = $('#style-count');

  if (!info.built) {
    tagsContainer.innerHTML = '<span class="tag neutral">Aucun profil</span>';
    countEl.textContent = 'Utilisez "Modifier" pour creer un profil de style.';
    return;
  }

  // Parse summary into tags
  const summary = info.summary || '';
  const tags = [];

  // Language
  if (summary.includes('francais')) {
    tags.push({ text: 'Francais', cls: 'blue', icon: '🇫🇷' });
  } else if (summary.includes('anglais')) {
    tags.push({ text: 'English', cls: 'blue', icon: '🇬🇧' });
  }

  // Style
  if (summary.includes('tutoiement')) {
    tags.push({ text: 'Tutoiement', cls: 'neutral' });
  } else if (summary.includes('vouvoiement')) {
    tags.push({ text: 'Vouvoiement', cls: 'neutral' });
  }

  // Length
  const wordsMatch = summary.match(/~(\d+) mots/);
  if (wordsMatch) {
    const words = parseInt(wordsMatch[1]);
    if (words < 15) tags.push({ text: 'Phrases courtes', cls: 'neutral' });
    else if (words < 30) tags.push({ text: 'Longueur moyenne', cls: 'neutral' });
    else tags.push({ text: 'Reponses detaillees', cls: 'neutral' });
  }

  // Emojis
  if (summary.includes('Emojis frequents')) {
    const emojiMatch = summary.match(/\(([^)]+)\)/);
    tags.push({ text: (emojiMatch ? emojiMatch[1] + ' ' : '') + 'Emojis', cls: 'warm' });
  } else if (summary.includes('occasionnels')) {
    tags.push({ text: 'Emojis moderes', cls: 'warm' });
  } else if (summary.includes("Peu d'emojis")) {
    tags.push({ text: "Peu d'emojis", cls: 'neutral' });
  }

  // Tone
  if (summary.includes('questions')) {
    tags.push({ text: 'Pose des questions', cls: 'neutral' });
  }
  if (summary.includes('enthousiaste')) {
    tags.push({ text: 'Ton enthousiaste', cls: 'neutral' });
  }

  // Render tags
  tagsContainer.innerHTML = tags
    .map((t) => `<span class="tag ${t.cls}">${t.icon ? t.icon + ' ' : ''}${t.text}</span>`)
    .join('');

  countEl.textContent = `Base sur ${info.replyCount} reponses analysees`;
}

// ---------------------------------------------------------------------------
// Cache info
// ---------------------------------------------------------------------------

async function loadCacheInfo() {
  const info = await sendBg({ type: 'GET_CACHE_INFO' });
  const el = $('#cache-info');
  el.innerHTML = `${info.videoCount} videos en cache <span class="cache-size">· ${info.sizeMB} Mo</span>`;
}
