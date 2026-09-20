// =============================================================================
// YT Reply Assistant — Content Script (Redesign v2)
// Injecte dans studio.youtube.com
// Detecte les commentaires non repondus, affiche des suggestions en cards
// =============================================================================

(function () {
  'use strict';

  const NAMESPACE = 'yt-reply-assistant';
  const PROCESSED_ATTR = `data-${NAMESPACE}-processed`;
  const SUGGESTIONS_CLASS = `${NAMESPACE}-suggestions`;
  const DEBOUNCE_MS = 600;

  const SUGGESTION_TYPES = [
    'Reponse directe + question de relance',
    'Reponse approfondie + lien video',
    'Reponse courte + micro-question',
  ];

  // -------------------------------------------------------------------------
  // Deep DOM traversal (handles Shadow DOM)
  // -------------------------------------------------------------------------

  function deepQueryAll(root, selector) {
    const results = [];
    try {
      root.querySelectorAll(selector).forEach((el) => results.push(el));
    } catch { /* invalid selector */ }
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) {
        results.push(...deepQueryAll(el.shadowRoot, selector));
      }
    });
    return results;
  }

  function deepQuery(root, selector) {
    const results = deepQueryAll(root, selector);
    return results[0] || null;
  }

  function findElement(parent, selectors) {
    if (typeof selectors === 'string') selectors = [selectors];
    for (const sel of selectors) {
      const el = deepQuery(parent, sel);
      if (el) return el;
    }
    return null;
  }

  function findElements(parent, selectors) {
    if (typeof selectors === 'string') selectors = [selectors];
    const seen = new Set();
    const results = [];
    for (const sel of selectors) {
      for (const el of deepQueryAll(parent, sel)) {
        if (!seen.has(el)) {
          seen.add(el);
          results.push(el);
        }
      }
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // YouTube Studio comment detection
  // -------------------------------------------------------------------------

  function findCommentContainers() {
    let containers = findElements(document, [
      'ytcp-comment-thread',
      'ytcp-comment',
      '.comment-thread-renderer',
    ]);

    if (containers.length === 0) {
      containers = findElements(document, [
        '[class*="comment-thread"]',
        '[class*="comment-item"]',
        '[id*="comment"]',
      ]);
      containers = containers.filter((el) => {
        const text = el.textContent || '';
        return text.length > 20 && text.length < 10000;
      });
    }

    if (containers.length === 0) {
      const replyBtns = findElements(document, [
        'button[aria-label*="reply" i]',
        'button[aria-label*="reponse" i]',
        'button[aria-label*="réponse" i]',
        'button[aria-label*="répondre" i]',
        '[class*="reply-button"]',
      ]);
      containers = replyBtns
        .map((btn) => {
          let parent = btn.parentElement;
          for (let i = 0; i < 8; i++) {
            if (!parent || parent === document.body) break;
            if (parent.offsetHeight > 50 && parent.offsetHeight < 600) {
              return parent;
            }
            parent = parent.parentElement;
          }
          return null;
        })
        .filter(Boolean);
    }

    return containers;
  }

  function getCommentText(container) {
    const selectors = [
      '#content-text',
      '#plain-text',
      'yt-formatted-string#content-text',
      '.comment-text',
      '[class*="comment-text"]',
      '[class*="comment-content"]',
    ];
    const el = findElement(container, selectors);
    if (el) return el.textContent.trim();

    const textNodes = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (text.length > 20) {
        textNodes.push({ text, node });
      }
    }
    textNodes.sort((a, b) => b.text.length - a.text.length);
    return textNodes[0]?.text || '';
  }

  function getCommentAuthor(container) {
    const selectors = [
      '#author-text',
      '.author-text',
      '#name #text',
      'a.author-name',
      '[class*="author"]',
    ];
    const el = findElement(container, selectors);
    return el ? el.textContent.trim() : 'Un viewer';
  }

  function hasOwnerReply(container) {
    const badges = findElements(container, [
      '#author-comment-badge',
      'ytcp-author-comment-badge',
      '.owner-badge',
      '[class*="creator-badge"]',
      '[class*="owner"]',
    ]);
    for (const badge of badges) {
      const inReply = badge.closest('[class*="repl"]') ||
        badge.closest('#replies') ||
        badge.closest('[id*="repl"]');
      if (inReply) return true;
    }
    const replySection = findElement(container, [
      '#replies',
      '#loaded-replies',
      '[class*="replies"]',
    ]);
    if (replySection) {
      if (findElement(replySection, ['[class*="badge"]', '[class*="creator"]'])) {
        return true;
      }
    }
    return false;
  }

  function getCommentId(container) {
    const text = getCommentText(container);
    const author = getCommentAuthor(container);
    if (!text) return null;
    const str = `${author}::${text.slice(0, 100)}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash = hash & hash;
    }
    return `cmt_${Math.abs(hash).toString(36)}`;
  }

  function extractVideoId() {
    const urlMatch = window.location.pathname.match(/\/video\/([^/]+)/);
    if (urlMatch) return urlMatch[1];
    const link = findElement(document, [
      'a[href*="/video/"]',
      '[class*="video-title"] a',
    ]);
    if (link) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/\/video\/([^/]+)/);
      if (match) return match[1];
    }
    return null;
  }

  function extractVideoIdFromContainer(container) {
    const link = findElement(container, ['a[href*="/video/"]']);
    if (link) {
      const match = (link.getAttribute('href') || '').match(/\/video\/([^/]+)/);
      if (match) return match[1];
    }
    return extractVideoId();
  }

  // -------------------------------------------------------------------------
  // Message passing
  // -------------------------------------------------------------------------

  function sendMessage(msg) {
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

  // -------------------------------------------------------------------------
  // Suggestion UI — Cards layout
  // -------------------------------------------------------------------------

  function createSuggestionsContainer(container, commentId) {
    if (container.querySelector(`.${SUGGESTIONS_CLASS}`)) return null;

    const el = document.createElement('div');
    el.className = SUGGESTIONS_CLASS;
    el.dataset.commentId = commentId;

    // Loading state with skeleton cards
    el.innerHTML = `
      <div class="${NAMESPACE}-loading">
        <div class="${NAMESPACE}-loading-label">
          <div class="${NAMESPACE}-loading-dot"></div>
          <div class="${NAMESPACE}-loading-bar"></div>
        </div>
        <div class="${NAMESPACE}-skeleton-row">
          <div class="${NAMESPACE}-skeleton-num"></div>
          <div class="${NAMESPACE}-skeleton-lines">
            <div class="${NAMESPACE}-skeleton-line"></div>
            <div class="${NAMESPACE}-skeleton-line"></div>
          </div>
        </div>
        <div class="${NAMESPACE}-skeleton-row">
          <div class="${NAMESPACE}-skeleton-num"></div>
          <div class="${NAMESPACE}-skeleton-lines">
            <div class="${NAMESPACE}-skeleton-line"></div>
            <div class="${NAMESPACE}-skeleton-line"></div>
          </div>
        </div>
        <div class="${NAMESPACE}-skeleton-row">
          <div class="${NAMESPACE}-skeleton-num"></div>
          <div class="${NAMESPACE}-skeleton-lines">
            <div class="${NAMESPACE}-skeleton-line"></div>
            <div class="${NAMESPACE}-skeleton-line"></div>
          </div>
        </div>
      </div>
    `;

    container.appendChild(el);
    return el;
  }

  function renderSuggestions(wrapper, suggestions, providerName, fallback) {
    if (!wrapper) return;
    const commentId = wrapper.dataset.commentId;
    wrapper.innerHTML = '';

    // Label row
    const label = document.createElement('div');
    label.className = `${NAMESPACE}-label`;
    label.innerHTML = `
      <span class="${NAMESPACE}-label-text">💬 Suggestions IA</span>
      <div class="${NAMESPACE}-label-line"></div>
      <div class="${NAMESPACE}-label-actions">
        <button class="${NAMESPACE}-icon-btn ${NAMESPACE}-regen" title="Regenerer">↻</button>
        <button class="${NAMESPACE}-icon-btn ${NAMESPACE}-dismiss-btn" title="Masquer">✕</button>
      </div>
    `;
    wrapper.appendChild(label);

    // Regen handler
    label.querySelector(`.${NAMESPACE}-regen`).addEventListener('click', (e) => {
      e.stopPropagation();
      regenerate(wrapper);
    });

    // Dismiss handler
    label.querySelector(`.${NAMESPACE}-dismiss-btn`).addEventListener('click', (e) => {
      e.stopPropagation();
      sendMessage({ type: 'DISMISS_COMMENT', commentId });
      const container = wrapper.parentElement;
      wrapper.remove();
      // Add dismissed hint
      const hint = document.createElement('div');
      hint.className = `${NAMESPACE}-dismissed`;
      hint.innerHTML = `
        <span>Suggestions masquees</span>
        <span>·</span>
        <button class="${NAMESPACE}-restore-btn">Reafficher</button>
      `;
      hint.querySelector(`.${NAMESPACE}-restore-btn`).addEventListener('click', () => {
        hint.remove();
        generateForContainer(container, true);
      });
      container.appendChild(hint);
    });

    // Cards list
    const list = document.createElement('div');
    list.className = `${NAMESPACE}-list`;

    const cards = [];

    suggestions.forEach((text, i) => {
      if (!text) return;

      const card = document.createElement('div');
      card.className = `${NAMESPACE}-card`;

      const num = document.createElement('div');
      num.className = `${NAMESPACE}-num`;
      num.textContent = i + 1;

      const content = document.createElement('div');
      content.className = `${NAMESPACE}-content`;

      const textEl = document.createElement('div');
      textEl.className = `${NAMESPACE}-text`;
      textEl.textContent = text;

      const typeEl = document.createElement('div');
      typeEl.className = `${NAMESPACE}-type`;
      typeEl.textContent = SUGGESTION_TYPES[i] || '';

      content.appendChild(textEl);
      content.appendChild(typeEl);

      const insertBtn = document.createElement('button');
      insertBtn.className = `${NAMESPACE}-insert`;
      insertBtn.textContent = 'Inserer';

      card.appendChild(num);
      card.appendChild(content);
      card.appendChild(insertBtn);

      // Click on card or button inserts
      const handleInsert = (e) => {
        e.stopPropagation();
        insertReply(wrapper.parentElement, text);

        // Mark as inserted
        card.classList.add('inserted');
        num.textContent = '✓';
        typeEl.textContent = '✓ Inseree dans le champ de reponse';
        insertBtn.textContent = 'Inseree';

        // Dim other cards
        cards.forEach((c) => {
          if (c !== card) c.classList.add('dimmed');
        });
      };

      card.addEventListener('click', handleInsert);
      insertBtn.addEventListener('click', handleInsert);

      list.appendChild(card);
      cards.push(card);
    });

    wrapper.appendChild(list);

    // Provider badge
    if (providerName && providerName !== 'chrome-ai') {
      const badge = document.createElement('span');
      badge.className = `${NAMESPACE}-provider-badge`;
      badge.textContent = providerName === 'anthropic' ? 'Claude' : providerName === 'openai' ? 'GPT-4o' : providerName;
      label.querySelector(`.${NAMESPACE}-label-actions`).prepend(badge);
    }
  }

  function renderError(wrapper, msg) {
    if (!wrapper) return;
    wrapper.innerHTML = `
      <div class="${NAMESPACE}-label">
        <span class="${NAMESPACE}-label-text">💬 Suggestions IA</span>
        <div class="${NAMESPACE}-label-line"></div>
      </div>
      <div class="${NAMESPACE}-error">
        <span class="${NAMESPACE}-error-text">${msg || 'Erreur de generation'}</span>
        <button class="${NAMESPACE}-icon-btn" title="Reessayer">↻</button>
      </div>
    `;
    wrapper.querySelector(`.${NAMESPACE}-icon-btn`).addEventListener('click', () =>
      regenerate(wrapper)
    );
  }

  // -------------------------------------------------------------------------
  // Reply insertion
  // -------------------------------------------------------------------------

  function insertReply(container, text) {
    if (!container) return;

    const replyBtn = findElement(container, [
      '#reply-button button',
      '#reply-button',
      'button[aria-label*="reply" i]',
      'button[aria-label*="reponse" i]',
      'button[aria-label*="réponse" i]',
      'button[aria-label*="répondre" i]',
      '[class*="reply-button"]',
    ]);
    if (replyBtn) replyBtn.click();

    setTimeout(() => {
      const input = findElement(container, [
        '#contenteditable-root',
        '[contenteditable="true"]',
        'div[aria-label*="reply" i]',
        'div[aria-label*="reponse" i]',
        'div[aria-label*="réponse" i]',
        'div[aria-label*="répondre" i]',
        'textarea',
      ]);

      if (input) {
        input.focus();
        if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
          input.value = text;
        } else {
          input.textContent = text;
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: text,
          })
        );
      }
    }, 400);
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  async function generateForContainer(container, force) {
    const text = getCommentText(container);
    if (!text || text.length < 5) return;

    const commentId = getCommentId(container);
    if (!commentId) return;

    if (!force) {
      const { dismissed } = await sendMessage({ type: 'IS_DISMISSED', commentId });
      if (dismissed) return;
    }

    const wrapper = createSuggestionsContainer(container, commentId);
    if (!wrapper) return;

    const videoId = extractVideoIdFromContainer(container);
    const author = getCommentAuthor(container);

    const result = await sendMessage({
      type: 'GENERATE_SUGGESTIONS',
      commentText: text,
      commentAuthor: author,
      videoId,
      videoTitle: '',
    });

    if (result.error) {
      renderError(wrapper, result.error);
      return;
    }

    renderSuggestions(wrapper, result.suggestions, result.provider, result.fallback);
  }

  async function regenerate(wrapper) {
    const container = wrapper.parentElement;
    if (!container) return;

    wrapper.innerHTML = `
      <div class="${NAMESPACE}-loading">
        <div class="${NAMESPACE}-loading-label">
          <div class="${NAMESPACE}-loading-dot"></div>
          <div class="${NAMESPACE}-loading-bar"></div>
        </div>
        <div class="${NAMESPACE}-skeleton-row">
          <div class="${NAMESPACE}-skeleton-num"></div>
          <div class="${NAMESPACE}-skeleton-lines">
            <div class="${NAMESPACE}-skeleton-line"></div>
            <div class="${NAMESPACE}-skeleton-line"></div>
          </div>
        </div>
        <div class="${NAMESPACE}-skeleton-row">
          <div class="${NAMESPACE}-skeleton-num"></div>
          <div class="${NAMESPACE}-skeleton-lines">
            <div class="${NAMESPACE}-skeleton-line"></div>
            <div class="${NAMESPACE}-skeleton-line"></div>
          </div>
        </div>
        <div class="${NAMESPACE}-skeleton-row">
          <div class="${NAMESPACE}-skeleton-num"></div>
          <div class="${NAMESPACE}-skeleton-lines">
            <div class="${NAMESPACE}-skeleton-line"></div>
            <div class="${NAMESPACE}-skeleton-line"></div>
          </div>
        </div>
      </div>
    `;

    const result = await sendMessage({
      type: 'GENERATE_SUGGESTIONS',
      commentText: getCommentText(container),
      commentAuthor: getCommentAuthor(container),
      videoId: extractVideoIdFromContainer(container),
      videoTitle: '',
    });

    if (result.error) {
      renderError(wrapper, result.error);
      return;
    }

    renderSuggestions(wrapper, result.suggestions, result.provider, result.fallback);
  }

  // -------------------------------------------------------------------------
  // Reply capture (apprentissage continu)
  // -------------------------------------------------------------------------

  function watchForReplies() {
    document.addEventListener(
      'click',
      (e) => {
        const btn = e.target.closest(
          '#submit-button button, #submit-button, button[aria-label*="submit" i], button[aria-label*="envoyer" i]'
        );
        if (!btn) return;

        let scope = btn.parentElement;
        for (let i = 0; i < 5; i++) {
          if (!scope) break;
          const input = findElement(scope, [
            '#contenteditable-root',
            '[contenteditable="true"]',
            'textarea',
          ]);
          if (input) {
            const replyText = input.value || input.textContent || '';
            if (replyText.trim().length > 5) {
              sendMessage({ type: 'RECORD_REPLY', replyText: replyText.trim() });
            }
            const suggestions = scope.querySelector(`.${SUGGESTIONS_CLASS}`);
            if (suggestions) {
              suggestions.classList.add(`${NAMESPACE}-posted`);
              setTimeout(() => suggestions.remove(), 300);
            }
            break;
          }
          scope = scope.parentElement;
        }
      },
      true
    );
  }

  // -------------------------------------------------------------------------
  // Detection + Intersection Observer
  // -------------------------------------------------------------------------

  let observer = null;
  const pending = new Map();

  function setupObserver() {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target;
          if (entry.isIntersecting) {
            if (!pending.has(el)) {
              const t = setTimeout(() => {
                pending.delete(el);
                generateForContainer(el);
              }, DEBOUNCE_MS);
              pending.set(el, t);
            }
          } else {
            const t = pending.get(el);
            if (t) {
              clearTimeout(t);
              pending.delete(el);
            }
          }
        }
      },
      { threshold: 0.3 }
    );
  }

  function scanComments() {
    const containers = findCommentContainers();

    let newCount = 0;
    for (const c of containers) {
      if (c.hasAttribute(PROCESSED_ATTR)) continue;
      c.setAttribute(PROCESSED_ATTR, 'true');

      if (hasOwnerReply(c)) continue;

      const text = getCommentText(c);
      if (!text || text.length < 5) continue;

      if (observer) observer.observe(c);
      newCount++;
    }

    if (newCount > 0) {
      console.log(`[YT Reply Assistant] ${newCount} nouveaux commentaires detectes`);
    }
  }

  // -------------------------------------------------------------------------
  // MutationObserver
  // -------------------------------------------------------------------------

  function watchDOM() {
    let timeout;
    const mo = new MutationObserver(() => {
      clearTimeout(timeout);
      timeout = setTimeout(scanComments, 300);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // -------------------------------------------------------------------------
  // Communication avec le popup
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SCRAPE_REPLIES') {
      const ownerReplies = [];
      const allElements = findElements(document, [
        'ytcp-comment',
        '[class*="comment"]',
      ]);
      for (const el of allElements) {
        const badge = findElement(el, [
          '#author-comment-badge',
          'ytcp-author-comment-badge',
          '[class*="owner"]',
          '[class*="creator-badge"]',
        ]);
        if (badge) {
          const text = getCommentText(el);
          if (text && text.length > 5) ownerReplies.push(text);
        }
      }
      sendResponse(ownerReplies);
      return false;
    }

    if (msg.type === 'FORCE_SCAN') {
      scanComments();
      sendResponse({ ok: true });
      return false;
    }
  });

  // -------------------------------------------------------------------------
  // Init
  // -------------------------------------------------------------------------

  async function init() {
    const isCommentsPage =
      window.location.pathname.includes('/comments') ||
      window.location.pathname.includes('/community');

    if (!isCommentsPage) return;

    const { onboarded } = await sendMessage({ type: 'GET_ONBOARDING_STATUS' });
    if (!onboarded) {
      console.log('[YT Reply Assistant] En attente de l\'onboarding...');
      return;
    }

    console.log('[YT Reply Assistant] Actif sur', window.location.href);

    setupObserver();
    watchDOM();
    watchForReplies();

    scanComments();
    setInterval(scanComments, 5000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 1000));
  } else {
    setTimeout(init, 1000);
  }
})();
