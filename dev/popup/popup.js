// =============================================================================
// YT Reply Assistant — Popup Script
// Handles settings UI and onboarding flow
// =============================================================================

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

function sendBg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        console.warn(chrome.runtime.lastError.message);
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(res);
      }
    });
  });
}

function sendTab(msg) {
  return new Promise(async (resolve) => {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab) {
        resolve({ error: 'No active tab' });
        return;
      }
      chrome.tabs.sendMessage(tab.id, msg, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
        } else {
          resolve(res);
        }
      });
    } catch (e) {
      resolve({ error: e.message });
    }
  });
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  const { onboarded } = await sendBg({ type: 'GET_ONBOARDING_STATUS' });

  if (!onboarded) {
    showOnboarding();
  } else {
    showSettings();
  }
});

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

function showOnboarding() {
  $('#onboarding').style.display = 'block';
  $('#settings').style.display = 'none';

  // Start analysis button
  $('#btn-start-analysis').addEventListener('click', startAnalysis);

  // Skip button — show manual input
  $('#btn-skip-analysis').addEventListener('click', () => {
    $('#step-welcome').style.display = 'none';
    $('#step-manual').style.display = 'block';
  });

  // Manual analysis
  $('#btn-manual-analyze').addEventListener('click', async () => {
    const text = $('#manual-replies').value.trim();
    if (!text) return;

    const replies = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 5);

    if (replies.length < 3) {
      alert('Please provide at least 3 replies for a good analysis.');
      return;
    }

    await analyzeReplies(replies);
  });

  // Complete button
  $('#btn-complete').addEventListener('click', async () => {
    await sendBg({ type: 'COMPLETE_ONBOARDING' });
    chrome.action.setBadgeText({ text: '' });
    showSettings();
  });
}

async function startAnalysis() {
  $('#step-welcome').style.display = 'none';
  $('#step-analyzing').style.display = 'block';
  $('#analysis-status').textContent = 'Scanning your replies on this page...';
  $('#progress-fill').style.width = '20%';

  // Try to scrape from active tab
  const replies = await sendTab({ type: 'SCRAPE_REPLIES' });

  if (replies?.error || !replies || replies.length < 3) {
    $('#progress-fill').style.width = '100%';
    $('#analysis-status').textContent =
      'Not enough replies found on this page. Please paste them manually.';

    setTimeout(() => {
      $('#step-analyzing').style.display = 'none';
      $('#step-manual').style.display = 'block';
    }, 1500);
    return;
  }

  $('#analysis-status').textContent = `Found ${replies.length} replies. Analyzing...`;
  $('#progress-fill').style.width = '60%';

  await analyzeReplies(replies);
}

async function analyzeReplies(replies) {
  $('#step-welcome').style.display = 'none';
  $('#step-manual').style.display = 'none';
  $('#step-analyzing').style.display = 'block';
  $('#analysis-status').textContent = 'Building style profile...';
  $('#progress-fill').style.width = '80%';

  const profile = await sendBg({
    type: 'BUILD_STYLE_PROFILE',
    replies,
  });

  $('#progress-fill').style.width = '100%';

  if (profile?.error) {
    $('#analysis-status').textContent = `Error: ${profile.error}`;
    return;
  }

  // Show result
  setTimeout(() => {
    $('#step-analyzing').style.display = 'none';
    $('#step-result').style.display = 'block';
    $('#style-summary').textContent = profile.summary || 'Style profile built!';
  }, 500);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function showSettings() {
  $('#onboarding').style.display = 'none';
  $('#settings').style.display = 'block';

  // Load current settings
  const settings = await sendBg({ type: 'GET_SETTINGS' });

  // Provider select
  const providerSelect = $('#provider-select');
  providerSelect.value = settings.provider || 'chrome-ai';
  updateProviderUI(providerSelect.value);

  providerSelect.addEventListener('change', async () => {
    const provider = providerSelect.value;
    await sendBg({ type: 'SAVE_SETTINGS', settings: { provider } });
    updateProviderUI(provider);
  });

  // API keys
  $('#anthropic-key').value = settings.anthropicKey || '';
  $('#openai-key').value = settings.openaiKey || '';

  // Save keys on blur
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

  // Test buttons
  $('#btn-test-anthropic').addEventListener('click', () =>
    testProvider('anthropic', $('#anthropic-key').value, '#anthropic-status')
  );
  $('#btn-test-openai').addEventListener('click', () =>
    testProvider('openai', $('#openai-key').value, '#openai-status')
  );

  // Check Chrome AI availability
  checkChromeAI();

  // Load style info
  loadStyleInfo();

  // Load cache info
  loadCacheInfo();

  // Re-analyze button
  $('#btn-reanalyze').addEventListener('click', async () => {
    $('#btn-reanalyze').textContent = 'Analyzing...';
    $('#btn-reanalyze').disabled = true;

    const replies = await sendTab({ type: 'SCRAPE_REPLIES' });
    if (replies?.error || !replies || replies.length < 3) {
      $('#btn-reanalyze').textContent = 'Not enough replies on this page';
      setTimeout(() => {
        $('#btn-reanalyze').textContent = 'Re-analyze my style';
        $('#btn-reanalyze').disabled = false;
      }, 2000);
      return;
    }

    await sendBg({ type: 'BUILD_STYLE_PROFILE', replies });
    await loadStyleInfo();

    $('#btn-reanalyze').textContent = 'Done ✓';
    setTimeout(() => {
      $('#btn-reanalyze').textContent = 'Re-analyze my style';
      $('#btn-reanalyze').disabled = false;
    }, 2000);
  });

  // Clear cache button
  $('#btn-clear-cache').addEventListener('click', async () => {
    const result = await sendBg({ type: 'CLEAR_CACHE' });
    $('#cache-info').textContent = `Cleared ${result.removed} videos.`;
    setTimeout(loadCacheInfo, 2000);
  });
}

function updateProviderUI(provider) {
  // Chrome AI status
  $('#chrome-ai-status').style.display =
    provider === 'chrome-ai' ? 'flex' : 'none';

  // Anthropic config
  $('#anthropic-config').style.display =
    provider === 'anthropic' ? 'block' : 'none';

  // OpenAI config
  $('#openai-config').style.display =
    provider === 'openai' ? 'block' : 'none';
}

async function checkChromeAI() {
  const result = await sendBg({
    type: 'TEST_PROVIDER',
    provider: 'chrome-ai',
  });

  const indicator = $('#chrome-ai-indicator');
  const text = $('#chrome-ai-text');

  if (result.ok) {
    indicator.className = 'status-dot green';
    text.textContent = 'Available and ready';
  } else {
    indicator.className = 'status-dot red';
    text.textContent = result.error || 'Not available';
  }
}

async function testProvider(name, key, statusSelector) {
  const statusEl = $(statusSelector);
  statusEl.style.display = 'flex';
  statusEl.innerHTML =
    '<span class="status-dot yellow"></span><span>Testing...</span>';

  const result = await sendBg({
    type: 'TEST_PROVIDER',
    provider: name,
    apiKey: key,
  });

  if (result.ok) {
    statusEl.innerHTML =
      '<span class="status-dot green"></span><span>Connection OK ✓</span>';
  } else {
    statusEl.innerHTML = `<span class="status-dot red"></span><span>${result.error || 'Failed'}</span>`;
  }
}

async function loadStyleInfo() {
  const info = await sendBg({ type: 'GET_STYLE_INFO' });

  if (info.built) {
    $('#style-info-text').textContent = `${info.summary} | Based on ${info.replyCount} replies`;
  } else {
    $('#style-info-text').textContent =
      'No style profile yet. Go to YouTube Studio comments and click "Re-analyze".';
  }
}

async function loadCacheInfo() {
  const info = await sendBg({ type: 'GET_CACHE_INFO' });
  $('#cache-info').textContent = `${info.videoCount} videos cached (${info.sizeMB} MB)`;
}
