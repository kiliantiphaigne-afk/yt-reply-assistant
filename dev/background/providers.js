// =============================================================================
// AI Provider Abstraction
// =============================================================================

// ---------------------------------------------------------------------------
// Chrome Built-in AI (Prompt API — Gemini Nano local)
// ---------------------------------------------------------------------------
export const ChromeAIProvider = {
  name: 'chrome-ai',
  label: 'Chrome IA integree',

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
    try {
      const { settings } = await chrome.storage.local.get('settings');
      return !!settings?.anthropicKey;
    } catch {
      return false;
    }
  },

  async generate(systemPrompt, userPrompt, apiKeyOverride) {
    let apiKey = apiKeyOverride;
    if (!apiKey) {
      const { settings } = await chrome.storage.local.get('settings');
      apiKey = settings?.anthropicKey;
    }
    if (!apiKey) throw new Error('Cle API Anthropic non configuree');

    console.log('[YT Reply Assistant] Appel Anthropic API...');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    console.log('[YT Reply Assistant] Anthropic status:', res.status);

    if (!res.ok) {
      const errBody = await res.text();
      console.error('[YT Reply Assistant] Anthropic erreur body:', errBody);
      let errMsg;
      try {
        errMsg = JSON.parse(errBody).error?.message;
      } catch { /* ignore */ }
      throw new Error(errMsg || `Erreur API Anthropic (${res.status})`);
    }

    const data = await res.json();
    console.log('[YT Reply Assistant] Anthropic OK, tokens:', data.usage?.input_tokens, '+', data.usage?.output_tokens);
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
    try {
      const { settings } = await chrome.storage.local.get('settings');
      return !!settings?.openaiKey;
    } catch {
      return false;
    }
  },

  async generate(systemPrompt, userPrompt, apiKeyOverride) {
    let apiKey = apiKeyOverride;
    if (!apiKey) {
      const { settings } = await chrome.storage.local.get('settings');
      apiKey = settings?.openaiKey;
    }
    if (!apiKey) throw new Error('Cle API OpenAI non configuree');

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
      const errBody = await res.text();
      let errMsg;
      try {
        errMsg = JSON.parse(errBody).error?.message;
      } catch { /* ignore */ }
      throw new Error(errMsg || `Erreur API OpenAI (${res.status})`);
    }

    const data = await res.json();
    return data.choices[0].message.content;
  },
};

// ---------------------------------------------------------------------------
// Provider registry + resolution
// ---------------------------------------------------------------------------
const ALL_PROVIDERS = [ChromeAIProvider, AnthropicProvider, OpenAIProvider];

export async function resolveProvider() {
  const { settings } = await chrome.storage.local.get('settings');
  const preferred = settings?.provider || 'chrome-ai';

  const pref = ALL_PROVIDERS.find((p) => p.name === preferred);
  if (pref && (await pref.isAvailable())) {
    return { provider: pref, fallback: false };
  }

  const fallbackOrder = ALL_PROVIDERS.filter((p) => p.name !== preferred);
  for (const p of fallbackOrder) {
    if (await p.isAvailable()) {
      return { provider: p, fallback: true };
    }
  }

  return { provider: null, fallback: false };
}

/**
 * Test un provider avec un prompt simple.
 * Ne modifie PAS le storage — fait l'appel directement avec la cle fournie.
 */
export async function testProvider(providerName, apiKey) {
  console.log('[YT Reply Assistant] Test provider:', providerName);

  try {
    if (providerName === 'chrome-ai') {
      const available = await ChromeAIProvider.isAvailable();
      if (!available) {
        return { ok: false, error: 'Chrome IA non disponible. Active le flag Prompt API.' };
      }
      await ChromeAIProvider.generate('Tu es utile.', 'Dis "OK" et rien d\'autre.');
      return { ok: true };
    }

    if (providerName === 'anthropic') {
      if (!apiKey) {
        const { settings } = await chrome.storage.local.get('settings');
        apiKey = settings?.anthropicKey;
      }
      if (!apiKey) return { ok: false, error: 'Aucune cle API fournie' };

      // Appel direct avec la cle — pas de modification du storage
      await AnthropicProvider.generate('Tu es utile.', 'Dis "OK" et rien d\'autre.', apiKey);

      // Sauvegarder la cle seulement si le test reussit
      const { settings = {} } = await chrome.storage.local.get('settings');
      settings.anthropicKey = apiKey;
      await chrome.storage.local.set({ settings });

      return { ok: true };
    }

    if (providerName === 'openai') {
      if (!apiKey) {
        const { settings } = await chrome.storage.local.get('settings');
        apiKey = settings?.openaiKey;
      }
      if (!apiKey) return { ok: false, error: 'Aucune cle API fournie' };

      await OpenAIProvider.generate('Tu es utile.', 'Dis "OK" et rien d\'autre.', apiKey);

      const { settings = {} } = await chrome.storage.local.get('settings');
      settings.openaiKey = apiKey;
      await chrome.storage.local.set({ settings });

      return { ok: true };
    }

    return { ok: false, error: 'Provider inconnu' };
  } catch (e) {
    console.error('[YT Reply Assistant] Test echoue:', e);
    return { ok: false, error: e.message || String(e) };
  }
}
