// =============================================================================
// YT Reply Assistant — Content Script (v4 — robuste)
// Injecte dans studio.youtube.com
// Bouton "Generer" pill bleue → clic → loading → suggestions cards
// =============================================================================

(function () {
  'use strict';

  const NAMESPACE = 'yt-reply-assistant';
  const PROCESSED_ATTR = `data-${NAMESPACE}-processed`;
  const SUGGESTIONS_CLASS = `${NAMESPACE}-suggestions`;
  const TRIGGER_CLASS = `${NAMESPACE}-trigger`;
  const LOG = (...args) => console.log('[YT Reply Assistant]', ...args);
  const ERR = (...args) => console.error('[YT Reply Assistant]', ...args);

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
    } catch { /* invalid selector in this context */ }

    // CRITICAL: also check root's own shadow root (e.g. ytcp-comment)
    if (root.shadowRoot) {
      try {
        root.shadowRoot.querySelectorAll(selector).forEach((el) => results.push(el));
      } catch { /* ignore */ }
      // And traverse shadow root's children too
      root.shadowRoot.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) {
          results.push(...deepQueryAll(el.shadowRoot, selector));
        }
      });
    }

    // Traverse light DOM children's shadow roots
    try {
      root.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) {
          results.push(...deepQueryAll(el.shadowRoot, selector));
        }
      });
    } catch { /* ignore */ }

    return results;
  }

  function deepQuery(root, selector) {
    return deepQueryAll(root, selector)[0] || null;
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
    // Strategy 1: ytcp-comment (most specific, avoids thread/comment dupes)
    let containers = findElements(document, ['ytcp-comment']);

    // Strategy 2: thread-level
    if (containers.length === 0) {
      containers = findElements(document, [
        'ytcp-comment-thread', '.comment-thread-renderer',
      ]);
    }

    // Strategy 3: generic patterns
    if (containers.length === 0) {
      containers = findElements(document, [
        '[class*="comment-thread"]', '[class*="comment-item"]',
      ]);
      containers = containers.filter((el) => {
        const text = el.textContent || '';
        return text.length > 20 && text.length < 10000;
      });
    }

    // Strategy 4: find via reply buttons
    if (containers.length === 0) {
      const replyBtns = findElements(document, [
        'button[aria-label*="reply" i]', 'button[aria-label*="reponse" i]',
        'button[aria-label*="réponse" i]', 'button[aria-label*="répondre" i]',
        '[class*="reply-button"]',
      ]);
      containers = replyBtns
        .map((btn) => {
          let parent = btn.parentElement;
          for (let i = 0; i < 8; i++) {
            if (!parent || parent === document.body) break;
            if (parent.offsetHeight > 50 && parent.offsetHeight < 600) return parent;
            parent = parent.parentElement;
          }
          return null;
        })
        .filter(Boolean);
    }

    // Deduplicate: keep only the most specific (innermost) containers
    const deduped = containers.filter((c) =>
      !containers.some((other) => other !== c && c.contains(other))
    );

    return deduped;
  }

  function getCommentText(container) {
    // Method 1: known selectors (with deep/shadow DOM support)
    const selectors = [
      '#content-text', '#plain-text', 'yt-formatted-string#content-text',
      '.comment-text', '[class*="comment-text"]', '[class*="comment-content"]',
    ];
    const el = findElement(container, selectors);
    if (el) return el.textContent.trim();

    // Method 2: TreeWalker on light DOM
    const textNodes = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (text.length > 20) textNodes.push({ text, node });
    }

    // Method 3: also check shadow DOM text if available
    if (container.shadowRoot) {
      const sWalker = document.createTreeWalker(container.shadowRoot, NodeFilter.SHOW_TEXT);
      while ((node = sWalker.nextNode())) {
        const text = node.textContent.trim();
        if (text.length > 20) textNodes.push({ text, node });
      }
    }

    textNodes.sort((a, b) => b.text.length - a.text.length);
    return textNodes[0]?.text || '';
  }

  function getCommentAuthor(container) {
    const el = findElement(container, [
      '#author-text', '.author-text', '#name #text',
      'a.author-name', '[class*="author"]',
    ]);
    return el ? el.textContent.trim() : 'Un viewer';
  }

  function hasOwnerReply(container) {
    const badges = findElements(container, [
      '#author-comment-badge', 'ytcp-author-comment-badge',
      '.owner-badge', '[class*="creator-badge"]', '[class*="owner"]',
    ]);
    for (const badge of badges) {
      const inReply = badge.closest('[class*="repl"]') ||
        badge.closest('#replies') || badge.closest('[id*="repl"]');
      if (inReply) return true;
    }
    const replySection = findElement(container, [
      '#replies', '#loaded-replies', '[class*="replies"]',
    ]);
    if (replySection && findElement(replySection, ['[class*="badge"]', '[class*="creator"]'])) {
      return true;
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
    const link = findElement(document, ['a[href*="/video/"]', '[class*="video-title"] a']);
    if (link) {
      const match = (link.getAttribute('href') || '').match(/\/video\/([^/]+)/);
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
  // Message passing (with timeout)
  // -------------------------------------------------------------------------

  function sendMessage(msg, timeoutMs = 30000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ error: 'Timeout — le service worker ne repond pas. Rechargez l\'extension.' });
      }, timeoutMs);

      try {
        chrome.runtime.sendMessage(msg, (res) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            resolve({ error: chrome.runtime.lastError.message });
          } else {
            resolve(res || { error: 'Reponse vide du background' });
          }
        });
      } catch (e) {
        clearTimeout(timer);
        resolve({ error: 'Extension deconnectee: ' + e.message });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Find best insertion point for our UI
  // -------------------------------------------------------------------------

  function findInsertionPoint(container) {
    // Try to insert AFTER the actions bar for best visibility
    const actionsBar = findElement(container, [
      '#toolbar', '#action-buttons', '.comment-actions',
      '[class*="action-buttons"]', '[class*="toolbar"]',
    ]);
    if (actionsBar && actionsBar.parentElement) {
      return { parent: actionsBar.parentElement, after: actionsBar };
    }
    // Fallback: append to the container
    return { parent: container, after: null };
  }

  function insertAfter(newEl, refEl) {
    if (refEl && refEl.nextSibling) {
      refEl.parentElement.insertBefore(newEl, refEl.nextSibling);
    } else if (refEl && refEl.parentElement) {
      refEl.parentElement.appendChild(newEl);
    }
  }

  // -------------------------------------------------------------------------
  // Bouton "Generer" — pill bleue dans la barre d'actions
  // -------------------------------------------------------------------------

  function injectTriggerButton(container) {
    // Check both light DOM and shadow DOM for existing button
    if (container.querySelector(`.${TRIGGER_CLASS}`)) return;
    if (container.shadowRoot && container.shadowRoot.querySelector(`.${TRIGGER_CLASS}`)) return;

    const commentId = getCommentId(container);
    if (!commentId) return;

    const btn = document.createElement('button');
    btn.className = TRIGGER_CLASS;
    btn.dataset.commentId = commentId;
    btn.innerHTML = '<span class="' + NAMESPACE + '-trigger-sparkle">✨</span> Generer';
    btn.title = 'Generer une reponse IA';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();

      // Transform button to loading state — DON'T remove it yet
      btn.disabled = true;
      btn.classList.add(`${NAMESPACE}-trigger-loading`);
      btn.innerHTML = '<span class="' + NAMESPACE + '-trigger-spinner"></span> Generation...';

      generateForContainer(container, commentId, btn);
    });

    // Insert into the actions bar if possible
    const actionsBar = findElement(container, [
      '#toolbar', '#action-buttons', '.comment-actions',
      '[class*="action-buttons"]', '[class*="toolbar"]',
    ]);

    if (actionsBar) {
      actionsBar.appendChild(btn);
    } else {
      container.appendChild(btn);
    }
  }

  function restoreTriggerButton(btn) {
    if (!btn || !btn.parentElement) return;
    btn.disabled = false;
    btn.classList.remove(`${NAMESPACE}-trigger-loading`);
    btn.innerHTML = '<span class="' + NAMESPACE + '-trigger-sparkle">✨</span> Generer';
  }

  // -------------------------------------------------------------------------
  // Suggestion UI — Skeleton loading
  // -------------------------------------------------------------------------

  function createSkeletonHTML() {
    return `
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
  }

  // -------------------------------------------------------------------------
  // Portal: suggestions are appended to document.body and positioned
  // absolutely, anchored to the comment. This avoids ALL YouTube Studio
  // CSS interference (overflow:hidden, Polymer slots, shadow DOM, etc.)
  // -------------------------------------------------------------------------

  /** Track all active portals for cleanup */
  const activePortals = new Map(); // commentId -> { el, rafId, container }

  /**
   * Find existing suggestions portal by commentId.
   */
  function findExistingSuggestions(container, commentId) {
    if (commentId && activePortals.has(commentId)) {
      return activePortals.get(commentId).el;
    }
    // Also search DOM directly (safety net)
    if (commentId) {
      return document.querySelector(`.${SUGGESTIONS_CLASS}[data-comment-id="${commentId}"]`);
    }
    return null;
  }

  /**
   * Find the scrollable ancestor of the comments list.
   */
  function findScrollParent(el) {
    let parent = el.parentElement;
    while (parent && parent !== document.documentElement) {
      const style = getComputedStyle(parent);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll' ||
          style.overflow === 'auto' || style.overflow === 'scroll') {
        return parent;
      }
      parent = parent.parentElement;
    }
    return window;
  }

  /**
   * Position the portal element below the comment container.
   * Also adds margin-bottom to the anchor element to push content down
   * (since the portal is absolutely positioned and out of flow).
   */
  function startPositioning(el, container, commentId) {
    const scrollParent = findScrollParent(container);
    // The anchor is the thread (or container itself) — we add margin to it
    const anchor = container.closest('ytcp-comment-thread') || container;
    const originalMargin = anchor.style.marginBottom || '';

    function updatePosition() {
      if (!el.isConnected || !container.isConnected) {
        stopPositioning(commentId);
        return;
      }

      const portalH = el.offsetHeight || 0;
      const rect = anchor.getBoundingClientRect();
      const bodyRect = document.body.getBoundingClientRect();

      // Natural bottom = top + offsetHeight (excludes margin we added)
      const anchorTop = rect.top - bodyRect.top;
      const anchorBottom = anchorTop + anchor.offsetHeight;

      // Place portal right below anchor's natural edge
      el.style.top = (anchorBottom + 2) + 'px';
      el.style.left = (rect.left - bodyRect.left) + 'px';
      el.style.width = rect.width + 'px';

      // Reserve space below so content is pushed down
      if (portalH > 0) {
        anchor.style.marginBottom = (portalH + 6) + 'px';
      }
    }

    // Initial position (with delay to let skeleton render)
    requestAnimationFrame(() => {
      updatePosition();
      // Second pass after layout
      requestAnimationFrame(updatePosition);
    });

    // Re-position on scroll (using rAF for smoothness)
    let ticking = false;
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(() => {
          updatePosition();
          ticking = false;
        });
      }
    };

    const scrollTarget = scrollParent === window ? window : scrollParent;
    scrollTarget.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });

    // Store for cleanup
    activePortals.set(commentId, {
      el,
      container,
      anchor,
      originalMargin,
      cleanup: () => {
        scrollTarget.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onScroll);
        // Restore original margin
        anchor.style.marginBottom = originalMargin;
      },
    });
  }

  function stopPositioning(commentId) {
    const portal = activePortals.get(commentId);
    if (portal) {
      portal.cleanup();
      activePortals.delete(commentId);
    }
  }

  /**
   * Remove a suggestions portal cleanly.
   */
  function removeSuggestionsPortal(commentId) {
    const portal = activePortals.get(commentId);
    if (portal) {
      portal.el.remove();
      portal.cleanup();
      activePortals.delete(commentId);
    } else {
      // Fallback: find by DOM query
      const el = document.querySelector(`.${SUGGESTIONS_CLASS}[data-comment-id="${commentId}"]`);
      if (el) el.remove();
    }
  }

  /**
   * Update the space reserved for a portal after content changes
   * (e.g. skeleton replaced by actual suggestions).
   */
  function updatePortalSpace(commentId) {
    const portal = activePortals.get(commentId);
    if (portal && portal.el.isConnected) {
      const portalH = portal.el.offsetHeight;
      const rect = portal.anchor.getBoundingClientRect();
      const bodyRect = document.body.getBoundingClientRect();
      const anchorBottom = (rect.top - bodyRect.top) + portal.anchor.offsetHeight;

      portal.el.style.top = (anchorBottom + 2) + 'px';
      if (portalH > 0) {
        portal.anchor.style.marginBottom = (portalH + 6) + 'px';
      }
    }
  }

  function createSuggestionsContainer(container, commentId) {
    // Remove any existing suggestions for this comment
    removeSuggestionsPortal(commentId);

    const el = document.createElement('div');
    el.className = SUGGESTIONS_CLASS;
    el.dataset.commentId = commentId;
    el._commentContainer = container;
    el.innerHTML = createSkeletonHTML();

    // ---------------------------------------------------------------
    // PORTAL APPROACH: append to document.body, positioned absolutely.
    // This completely avoids YouTube Studio's CSS/Shadow DOM interference.
    // The element lives outside Polymer's component tree.
    // A margin-bottom is added to the anchor to reserve space in the flow.
    // ---------------------------------------------------------------
    document.body.appendChild(el);
    startPositioning(el, container, commentId);

    LOG('Suggestions portal cree pour', commentId);
    return el;
  }

  // -------------------------------------------------------------------------
  // Suggestion UI — Rendered cards
  // -------------------------------------------------------------------------

  function renderSuggestions(wrapper, suggestions, providerName, fallback, container) {
    if (!wrapper) return;
    wrapper.innerHTML = '';

    // Label row
    const label = document.createElement('div');
    label.className = `${NAMESPACE}-label`;
    label.innerHTML = `
      <span class="${NAMESPACE}-label-text">💬 Suggestions IA</span>
      <div class="${NAMESPACE}-label-line"></div>
      <div class="${NAMESPACE}-label-actions">
        ${providerName && providerName !== 'chrome-ai'
          ? `<span class="${NAMESPACE}-provider-badge">${providerName === 'anthropic' ? 'Claude' : providerName === 'openai' ? 'GPT-4o' : providerName}</span>`
          : ''}
        <button class="${NAMESPACE}-icon-btn ${NAMESPACE}-regen" title="Regenerer">↻</button>
        <button class="${NAMESPACE}-icon-btn ${NAMESPACE}-dismiss-btn" title="Masquer">✕</button>
      </div>
    `;
    wrapper.appendChild(label);

    label.querySelector(`.${NAMESPACE}-regen`).addEventListener('click', (e) => {
      e.stopPropagation();
      regenerate(wrapper, container);
    });

    label.querySelector(`.${NAMESPACE}-dismiss-btn`).addEventListener('click', (e) => {
      e.stopPropagation();
      const cid = wrapper.dataset.commentId;
      removeSuggestionsPortal(cid);
      // Re-inject the trigger button
      injectTriggerButton(container);
    });

    // Cards
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

      const handleInsert = (e) => {
        e.stopPropagation();
        insertReply(container, text);
        card.classList.add('inserted');
        num.textContent = '✓';
        typeEl.textContent = '✓ Inseree dans le champ de reponse';
        insertBtn.textContent = 'Inseree';
        cards.forEach((c) => { if (c !== card) c.classList.add('dimmed'); });
      };

      card.addEventListener('click', handleInsert);
      insertBtn.addEventListener('click', handleInsert);

      list.appendChild(card);
      cards.push(card);
    });

    wrapper.appendChild(list);
    LOG('Suggestions rendues:', suggestions.length, 'cards');

    // Update portal space now that content changed (cards replace skeleton)
    requestAnimationFrame(() => updatePortalSpace(wrapper.dataset.commentId));
  }

  function renderError(wrapper, msg, container) {
    if (!wrapper) return;
    wrapper.innerHTML = `
      <div class="${NAMESPACE}-label">
        <span class="${NAMESPACE}-label-text">💬 Suggestions IA</span>
        <div class="${NAMESPACE}-label-line"></div>
      </div>
      <div class="${NAMESPACE}-error">
        <span class="${NAMESPACE}-error-text">${msg || 'Erreur de generation'}</span>
        <button class="${NAMESPACE}-icon-btn" title="Reessayer">↻</button>
        <button class="${NAMESPACE}-icon-btn ${NAMESPACE}-dismiss-err" title="Fermer">✕</button>
      </div>
    `;
    wrapper.querySelector(`.${NAMESPACE}-icon-btn`).addEventListener('click', () =>
      regenerate(wrapper, container)
    );
    wrapper.querySelector(`.${NAMESPACE}-dismiss-err`).addEventListener('click', () => {
      removeSuggestionsPortal(wrapper.dataset.commentId);
      injectTriggerButton(container);
    });

    // Update portal space
    requestAnimationFrame(() => updatePortalSpace(wrapper.dataset.commentId));
  }

  // -------------------------------------------------------------------------
  // Reply insertion
  // -------------------------------------------------------------------------

  function insertReply(container, text) {
    if (!container) return;

    const replyBtn = findElement(container, [
      '#reply-button button', '#reply-button',
      'button[aria-label*="reply" i]', 'button[aria-label*="reponse" i]',
      'button[aria-label*="réponse" i]', 'button[aria-label*="répondre" i]',
      '[class*="reply-button"]',
    ]);
    if (replyBtn) {
      LOG('Clic sur le bouton repondre');
      replyBtn.click();
    }

    setTimeout(() => {
      const input = findElement(container, [
        '#contenteditable-root', '[contenteditable="true"]',
        'div[aria-label*="reply" i]', 'div[aria-label*="reponse" i]',
        'div[aria-label*="réponse" i]', 'div[aria-label*="répondre" i]',
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
            bubbles: true, cancelable: true,
            inputType: 'insertText', data: text,
          })
        );
        LOG('Texte insere dans le champ de reponse');
      } else {
        ERR('Champ de reponse non trouve');
      }
    }, 500);
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  async function generateForContainer(container, commentId, triggerBtn) {
    try {
      const text = getCommentText(container);
      LOG('Texte du commentaire:', text ? text.slice(0, 80) + '...' : '(vide)');

      if (!text || text.length < 5) {
        ERR('Texte du commentaire trop court ou vide');
        restoreTriggerButton(triggerBtn);
        return;
      }

      if (!commentId) {
        commentId = getCommentId(container);
      }
      if (!commentId) {
        ERR('Impossible de generer un ID pour ce commentaire');
        restoreTriggerButton(triggerBtn);
        return;
      }

      // Create skeleton loading UI
      const wrapper = createSuggestionsContainer(container, commentId);
      if (!wrapper) {
        ERR('Impossible de creer le conteneur de suggestions');
        restoreTriggerButton(triggerBtn);
        return;
      }

      // Now we have a visible skeleton — remove the trigger button
      if (triggerBtn && triggerBtn.parentElement) {
        triggerBtn.remove();
      }

      const videoId = extractVideoIdFromContainer(container);
      const author = getCommentAuthor(container);
      LOG('Generation:', { commentId, videoId, author: author.slice(0, 20) });

      const result = await sendMessage({
        type: 'GENERATE_SUGGESTIONS',
        commentText: text,
        commentAuthor: author,
        videoId,
        videoTitle: '',
      });

      LOG('Resultat:', result.error ? 'ERREUR: ' + result.error : 'OK, ' + (result.suggestions?.length || 0) + ' suggestions');

      if (result.error) {
        renderError(wrapper, result.error, container);
        return;
      }

      if (!result.suggestions || result.suggestions.length === 0) {
        renderError(wrapper, 'Aucune suggestion generee', container);
        return;
      }

      renderSuggestions(wrapper, result.suggestions, result.provider, result.fallback, container);

    } catch (e) {
      ERR('Erreur inattendue:', e);
      // Try to restore the button
      restoreTriggerButton(triggerBtn);
    }
  }

  async function regenerate(wrapper, container) {
    if (!container) {
      container = wrapper._commentContainer;
    }
    if (!container) return;

    wrapper.innerHTML = createSkeletonHTML();

    try {
      const result = await sendMessage({
        type: 'GENERATE_SUGGESTIONS',
        commentText: getCommentText(container),
        commentAuthor: getCommentAuthor(container),
        videoId: extractVideoIdFromContainer(container),
        videoTitle: '',
      });

      if (result.error) {
        renderError(wrapper, result.error, container);
        return;
      }

      if (!result.suggestions || result.suggestions.length === 0) {
        renderError(wrapper, 'Aucune suggestion generee', container);
        return;
      }

      renderSuggestions(wrapper, result.suggestions, result.provider, result.fallback, container);
    } catch (e) {
      ERR('Erreur regeneration:', e);
      renderError(wrapper, 'Erreur: ' + e.message, container);
    }
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
            '#contenteditable-root', '[contenteditable="true"]', 'textarea',
          ]);
          if (input) {
            const replyText = input.value || input.textContent || '';
            if (replyText.trim().length > 5) {
              sendMessage({ type: 'RECORD_REPLY', replyText: replyText.trim() });
            }
            // Find the active suggestions portal for this comment
            // Walk up to find the comment container, get its ID
            let commentContainer = scope.closest('ytcp-comment') || scope.closest('[data-yt-reply-assistant-processed]');
            if (commentContainer) {
              const cid = getCommentId(commentContainer);
              if (cid) {
                const suggestionsEl = findExistingSuggestions(commentContainer, cid);
                if (suggestionsEl) {
                  suggestionsEl.classList.add(`${NAMESPACE}-posted`);
                  setTimeout(() => removeSuggestionsPortal(cid), 300);
                }
              }
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
  // Scan: injecte un bouton "Generer" sur chaque commentaire non repondu
  // -------------------------------------------------------------------------

  function scanComments() {
    const containers = findCommentContainers();

    let newCount = 0;
    for (const c of containers) {
      if (c.hasAttribute(PROCESSED_ATTR)) continue;
      c.setAttribute(PROCESSED_ATTR, 'true');

      if (hasOwnerReply(c)) continue;

      const text = getCommentText(c);
      if (!text || text.length < 5) continue;

      injectTriggerButton(c);
      newCount++;
    }

    if (newCount > 0) {
      LOG(newCount, 'nouveaux commentaires detectes, boutons injectes');
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
        'ytcp-comment', '[class*="comment"]',
      ]);
      for (const el of allElements) {
        const badge = findElement(el, [
          '#author-comment-badge', 'ytcp-author-comment-badge',
          '[class*="owner"]', '[class*="creator-badge"]',
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

    if (!isCommentsPage) {
      LOG('Page non-commentaires, inactif');
      return;
    }

    const status = await sendMessage({ type: 'GET_ONBOARDING_STATUS' });
    if (status.error) {
      ERR('Erreur communication background:', status.error);
      return;
    }

    if (!status.onboarded) {
      LOG('En attente de l\'onboarding — ouvrez le popup de l\'extension');
      return;
    }

    LOG('Actif sur', window.location.href);

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
