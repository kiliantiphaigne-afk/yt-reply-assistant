// =============================================================================
// YT Reply Assistant — Popup (parametres + onboarding)
// =============================================================================

const $ = (sel) => document.querySelector(sel);

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

  // Bouton principal : analyser depuis le texte colle
  $('#btn-analyze').addEventListener('click', async () => {
    const text = $('#manual-replies').value.trim();
    if (!text) {
      alert('Colle au moins quelques reponses pour que je puisse analyser ton style.');
      return;
    }

    const replies = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 5);

    if (replies.length < 3) {
      alert('Il me faut au moins 3 reponses (une par ligne) pour une bonne analyse.');
      return;
    }

    await analyzeReplies(replies);
  });

  // Bouton skip : passer avec un profil par defaut
  $('#btn-skip').addEventListener('click', async () => {
    // Creer un profil minimal par defaut
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

  // Bouton terminé
  $('#btn-complete').addEventListener('click', async () => {
    await sendBg({ type: 'COMPLETE_ONBOARDING' });
    chrome.action.setBadgeText({ text: '' });
    showSettings();
  });
}

async function analyzeReplies(replies) {
  $('#step-welcome').style.display = 'none';
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
  }, 400);
}

// ---------------------------------------------------------------------------
// Parametres
// ---------------------------------------------------------------------------

async function showSettings() {
  $('#onboarding').style.display = 'none';
  $('#settings').style.display = 'block';

  const settings = await sendBg({ type: 'GET_SETTINGS' });

  // Provider
  const select = $('#provider-select');
  select.value = settings.provider || 'chrome-ai';
  updateProviderUI(select.value);

  select.addEventListener('change', async () => {
    await sendBg({ type: 'SAVE_SETTINGS', settings: { provider: select.value } });
    updateProviderUI(select.value);
  });

  // Cles API
  $('#anthropic-key').value = settings.anthropicKey || '';
  $('#openai-key').value = settings.openaiKey || '';

  $('#anthropic-key').addEventListener('blur', async () => {
    await sendBg({
      type: 'SAVE_SETTINGS',
      settings: { anthropicKey: $('#anthropic-key').value },
    });
  });

  $('#openai-key').addEventListener('blur', async () => {
    await sendBg({
      type: 'SAVE_SETTINGS',
      settings: { openaiKey: $('#openai-key').value },
    });
  });

  // Test providers
  $('#btn-test-anthropic').addEventListener('click', () =>
    testProvider('anthropic', $('#anthropic-key').value, '#anthropic-status')
  );
  $('#btn-test-openai').addEventListener('click', () =>
    testProvider('openai', $('#openai-key').value, '#openai-status')
  );

  checkChromeAI();
  loadStyleInfo();
  loadCacheInfo();

  // Re-analyser
  $('#btn-reanalyze').addEventListener('click', async () => {
    const info = await sendBg({ type: 'GET_STYLE_INFO' });
    if (info.replyCount > 0) {
      $('#btn-reanalyze').textContent = 'Re-analyse...';
      $('#btn-reanalyze').disabled = true;
      // Rebuild from stored replies
      const { styleReplies = [] } = await chrome.storage.local.get('styleReplies');
      if (styleReplies.length >= 3) {
        await sendBg({ type: 'BUILD_STYLE_PROFILE', replies: styleReplies });
      }
      await loadStyleInfo();
      $('#btn-reanalyze').textContent = 'Fait ✓';
      setTimeout(() => {
        $('#btn-reanalyze').textContent = 'Re-analyser';
        $('#btn-reanalyze').disabled = false;
      }, 1500);
    } else {
      alert('Aucune reponse en memoire. Utilise "Modifier les exemples" pour en ajouter.');
    }
  });

  // Modifier les exemples
  $('#btn-edit-style').addEventListener('click', () => {
    const panel = $('#edit-style-panel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });

  $('#btn-save-style').addEventListener('click', async () => {
    const text = $('#edit-replies').value.trim();
    if (!text) return;
    const replies = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 5);
    if (replies.length < 3) {
      alert('Il faut au moins 3 reponses.');
      return;
    }
    await sendBg({ type: 'BUILD_STYLE_PROFILE', replies });
    await loadStyleInfo();
    $('#edit-style-panel').style.display = 'none';
    $('#edit-replies').value = '';
  });

  // Vider le cache
  $('#btn-clear-cache').addEventListener('click', async () => {
    const result = await sendBg({ type: 'CLEAR_CACHE' });
    $('#cache-info').textContent = result.removed + ' videos supprimees du cache.';
    setTimeout(loadCacheInfo, 2000);
  });
}

function updateProviderUI(provider) {
  $('#chrome-ai-status').style.display = provider === 'chrome-ai' ? 'flex' : 'none';
  $('#anthropic-config').style.display = provider === 'anthropic' ? 'block' : 'none';
  $('#openai-config').style.display = provider === 'openai' ? 'block' : 'none';
}

async function checkChromeAI() {
  const result = await sendBg({ type: 'TEST_PROVIDER', provider: 'chrome-ai' });
  const indicator = $('#chrome-ai-indicator');
  const text = $('#chrome-ai-text');
  if (result.ok) {
    indicator.className = 'status-dot green';
    text.textContent = 'Disponible et pret';
  } else {
    indicator.className = 'status-dot red';
    text.innerHTML = 'Non disponible. <a href="chrome://flags/#prompt-api-for-gemini-nano" target="_blank">Activer le flag</a> ou configure une cle API ci-dessous.';
  }
}

async function testProvider(name, key, statusSel) {
  const el = $(statusSel);
  el.style.display = 'flex';
  el.innerHTML = '<span class="status-dot yellow"></span><span>Test en cours...</span>';

  const result = await sendBg({ type: 'TEST_PROVIDER', provider: name, apiKey: key });
  if (result.ok) {
    el.innerHTML = '<span class="status-dot green"></span><span>Connexion OK ✓</span>';
  } else {
    el.innerHTML = '<span class="status-dot red"></span><span>' + (result.error || 'Echec') + '</span>';
  }
}

async function loadStyleInfo() {
  const info = await sendBg({ type: 'GET_STYLE_INFO' });
  if (info.built) {
    $('#style-info-text').textContent = info.summary + ' | Base sur ' + info.replyCount + ' reponses';
  } else {
    $('#style-info-text').textContent = 'Aucun profil de style. Utilise "Modifier les exemples" pour en creer un.';
  }
}

async function loadCacheInfo() {
  const info = await sendBg({ type: 'GET_CACHE_INFO' });
  $('#cache-info').textContent = info.videoCount + ' videos en cache (' + info.sizeMB + ' Mo)';
}
