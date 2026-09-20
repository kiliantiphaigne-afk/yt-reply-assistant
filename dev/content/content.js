// =============================================================================
// YT Reply Assistant — Content Script
// Injected into studio.youtube.com
// Detects unreplied comments, injects suggestion UI, handles interactions
// =============================================================================

(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Configuration — YouTube Studio DOM selectors
  // Centralized here for easy updates when YouTube Studio changes its DOM
  // -------------------------------------------------------------------------
  const SELECTORS = {
    // Comment list containers
    commentThread: [
      'ytcp-comment-thread',
      '[class*="comment-thread"]',
      '.comment-thread-renderer',
    ],
    // Individual comment element
    comment: [
      'ytcp-comment',
      '#comment',
      '[class*="comment-renderer"]',
    ],
    // Comment text content
    commentText: [
      '#content-text',
      '.comment-text',
      '#plain-text',
      '[class*="comment-text"]',
      'yt-formatted-string#content-text',
    ],
    // Commenter name
    commentAuthor: [
      '#author-text',
      '.author-text',
      '#name #text',
      'a.author-name',
    ],
    // Owner badge (indicates channel owner reply)
    ownerBadge: [
      '#author-comment-badge',
      '.owner-badge',
      '[class*="creator-heart"]',
      'ytcp-author-comment-badge',
    ],
    // Reply section (contains owner replies)
    replySection: [
      '#replies',
      '#loaded-replies',
      '.replies-renderer',
      '[class*="replies"]',
    ],
    // Reply input field
    replyInput: [
      '#contenteditable-root',
      '#reply-input',
      '[contenteditable="true"]',
      'div[aria-label*="reply" i]',
      'div[aria-label*="reponse" i]',
      'div[aria-label*="réponse" i]',
    ],
    // Reply button (to trigger reply mode)
    replyButton: [
      '#reply-button button',
      '#reply-button',
      'button[aria-label*="reply" i]',
      'button[aria-label*="reponse" i]',
      'button[aria-label*="réponse" i]',
      '[class*="reply-button"]',
    ],
    // Submit reply button
    submitReply: [
      '#submit-button button',
      '#submit-button',
      'button[aria-label*="submit" i]',
      'button[aria-label*="envoyer" i]',
    ],
    // Video link in comment (to extract videoId)
    videoLink: [
      'a[href*="/video/"]',
      '.video-title a',
      '#video-title',
    ],
  };

  const NAMESPACE = 'yt-reply-assistant';
  const PROCESSED_ATTR = `data-${NAMESPACE}-processed`;
  const SUGGESTIONS_CLASS = `${NAMESPACE}-suggestions`;
  const DEBOUNCE_MS = 500;

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  /** Try multiple selectors, return first match */
  function querySelector(parent, selectorList) {
    if (typeof selectorList === 'string') selectorList = [selectorList];
    for (const sel of selectorList) {
      try {
        const el = parent.querySelector(sel);
        if (el) return el;
      } catch { /* invalid selector, skip */ }
    }
    // Try inside shadow roots
    const shadows = parent.querySelectorAll('*');
    for (const el of shadows) {
      if (el.shadowRoot) {
        for (const sel of selectorList) {
          try {
            const found = el.shadowRoot.querySelector(sel);
            if (found) return found;
          } catch { /* skip */ }
        }
      }
    }
    return null;
  }

  function querySelectorAll(parent, selectorList) {
    if (typeof selectorList === 'string') selectorList = [selectorList];
    const results = [];
    const seen = new Set();
    for (const sel of selectorList) {
      try {
        parent.querySelectorAll(sel).forEach((el) => {
          if (!seen.has(el)) {
            seen.add(el);
            results.push(el);
          }
        });
      } catch { /* skip */ }
    }
    return results;
  }

  function sendMessage(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          console.warn('[YT Reply Assistant]', chrome.runtime.lastError.message);
          resolve({ error: chrome.runtime.lastError.message });
        } else {
          resolve(res);
        }
      });
    });
  }

  function extractVideoId() {
    // From URL: studio.youtube.com/video/{videoId}/comments
    const urlMatch = window.location.pathname.match(/\/video\/([^/]+)/);
    if (urlMatch) return urlMatch[1];
    return null;
  }

  function extractVideoIdFromComment(commentEl) {
    // Try to find a video link in the comment thread
    const link = querySelector(commentEl, SELECTORS.videoLink);
    if (link) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/\/video\/([^/]+)/);
      if (match) return match[1];
    }
    // Fallback: from current URL
    return extractVideoId();
  }

  function getCommentId(commentEl) {
    // Generate a stable ID from comment text + author
    const text = getCommentText(commentEl);
    const author = getCommentAuthor(commentEl);
    if (!text) return null;
    // Simple hash
    const str = `${author}::${text}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit int
    }
    return `cmt_${Math.abs(hash).toString(36)}`;
  }

  function getCommentText(commentEl) {
    const el = querySelector(commentEl, SELECTORS.commentText);
    return el ? el.textContent.trim() : '';
  }

  function getCommentAuthor(commentEl) {
    const el = querySelector(commentEl, SELECTORS.commentAuthor);
    return el ? el.textContent.trim() : 'A viewer';
  }

  function hasOwnerReply(commentEl) {
    // Check if any reply has the owner badge
    const replySection = querySelector(commentEl, SELECTORS.replySection);
    if (!replySection) return false;

    const badges = querySelectorAll(replySection, SELECTORS.ownerBadge);
    return badges.length > 0;
  }

  // -------------------------------------------------------------------------
  // Suggestion UI
  // -------------------------------------------------------------------------

  function createSuggestionsContainer(commentEl, commentId) {
    // Don't create if already exists
    if (commentEl.querySelector(`.${SUGGESTIONS_CLASS}`)) return null;

    const container = document.createElement('div');
    container.className = SUGGESTIONS_CLASS;
    container.dataset.commentId = commentId;

    // Loading state
    container.innerHTML = `
      <div class="${NAMESPACE}-loading">
        <div class="${NAMESPACE}-skeleton"></div>
        <div class="${NAMESPACE}-skeleton"></div>
        <div class="${NAMESPACE}-skeleton"></div>
      </div>
    `;

    // Insert after comment text, before reply section
    const commentTextEl = querySelector(commentEl, SELECTORS.commentText);
    if (commentTextEl) {
      // Find a good insertion point — after the comment content area
      const insertAfter = commentTextEl.closest('#body') ||
        commentTextEl.closest('#main') ||
        commentTextEl.parentElement;
      if (insertAfter && insertAfter.parentElement) {
        insertAfter.parentElement.insertBefore(container, insertAfter.nextSibling);
      } else {
        commentEl.appendChild(container);
      }
    } else {
      commentEl.appendChild(container);
    }

    return container;
  }

  function renderSuggestions(container, suggestions, providerName, fallback) {
    if (!container) return;

    const commentId = container.dataset.commentId;

    container.innerHTML = '';

    // Chips container
    const chipsWrapper = document.createElement('div');
    chipsWrapper.className = `${NAMESPACE}-chips`;

    suggestions.forEach((text, idx) => {
      if (!text) return;

      const chip = document.createElement('button');
      chip.className = `${NAMESPACE}-chip`;
      chip.title = text; // Full text on hover
      chip.textContent = text.length > 100 ? text.slice(0, 100) + '...' : text;

      chip.addEventListener('click', () => {
        insertReply(container.closest(SELECTORS.commentThread.join(', ')) || container.parentElement, text);
        // Mark as used
        container.classList.add(`${NAMESPACE}-used`);
      });

      chipsWrapper.appendChild(chip);
    });

    container.appendChild(chipsWrapper);

    // Actions row
    const actions = document.createElement('div');
    actions.className = `${NAMESPACE}-actions`;

    // Regenerate button
    const regenBtn = document.createElement('button');
    regenBtn.className = `${NAMESPACE}-action-btn`;
    regenBtn.innerHTML = '&#x21BB;'; // ↻
    regenBtn.title = 'Regenerate suggestions';
    regenBtn.addEventListener('click', () => {
      regenerateSuggestions(container);
    });
    actions.appendChild(regenBtn);

    // Dismiss button
    const dismissBtn = document.createElement('button');
    dismissBtn.className = `${NAMESPACE}-action-btn ${NAMESPACE}-dismiss`;
    dismissBtn.innerHTML = '&#x2715;'; // ✕
    dismissBtn.title = 'Dismiss';
    dismissBtn.addEventListener('click', () => {
      sendMessage({ type: 'DISMISS_COMMENT', commentId });
      container.remove();
    });
    actions.appendChild(dismissBtn);

    // Provider indicator
    if (fallback) {
      const badge = document.createElement('span');
      badge.className = `${NAMESPACE}-fallback-badge`;
      badge.textContent = `fallback: ${providerName}`;
      actions.appendChild(badge);
    }

    container.appendChild(actions);
  }

  function renderError(container, errorMsg) {
    if (!container) return;

    container.innerHTML = `
      <div class="${NAMESPACE}-error">
        <span>${errorMsg || 'Generation failed'}</span>
        <button class="${NAMESPACE}-action-btn" title="Retry">&#x21BB;</button>
      </div>
    `;

    container.querySelector(`.${NAMESPACE}-action-btn`).addEventListener('click', () => {
      regenerateSuggestions(container);
    });
  }

  // -------------------------------------------------------------------------
  // Reply insertion
  // -------------------------------------------------------------------------

  function insertReply(threadEl, text) {
    if (!threadEl) return;

    // Click the reply button first to open the reply field
    const replyBtn = querySelector(threadEl, SELECTORS.replyButton);
    if (replyBtn) {
      replyBtn.click();
    }

    // Wait for the reply input to appear, then insert text
    setTimeout(() => {
      const input = querySelector(threadEl, SELECTORS.replyInput);
      if (input) {
        // For contenteditable divs
        input.focus();
        input.textContent = text;
        // Trigger input event so YouTube Studio picks up the change
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        // Also try setting innerText and dispatching keydown
        // (YouTube Studio may listen for specific events)
        const inputEvent = new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: text,
        });
        input.dispatchEvent(inputEvent);
      }
    }, 300);
  }

  // -------------------------------------------------------------------------
  // Generation orchestration
  // -------------------------------------------------------------------------

  async function generateForComment(commentEl) {
    const commentText = getCommentText(commentEl);
    if (!commentText) return;

    const commentId = getCommentId(commentEl);
    if (!commentId) return;

    // Check if dismissed
    const { dismissed } = await sendMessage({ type: 'IS_DISMISSED', commentId });
    if (dismissed) return;

    // Create UI container
    const container = createSuggestionsContainer(commentEl, commentId);
    if (!container) return; // Already exists

    // Get video context
    const videoId = extractVideoIdFromComment(commentEl) || extractVideoId();
    const commentAuthor = getCommentAuthor(commentEl);

    // Request generation from background
    const result = await sendMessage({
      type: 'GENERATE_SUGGESTIONS',
      commentText,
      commentAuthor,
      videoId,
      videoTitle: '', // Background will get it from transcript
    });

    if (result.error) {
      renderError(container, result.error);
      return;
    }

    renderSuggestions(
      container,
      result.suggestions,
      result.provider,
      result.fallback
    );
  }

  async function regenerateSuggestions(container) {
    const commentEl =
      container.closest(SELECTORS.commentThread.join(', ')) ||
      container.parentElement;
    if (!commentEl) return;

    const commentText = getCommentText(commentEl);
    const commentAuthor = getCommentAuthor(commentEl);
    const videoId = extractVideoIdFromComment(commentEl) || extractVideoId();

    // Show loading
    container.innerHTML = `
      <div class="${NAMESPACE}-loading">
        <div class="${NAMESPACE}-skeleton"></div>
        <div class="${NAMESPACE}-skeleton"></div>
        <div class="${NAMESPACE}-skeleton"></div>
      </div>
    `;

    const result = await sendMessage({
      type: 'GENERATE_SUGGESTIONS',
      commentText,
      commentAuthor,
      videoId,
      videoTitle: '',
    });

    if (result.error) {
      renderError(container, result.error);
      return;
    }

    renderSuggestions(
      container,
      result.suggestions,
      result.provider,
      result.fallback
    );
  }

  // -------------------------------------------------------------------------
  // Reply capture (for continuous learning)
  // -------------------------------------------------------------------------

  function watchForPostedReplies() {
    // Observe the page for newly posted replies
    // When a reply is submitted, capture its text
    document.addEventListener('click', (e) => {
      const btn = e.target.closest(SELECTORS.submitReply.join(', '));
      if (!btn) return;

      // Find the reply input near this button
      const thread = btn.closest(SELECTORS.commentThread.join(', ')) || btn.parentElement?.parentElement;
      if (!thread) return;

      const input = querySelector(thread, SELECTORS.replyInput);
      if (input && input.textContent.trim()) {
        sendMessage({
          type: 'RECORD_REPLY',
          replyText: input.textContent.trim(),
        });

        // Remove suggestions for this comment
        const suggestionsEl = thread.querySelector(`.${SUGGESTIONS_CLASS}`);
        if (suggestionsEl) {
          suggestionsEl.classList.add(`${NAMESPACE}-posted`);
          setTimeout(() => suggestionsEl.remove(), 500);
        }
      }
    }, true);
  }

  // -------------------------------------------------------------------------
  // Comment detection + Intersection Observer (lazy generation)
  // -------------------------------------------------------------------------

  let intersectionObserver = null;
  const pendingGeneration = new Map(); // commentEl → timeout

  function setupIntersectionObserver() {
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const commentEl = entry.target;
          if (entry.isIntersecting) {
            // Debounce: only generate after comment is visible for DEBOUNCE_MS
            if (!pendingGeneration.has(commentEl)) {
              const timeout = setTimeout(() => {
                pendingGeneration.delete(commentEl);
                generateForComment(commentEl);
              }, DEBOUNCE_MS);
              pendingGeneration.set(commentEl, timeout);
            }
          } else {
            // Cancel if scrolled away before debounce fires
            const timeout = pendingGeneration.get(commentEl);
            if (timeout) {
              clearTimeout(timeout);
              pendingGeneration.delete(commentEl);
            }
          }
        }
      },
      { threshold: 0.3 }
    );
  }

  function detectComments(root = document) {
    const threads = querySelectorAll(root, SELECTORS.commentThread);

    for (const thread of threads) {
      // Skip already processed
      if (thread.hasAttribute(PROCESSED_ATTR)) continue;
      thread.setAttribute(PROCESSED_ATTR, 'true');

      // Skip if owner already replied
      if (hasOwnerReply(thread)) continue;

      // Skip if no comment text
      const text = getCommentText(thread);
      if (!text) continue;

      // Observe for viewport entry
      if (intersectionObserver) {
        intersectionObserver.observe(thread);
      }
    }
  }

  // -------------------------------------------------------------------------
  // MutationObserver (watch for dynamically loaded comments)
  // -------------------------------------------------------------------------

  function setupMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          shouldScan = true;
          break;
        }
      }
      if (shouldScan) {
        // Debounce DOM scans
        clearTimeout(setupMutationObserver._timeout);
        setupMutationObserver._timeout = setTimeout(() => {
          detectComments();
        }, 200);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return observer;
  }

  // -------------------------------------------------------------------------
  // Style scraping (for onboarding)
  // -------------------------------------------------------------------------

  async function scrapeExistingReplies() {
    // Find all owner replies on the current page
    const replies = [];
    const allComments = querySelectorAll(document, SELECTORS.comment);

    for (const comment of allComments) {
      // Check if this comment has owner badge
      const badge = querySelector(comment, SELECTORS.ownerBadge);
      if (badge) {
        const text = getCommentText(comment);
        if (text && text.length > 5) {
          replies.push(text);
        }
      }
    }

    return replies;
  }

  // Expose for popup communication
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SCRAPE_REPLIES') {
      scrapeExistingReplies().then(sendResponse);
      return true;
    }
    if (msg.type === 'FORCE_SCAN') {
      detectComments();
      sendResponse({ ok: true });
      return false;
    }
  });

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  async function init() {
    // Check if we're on a comments page
    const isCommentsPage =
      window.location.pathname.includes('/comments') ||
      window.location.pathname.includes('/community');

    if (!isCommentsPage) return;

    // Check onboarding status
    const { onboarded } = await sendMessage({ type: 'GET_ONBOARDING_STATUS' });

    console.log('[YT Reply Assistant] Initialized', {
      onboarded,
      url: window.location.href,
    });

    if (!onboarded) {
      // Don't inject suggestions until onboarding is complete
      // The popup will handle onboarding
      return;
    }

    // Setup observers and start detection
    setupIntersectionObserver();
    setupMutationObserver();
    watchForPostedReplies();

    // Initial scan
    detectComments();

    // Re-scan periodically (catch missed dynamic loads)
    setInterval(() => detectComments(), 5000);
  }

  // Wait for page to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Small delay to let YouTube Studio hydrate its components
    setTimeout(init, 1000);
  }
})();
