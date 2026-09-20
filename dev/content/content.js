// =============================================================================
// YT Reply Assistant — Content Script
// Injecte dans studio.youtube.com
// Detecte les commentaires non repondus, affiche des suggestions
// =============================================================================

(function () {
  'use strict';

  const NAMESPACE = 'yt-reply-assistant';
  const PROCESSED_ATTR = `data-${NAMESPACE}-processed`;
  const SUGGESTIONS_CLASS = `${NAMESPACE}-suggestions`;
  const DEBOUNCE_MS = 600;

  // -------------------------------------------------------------------------
  // Deep DOM traversal (handles Shadow DOM)
  // -------------------------------------------------------------------------

  /** Recursively find elements across shadow roots */
  function deepQueryAll(root, selector) {
    const results = [];
    try {
      root.querySelectorAll(selector).forEach((el) => results.push(el));
    } catch { /* invalid selector */ }

    // Traverse shadow roots
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

  /** Try multiple selectors, return first match (with shadow DOM support) */
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
  //
  // YouTube Studio uses custom Polymer elements (ytcp-* prefix).
  // The DOM structure changes regularly. This code uses multiple strategies
  // to find comment elements, falling back gracefully.
  // -------------------------------------------------------------------------

  /** Find all comment containers on the page */
  function findCommentContainers() {
    // Strategy 1: YouTube Studio specific elements
    let containers = findElements(document, [
      'ytcp-comment-thread',
      'ytcp-comment',
      '.comment-thread-renderer',
    ]);

    // Strategy 2: Generic comment-like containers
    if (containers.length === 0) {
      containers = findElements(document, [
        '[class*="comment-thread"]',
        '[class*="comment-item"]',
        '[id*="comment"]',
      ]);
      // Filter out non-comment elements
      containers = containers.filter((el) => {
        const text = el.textContent || '';
        return text.length > 20 && text.length < 10000;
      });
    }

    // Strategy 3: Look for elements containing reply buttons
    if (containers.length === 0) {
      const replyBtns = findElements(document, [
        'button[aria-label*="reply" i]',
        'button[aria-label*="reponse" i]',
        'button[aria-label*="réponse" i]',
        'button[aria-label*="répondre" i]',
        '[class*="reply-button"]',
      ]);
      // Get parent containers
      containers = replyBtns
        .map((btn) => {
          let parent = btn.parentElement;
          // Walk up to find a reasonable container (not too large)
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

  /** Extract comment text from a container */
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

    // Fallback: find the largest text block in the container
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

  /** Extract comment author */
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

  /** Check if the channel owner already replied to this comment */
  function hasOwnerReply(container) {
    // Look for owner badges in replies
    const badges = findElements(container, [
      '#author-comment-badge',
      'ytcp-author-comment-badge',
      '.owner-badge',
      '[class*="creator-badge"]',
      '[class*="owner"]',
    ]);

    // Filter: must be in a reply section, not the main comment
    for (const badge of badges) {
      const inReply = badge.closest('[class*="repl"]') ||
        badge.closest('#replies') ||
        badge.closest('[id*="repl"]');
      if (inReply) return true;
    }

    // Also check by looking for a specific badge icon or text
    const replySection = findElement(container, [
      '#replies',
      '#loaded-replies',
      '[class*="replies"]',
    ]);
    if (replySection) {
      const text = replySection.textContent || '';
      // The owner's channel name might appear as a badge
      // This is a heuristic — not perfect but catches most cases
      if (findElement(replySection, ['[class*="badge"]', '[class*="creator"]'])) {
        return true;
      }
    }

    return false;
  }

  /** Generate a stable ID for a comment */
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

  /** Extract videoId from the page */
  function extractVideoId() {
    // URL: studio.youtube.com/video/{videoId}/comments
    const urlMatch = window.location.pathname.match(/\/video\/([^/]+)/);
    if (urlMatch) return urlMatch[1];

    // Look for video links in the page
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
  // Suggestion UI
  // -------------------------------------------------------------------------

  function createSuggestionsContainer(container, commentId) {
    if (container.querySelector(`.${SUGGESTIONS_CLASS}`)) return null;

    const el = document.createElement('div');
    el.className = SUGGESTIONS_CLASS;
    el.dataset.commentId = commentId;

    // Loading state
    el.innerHTML = `
      <div class="${NAMESPACE}-loading">
        <div class="${NAMESPACE}-skeleton"></div>
        <div class="${NAMESPACE}-skeleton"></div>
        <div class="${NAMESPACE}-skeleton"></div>
      </div>
    `;

    // Insert at end of the container (safest position)
    container.appendChild(el);

    return el;
  }

  function renderSuggestions(wrapper, suggestions, providerName, fallback) {
    if (!wrapper) return;
    const commentId = wrapper.dataset.commentId;
    wrapper.innerHTML = '';

    // Chips
    const chips = document.createElement('div');
    chips.className = `${NAMESPACE}-chips`;

    suggestions.forEach((text) => {
      if (!text) return;
      const chip = document.createElement('button');
      chip.className = `${NAMESPACE}-chip`;
      chip.title = text;
      chip.textContent = text.length > 100 ? text.slice(0, 100) + '...' : text;

      chip.addEventListener('click', () => {
        insertReply(wrapper.parentElement, text);
        wrapper.classList.add(`${NAMESPACE}-used`);
      });
      chips.appendChild(chip);
    });
    wrapper.appendChild(chips);

    // Actions
    const actions = document.createElement('div');
    actions.className = `${NAMESPACE}-actions`;

    const regen = document.createElement('button');
    regen.className = `${NAMESPACE}-action-btn`;
    regen.innerHTML = '&#x21BB;';
    regen.title = 'Regenerer';
    regen.addEventListener('click', () => regenerate(wrapper));
    actions.appendChild(regen);

    const dismiss = document.createElement('button');
    dismiss.className = `${NAMESPACE}-action-btn ${NAMESPACE}-dismiss`;
    dismiss.innerHTML = '&#x2715;';
    dismiss.title = 'Ignorer';
    dismiss.addEventListener('click', () => {
      sendMessage({ type: 'DISMISS_COMMENT', commentId });
      wrapper.remove();
    });
    actions.appendChild(dismiss);

    if (fallback) {
      const badge = document.createElement('span');
      badge.className = `${NAMESPACE}-fallback-badge`;
      badge.textContent = `fallback: ${providerName}`;
      actions.appendChild(badge);
    }

    wrapper.appendChild(actions);
  }

  function renderError(wrapper, msg) {
    if (!wrapper) return;
    wrapper.innerHTML = `
      <div class="${NAMESPACE}-error">
        <span>${msg || 'Erreur de generation'}</span>
        <button class="${NAMESPACE}-action-btn" title="Reessayer">&#x21BB;</button>
      </div>
    `;
    wrapper.querySelector(`.${NAMESPACE}-action-btn`).addEventListener('click', () =>
      regenerate(wrapper)
    );
  }

  // -------------------------------------------------------------------------
  // Reply insertion
  // -------------------------------------------------------------------------

  function insertReply(container, text) {
    if (!container) return;

    // Click reply button to open the field
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

    // Wait for input to appear, then fill it
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
        // Dispatch events so YouTube Studio picks up the change
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

  async function generateForContainer(container) {
    const text = getCommentText(container);
    if (!text || text.length < 5) return;

    const commentId = getCommentId(container);
    if (!commentId) return;

    const { dismissed } = await sendMessage({ type: 'IS_DISMISSED', commentId });
    if (dismissed) return;

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
        <div class="${NAMESPACE}-skeleton"></div>
        <div class="${NAMESPACE}-skeleton"></div>
        <div class="${NAMESPACE}-skeleton"></div>
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

        // Find the input near the button
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
            // Remove suggestions
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
      // Chercher les reponses du proprietaire sur la page
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

    // Scan initial + periodique
    scanComments();
    setInterval(scanComments, 5000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 1000));
  } else {
    setTimeout(init, 1000);
  }
})();
