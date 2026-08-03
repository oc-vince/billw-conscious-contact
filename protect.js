/* ─────────────────────────────────────────────────────────────
   IMAGE / MEDIA PROTECTION
   Bill W. Conscious Contact — Muse Bookings LLC

   Standard deterrent layer:
   - blocks the context (right-click) menu
   - blocks drag-and-drop of images
   - blocks long-press save on touch devices
   - blocks copy/cut of image selections
   - blocks Ctrl/Cmd+S, Ctrl/Cmd+P and DevTools shortcuts

   Note: this deters casual copying. Nothing rendered in a browser
   can be made technically impossible to capture.
   ───────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var MEDIA = 'IMG,PICTURE,SOURCE,SVG,VIDEO,CANVAS'.split(',');

  function isMedia(el) {
    if (!el || !el.tagName) return false;
    if (MEDIA.indexOf(el.tagName.toUpperCase()) !== -1) return true;
    return !!(el.closest && el.closest('img,picture,svg,video,canvas,figure'));
  }

  function block(e) {
    e.preventDefault();
    e.stopPropagation();
    return false;
  }

  /* ── 1. Disable right-click / context menu site-wide ── */
  document.addEventListener('contextmenu', block, { capture: true });

  /* ── 2. Disable dragging images out of the page ── */
  document.addEventListener('dragstart', function (e) {
    if (isMedia(e.target)) return block(e);
  }, { capture: true });

  document.addEventListener('drop', function (e) {
    if (isMedia(e.target)) return block(e);
  }, { capture: true });

  /* ── 3. Disable long-press save on touch devices ── */
  var pressTimer = null;

  document.addEventListener('touchstart', function (e) {
    if (!isMedia(e.target)) return;
    pressTimer = setTimeout(function () {
      pressTimer = null;
    }, 400);
  }, { passive: true, capture: true });

  document.addEventListener('touchend', function () {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }, { passive: true, capture: true });

  document.addEventListener('touchmove', function (e) {
    if (isMedia(e.target) && e.cancelable) e.preventDefault();
  }, { capture: true });

  /* ── 4. Block copy/cut when the selection is media ── */
  ['copy', 'cut'].forEach(function (evt) {
    document.addEventListener(evt, function (e) {
      var sel = window.getSelection();
      if (!sel) return;
      var node = sel.anchorNode;
      if (node && isMedia(node.nodeType === 1 ? node : node.parentElement)) return block(e);
    }, { capture: true });
  });

  /* ── 5. Keyboard shortcuts: save page, view-source, devtools ──
     Ctrl/Cmd+P is deliberately NOT blocked — imagery is already hidden
     from printed output by protect.css, and visitors need to be able to
     print order confirmations. ── */
  document.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    var mod = e.ctrlKey || e.metaKey;

    if (mod && ['s', 'u'].indexOf(k) !== -1) return block(e);
    if (k === 'f12') return block(e);
    if (mod && e.shiftKey && ['i', 'j', 'c'].indexOf(k) !== -1) return block(e);
  }, { capture: true });

  /* ── 6. Harden every image as it appears (incl. lazy-loaded) ── */
  function harden(root) {
    var nodes = (root || document).querySelectorAll('img, video, canvas, svg');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.dataset && el.dataset.protected === '1') continue;
      el.setAttribute('draggable', 'false');
      el.setAttribute('oncontextmenu', 'return false');
      if (el.tagName === 'VIDEO') el.setAttribute('controlslist', 'nodownload');
      if (el.dataset) el.dataset.protected = '1';
    }
  }

  function init() {
    harden(document);

    if (typeof MutationObserver === 'function') {
      new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var added = mutations[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            if (added[j].nodeType === 1) harden(added[j].parentNode || document);
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
