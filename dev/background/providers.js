// =============================================================================
// AI Provider Abstraction
// Each provider implements: { name, isAvailable(), generate(systemPrompt, userPrompt) }
// =============================================================================

// ---------------------------------------------------------------------------
// Chrome Built-in AI (Prompt API — Gemini Nano local)
// ---------------------------------------------------------------------------
export const ChromeAIProvider = {
  name: 'chrome-ai',
  label: 'Chrome Built-in AI',

  async isAvailable() {
    try {
      if (!self.ai?.languageModel) return false;
      const caps = await self.ai.languageModel.capabilities();
      return caps.available === 'readily';
    } catch {
      return false;
    }
  },

  async generate(systemPrompt, userPrompt) {
    const session = await self.ai.languageModel.create({ systemPrompt });
    const result = await session.prompt(userPrompt);
    session.destroy();
    return result;
  },
};

// ---------------------------------------------------------------------------
// Anthropic API (Claude Haiku)
// ---------------------------------------------------------------------------
export const AnthropicProvider = {
  name: 'anthropic',
  label: 'Anthropic (Claude Haiku)',

  async isAvailable() {
    const { settings } = await chrome.storage.local.get('settings');
    return !!settings?.anthropicKey;
  },

  async generate(systemPrompt, userPrompt) {
    const { settings } = await chrome.storage.local.get('settings');
    const apiKey = settings?.anthropicKey;
    if (!apiKey) throw new Error('Anthropic API key not configured');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `Anthropic API error ${res.status}`);
    }

    const data = await res.json();
    return data.content[0].text;
  },
};

// ---------------------------------------------------------------------------
// OpenAI API (GPT-4o-mini)
// ---------------------------------------------------------------------------
export const OpenAIProvider = {
  name: 'openai',
  label: 'OpenAI (GPT-4o mini)',

  async isAvailable() {
    const { settings } = await chrome.storage.local.get('settings');
    return !!settings?.openaiKey;
  },

  async generate(systemPrompt, userPrompt) {
    const { settings } = await chrome.storage.local.get('settings');
    const apiKey = settings?.openaiKey;
    if (!apiKey) throw new Error('OpenAI API key not configured');

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `OpenAI API error ${res.status}`);
    }

    const data = await res.json();
    return data.choices[0].message.content;
  },
};

// ---------------------------------------------------------------------------
// Provider registry + resolution
// ---------------------------------------------------------------------------
const ALL_PROVIDERS = [ChromeAIProvider, AnthropicProvider, OpenAIProvider];

/**
 * Get the active provider (user preference → fallback chain).
 * Returns { provider, fallback: boolean }
 */
export async function resolveProvider() {
  const { settings } = await chrome.storage.local.get('settings');
  const preferred = settings?.provider || 'chrome-ai';

  // Try preferred first
  const pref = ALL_PROVIDERS.find((p) => p.name === preferred);
  if (pref && (await pref.isAvailable())) {
    return { provider: pref, fallback: false };
  }

  // Fallback chain: API providers first (better quality), then Chrome AI
  const fallbackOrder = ALL_PROVIDERS.filter((p) => p.name !== preferred);
  for (const p of fallbackOrder) {
    if (await p.isAvailable()) {
      return { provider: p, fallback: true };
    }
  }

  return { provider: null, fallback: false };
}

/**
 * Test a provider with a simple prompt. Returns { ok, error? }
 */
export async function testProvider(providerName, apiKey) {
  try {
    if (providerName === 'chrome-ai') {
      const available = await ChromeAIProvider.isAvailable();
      if (!available) return { ok: false, error: 'Chrome AI not available. Enable the Prompt API flag.' };
      await ChromeAIProvider.generate('You are helpful.', 'Say "OK" and nothing else.');
      return { ok: true };
    }

    if (providerName === 'anthropic') {
      // Temporarily store key for the test
      const { settings = {} } = await chrome.storage.local.get('settings');
      const oldKey = settings.anthropicKey;
      settings.anthropicKey = apiKey;
      await chrome.storage.local.set({ settings });

      try {
        await AnthropicProvider.generate('You are helpful.', 'Say "OK" and nothing else.');
        return { ok: true };
      } catch (e) {
        settings.anthropicKey = oldKey;
        await chrome.storage.local.set({ settings });
        return { ok: false, error: e.message };
      }
    }

    if (providerName === 'openai') {
      const { settings = {} } = await chrome.storage.local.get('settings');
      const oldKey = settings.openaiKey;
      settings.openaiKey = apiKey;
      await chrome.storage.local.set({ settings });

      try {
        await OpenAIProvider.generate('You are helpful.', 'Say "OK" and nothing else.');
        return { ok: true };
      } catch (e) {
        settings.openaiKey = oldKey;
        await chrome.storage.local.set({ settings });
        return { ok: false, error: e.message };
      }
    }

    return { ok: false, error: 'Unknown provider' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
