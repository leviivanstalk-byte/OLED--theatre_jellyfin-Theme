/**
 * Abyss Cinematic Edition — abyss.js  (v2)
 *
 * Fixes vs v1:
 *  - Colour extraction: ignores very dark pixels (brightness < 40) AND
 *    near-grey pixels; weighted by saturation so vivid colours win
 *  - Genre detection: checks ALL genre chips, not just the first
 *  - SPA navigation: listens to hashchange + popstate as well as
 *    MutationObserver for Jellyfin's single-page architecture
 *  - Poster idle float: applied by JS via animationend so it never
 *    conflicts with the entrance animation's transform
 *  - Mouse-tracking 3D tilt: sets --card-rx/--card-ry per card so
 *    CSS perspective rotateY(var(--card-ry)) rotateX(var(--card-rx))
 *    tracks the real cursor position within the card bounds
 *  - LocalStorage: effect toggles persist across page reloads
 *  - No hardcoded timing: reads --abyss-dur-cinematic from computed style
 *  - Ambient colour: smoothly lerped every RAF tick with proper cleanup
 */

(function AbyssCinematic() {
  'use strict';

  /* ──────────────────────────────────────────────────────────────────
   * 0. Config
   * ────────────────────────────────────────────────────────────────── */
  const DEFAULTS = {
    grain:      true,
    bloom:      true,
    letterbox:  false,
    vignette:   true,
  };

  const GENRE_COLORS = {
    'sci-fi':           [37,  99,  235],
    'science fiction':  [37,  99,  235],
    'horror':           [220, 20,   60],
    'thriller':         [180, 20,   40],
    'animation':        [124, 58,  237],
    'anime':            [167, 100, 237],
    'comedy':           [234, 179,   8],
    'romance':          [219, 39,  119],
    'documentary':      [16,  185, 129],
    'nature':           [5,   150, 105],
    'action':           [239, 68,   68],
    'war':              [107, 114, 128],
    'fantasy':          [139, 92,  246],
    'history':          [180, 130,  60],
    'music':            [236, 72,  153],
    'sport':            [234, 88,   12],
    'sports':           [234, 88,   12],
    'mystery':          [91,  33,  182],
    'crime':            [155, 28,   40],
    'western':          [161, 98,   7],
    'family':           [16,  185, 129],
    'kids':             [16,  185, 129],
  };

  const DEFAULT_AMBIENT = [124, 58, 237];

  /* ──────────────────────────────────────────────────────────────────
   * 1. Capability flags
   * ────────────────────────────────────────────────────────────────── */
  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ──────────────────────────────────────────────────────────────────
   * 2. LocalStorage — persist effect preferences
   * ────────────────────────────────────────────────────────────────── */
  const STORAGE_KEY = 'abyss-cinematic-prefs';

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
    } catch (_) {
      return { ...DEFAULTS };
    }
  }

  function savePrefs(prefs) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch (_) {}
  }

  const prefs = loadPrefs();

  /* ──────────────────────────────────────────────────────────────────
   * 3. @property registration — enables CSS variable transitions
   * ────────────────────────────────────────────────────────────────── */
  function registerCSSProperties() {
    if (!window.CSS?.registerProperty) return;
    [
      { name: '--abyss-ambient-primary',   initial: 'rgba(124,58,237,0.22)' },
      { name: '--abyss-ambient-secondary', initial: 'rgba(37,99,235,0.14)' },
      { name: '--abyss-ambient-accent',    initial: 'rgba(219,39,119,0.18)' },
    ].forEach(({ name, initial }) => {
      try {
        CSS.registerProperty({ name, syntax: '<color>', initialValue: initial, inherits: true });
      } catch (_) { /* already registered */ }
    });
  }

  /* ──────────────────────────────────────────────────────────────────
   * 4. Read --abyss-dur-cinematic from computed CSS (no hardcoding)
   * ────────────────────────────────────────────────────────────────── */
  function getCinematicDuration() {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--abyss-dur-cinematic').trim();
    return parseFloat(raw) || 720;
  }

  /* ──────────────────────────────────────────────────────────────────
   * 5. Apply effect classes from persisted prefs
   * ────────────────────────────────────────────────────────────────── */
  function applyEffects() {
    const body = document.body;
    body.classList.toggle('abyss-grain',    prefs.grain);
    body.classList.toggle('abyss-bloom',    prefs.bloom);
    body.classList.toggle('abyss-letterbox', prefs.letterbox);
    body.classList.toggle('abyss-vignette', prefs.vignette);
  }

  /* ──────────────────────────────────────────────────────────────────
   * 6. Colour extraction — weighted by saturation, ignores dark + grey
   *
   * Samples the poster / backdrop at 10×10 resolution. Each pixel is
   * scored by its HSL saturation; dark pixels (L < 0.16) and
   * near-grey pixels (S < 0.18) are skipped. The remaining pixels
   * are averaged weighted by saturation, so vivid colours dominate.
   * ────────────────────────────────────────────────────────────────── */
  let _canvas = null;
  let _ctx    = null;

  function getExtractionCtx() {
    if (!_canvas) {
      _canvas = document.createElement('canvas');
      _canvas.width = _canvas.height = 10;
      _ctx = _canvas.getContext('2d', { willReadFrequently: true });
    }
    return _ctx;
  }

  /** Convert RGB [0–255] to HSL [h: 0–360, s: 0–1, l: 0–1] */
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return { h: h * 360, s, l };
  }

  function extractColour(imgEl) {
    return new Promise((resolve) => {
      try {
        const ctx = getExtractionCtx();
        ctx.drawImage(imgEl, 0, 0, 10, 10);
        const { data } = ctx.getImageData(0, 0, 10, 10);

        let rAcc = 0, gAcc = 0, bAcc = 0, wAcc = 0;

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const { s, l } = rgbToHsl(r, g, b);

          // Skip very dark (letterbox bars, hair) and near-grey pixels
          if (l < 0.16 || l > 0.92 || s < 0.18) continue;

          // Weight by saturation — vivid pixels dominate the average
          const w = s;
          rAcc += r * w;
          gAcc += g * w;
          bAcc += b * w;
          wAcc += w;
        }

        if (wAcc < 0.5) { resolve(DEFAULT_AMBIENT); return; }

        // Clamp to a useful brightness range for the ambient glow
        const raw = [rAcc / wAcc, gAcc / wAcc, bAcc / wAcc];
        const peak = Math.max(...raw) || 1;
        const scale = Math.min(200, (255 * 0.55)) / peak;
        resolve(raw.map(c => Math.round(c * scale)));
      } catch (_) {
        resolve(DEFAULT_AMBIENT);
      }
    });
  }

  /* ──────────────────────────────────────────────────────────────────
   * 7. Ambient colour animator — RAF-based lerp with cleanup
   * ────────────────────────────────────────────────────────────────── */
  let _current = [...DEFAULT_AMBIENT];
  let _target  = [...DEFAULT_AMBIENT];
  let _rafId   = null;

  function setAmbientCSS([r, g, b]) {
    const root = document.documentElement;
    root.style.setProperty('--abyss-ambient-primary',   `rgba(${r},${g},${b},0.22)`);
    root.style.setProperty('--abyss-ambient-secondary', `rgba(${r},${g},${b},0.14)`);
    root.style.setProperty('--abyss-ambient-accent',    `rgba(${r},${g},${b},0.18)`);
  }

  function lerpAmbient() {
    const T = 0.055;
    _current = _current.map((c, i) => {
      const next = c + (_target[i] - c) * T;
      return Math.round(next);
    });
    setAmbientCSS(_current);
    const dist = _current.reduce((d, c, i) => d + Math.abs(c - _target[i]), 0);
    _rafId = dist > 2 ? requestAnimationFrame(lerpAmbient) : null;
  }

  function setAmbient(rgb) {
    _target = rgb;
    if (REDUCED_MOTION) {
      _current = [...rgb];
      setAmbientCSS(rgb);
      return;
    }
    if (!_rafId) _rafId = requestAnimationFrame(lerpAmbient);
  }

  /* ──────────────────────────────────────────────────────────────────
   * 8. Genre detection — checks ALL genre chips on the page
   * ────────────────────────────────────────────────────────────────── */
  function getGenreColour() {
    const chips = document.querySelectorAll(
      '.itemDetailPage .genreItem, .itemDetailPage .tagItem, ' +
      '.itemDetailPage .itemLink[href*="Genre"], .itemDetailPage .genreLink'
    );
    for (const chip of chips) {
      const text = chip.textContent.toLowerCase().trim();
      for (const [keyword, rgb] of Object.entries(GENRE_COLORS)) {
        if (text.includes(keyword)) return rgb;
      }
    }
    return null;
  }

  /* ──────────────────────────────────────────────────────────────────
   * 9. Ambient update — genre → poster → backdrop fallback chain
   * ────────────────────────────────────────────────────────────────── */
  function updateAmbient() {
    // 1. Genre wins (most intentional signal)
    const genreColour = getGenreColour();
    if (genreColour) { setAmbient(genreColour); return; }

    // 2. Poster image
    const poster = document.querySelector(
      '.itemDetailPage .primaryImageContainer img, ' +
      '.detailImageContainer img, ' +
      '.itemDetailPage .detailImage'
    );
    if (poster) {
      if (poster.complete && poster.naturalWidth > 0) {
        extractColour(poster).then(setAmbient);
      } else {
        poster.addEventListener('load', () => extractColour(poster).then(setAmbient), { once: true });
      }
      return;
    }

    // 3. Backdrop fallback
    const backdrop = document.querySelector('.backdropImage, .itemBackdropImage');
    if (backdrop?.complete && backdrop.naturalWidth > 0) {
      extractColour(backdrop).then(setAmbient);
    } else if (backdrop) {
      backdrop.addEventListener('load', () => extractColour(backdrop).then(setAmbient), { once: true });
    }
  }

  /* ──────────────────────────────────────────────────────────────────
   * 10. Poster idle float — applied after entrance animation ends
   *
   * Both animations use `transform`. CSS spec: last listed wins.
   * We avoid listing them together and instead wait for animationend,
   * then add `.abyss-poster-resting` which triggers the idle loop
   * in hero.css using a separate, non-conflicting keyframe.
   * ────────────────────────────────────────────────────────────────── */
  function setupPosterIdle() {
    const poster = document.querySelector(
      '.itemDetailPage .primaryImageContainer img, ' +
      '.detailImageContainer img, ' +
      '.itemDetailPage .detailImage'
    );
    if (!poster || REDUCED_MOTION) return;
    poster.classList.remove('abyss-poster-resting');
    poster.addEventListener('animationend', (e) => {
      if (e.animationName === 'abyss-poster-float-in') {
        poster.classList.add('abyss-poster-resting');
      }
    }, { once: true });
  }

  /* ──────────────────────────────────────────────────────────────────
   * 11. Ambient glow element injection
   * ────────────────────────────────────────────────────────────────── */
  function injectAmbientGlow() {
    document.querySelectorAll(
      '.itemDetailPage .primaryImageContainer, .itemDetailPage .detailImageContainer'
    ).forEach((container) => {
      if (container.querySelector('.abyss-ambient-glow')) return;
      const glow = document.createElement('div');
      glow.className = 'abyss-ambient-glow';
      Object.assign(container.style, { position: 'relative' });
      container.appendChild(glow);
    });
  }

  /* ──────────────────────────────────────────────────────────────────
   * 12. Mouse-tracking 3D card tilt
   *
   * On mousemove over a card, we compute the cursor's offset from the
   * card centre (normalised to ±1) and map it to ±MAX_TILT degrees.
   * We write --card-rx and --card-ry on the element so the CSS rule
   * `rotateY(var(--card-ry)) rotateX(var(--card-rx))` applies it.
   * On mouseleave we reset to 0deg with a short transition.
   * ────────────────────────────────────────────────────────────────── */
  const MAX_TILT = 5;   // degrees — keep subtle

  function onCardMouseMove(e) {
    if (REDUCED_MOTION) return;
    const card = e.currentTarget;
    const rect = card.getBoundingClientRect();
    const cx = rect.left + rect.width  / 2;
    const cy = rect.top  + rect.height / 2;
    const dx = (e.clientX - cx) / (rect.width  / 2);   // –1 … +1
    const dy = (e.clientY - cy) / (rect.height / 2);   // –1 … +1
    const ry = (dx * MAX_TILT).toFixed(2) + 'deg';
    const rx = (-dy * MAX_TILT * 0.5).toFixed(2) + 'deg'; // gentler on X
    card.style.setProperty('--card-ry', ry);
    card.style.setProperty('--card-rx', rx);
  }

  function onCardMouseLeave(e) {
    const card = e.currentTarget;
    card.style.setProperty('--card-ry', '0deg');
    card.style.setProperty('--card-rx', '0deg');
  }

  function attachCardTilt(card) {
    if (card.dataset.abyssTilt) return;
    card.dataset.abyssTilt = '1';
    card.addEventListener('mousemove',  onCardMouseMove,  { passive: true });
    card.addEventListener('mouseleave', onCardMouseLeave, { passive: true });
  }

  function setupCardTilt() {
    document.querySelectorAll('.card:not([data-abyss-tilt])').forEach(attachCardTilt);
  }

  /* ──────────────────────────────────────────────────────────────────
   * 13. Scroll-reveal IntersectionObserver
   * ────────────────────────────────────────────────────────────────── */
  let _revealObserver = null;

  function setupScrollReveal() {
    if (REDUCED_MOTION || !window.IntersectionObserver) return;
    _revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          _revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.10, rootMargin: '0px 0px -30px 0px' });

    observeRevealTargets();
  }

  function observeRevealTargets() {
    if (!_revealObserver) return;
    document.querySelectorAll(
      '.verticalSection:not(.is-visible), .homeSection:not(.is-visible), .abyss-reveal:not(.is-visible)'
    ).forEach((el) => _revealObserver.observe(el));
  }

  /* ──────────────────────────────────────────────────────────────────
   * 14. Scroll-aware header (adds .scrolled class)
   * ────────────────────────────────────────────────────────────────── */
  function setupHeaderScroll() {
    const header = document.querySelector('.skinHeader, .appHeader');
    if (!header) return;
    let ticking = false;
    const update = () => {
      header.classList.toggle('scrolled', window.scrollY > 55);
      ticking = false;
    };
    window.addEventListener('scroll', () => {
      if (!ticking) { requestAnimationFrame(update); ticking = true; }
    }, { passive: true });
  }

  /* ──────────────────────────────────────────────────────────────────
   * 15. Theatre mode — video element watcher
   * ────────────────────────────────────────────────────────────────── */
  let _osdHideTimer = null;

  function setupTheatreMode() {
    new MutationObserver(() => {
      const video = document.querySelector('video');
      const body  = document.body;
      if (video && !video._abyssHandled) {
        video._abyssHandled = true;
        body.classList.add('theatre-mode', 'is-playing');
        video.addEventListener('play',  () => {
          body.classList.add('is-playing');
          body.classList.remove('osd-visible');
        });
        video.addEventListener('pause', () => {
          body.classList.remove('is-playing');
          body.classList.add('osd-visible');
        });
        video.addEventListener('ended', () => {
          body.classList.remove('theatre-mode', 'is-playing', 'osd-visible');
        });
      } else if (!video) {
        body.classList.remove('theatre-mode', 'is-playing', 'osd-visible');
      }
    }).observe(document.body, { childList: true, subtree: true });

    // Mouse movement shows OSD, auto-hides after 3 s
    document.addEventListener('mousemove', () => {
      if (!document.body.classList.contains('theatre-mode')) return;
      document.body.classList.add('osd-visible');
      clearTimeout(_osdHideTimer);
      _osdHideTimer = setTimeout(() => {
        document.body.classList.remove('osd-visible');
      }, 3000);
    }, { passive: true });
  }

  /* ──────────────────────────────────────────────────────────────────
   * 16. Page-change detection — covers Jellyfin's SPA patterns
   *
   * Jellyfin uses hash-based routing AND History API pushState.
   * We observe both plus a MutationObserver on .mainAnimatedPages
   * so whichever fires first triggers the page-init routine.
   * ────────────────────────────────────────────────────────────────── */
  let _pageInitTimer = null;

  function onPageChange() {
    // Debounce — multiple signals may fire together
    clearTimeout(_pageInitTimer);
    _pageInitTimer = setTimeout(() => {
      injectAmbientGlow();
      updateAmbient();
      observeRevealTargets();
      setupCardTilt();
      setupPosterIdle();
    }, 250);
  }

  function setupPageObserver() {
    // 1. Hash / History API navigation
    window.addEventListener('hashchange',  onPageChange, { passive: true });
    window.addEventListener('popstate',    onPageChange, { passive: true });

    // 2. Jellyfin fires custom events on route change
    document.addEventListener('pageshow',       onPageChange);
    document.addEventListener('viewshow',       onPageChange);
    document.addEventListener('pagebeforeshow', onPageChange);

    // 3. MutationObserver as final net
    const host = document.querySelector('.mainAnimatedPages') || document.body;
    new MutationObserver(onPageChange).observe(host, { childList: true, subtree: false });

    // 4. New cards added dynamically (infinite scroll / lazy sections)
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList?.contains('card')) { attachCardTilt(node); }
          node.querySelectorAll?.('.card:not([data-abyss-tilt])').forEach(attachCardTilt);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  /* ──────────────────────────────────────────────────────────────────
   * 17. Keyboard shortcuts — toggle effects and persist preference
   * ────────────────────────────────────────────────────────────────── */
  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (!e.shiftKey) return;

      let changed = false;
      if (e.key === 'G') {
        prefs.grain    = !prefs.grain;    changed = true;
        document.body.classList.toggle('abyss-grain',    prefs.grain);
      }
      if (e.key === 'B') {
        prefs.bloom    = !prefs.bloom;    changed = true;
        document.body.classList.toggle('abyss-bloom',    prefs.bloom);
      }
      if (e.key === 'L') {
        prefs.letterbox = !prefs.letterbox; changed = true;
        document.body.classList.toggle('abyss-letterbox', prefs.letterbox);
      }
      if (e.key === 'V') {
        prefs.vignette = !prefs.vignette; changed = true;
        document.body.classList.toggle('abyss-vignette', prefs.vignette);
      }

      if (changed) {
        savePrefs(prefs);
        showToast(`Abyss: ${Object.entries(prefs).filter(([,v])=>v).map(([k])=>k).join(', ') || 'all effects off'}`);
      }
    });
  }

  /* ──────────────────────────────────────────────────────────────────
   * 18. Lightweight toast — shows current effect state on shortcut use
   * ────────────────────────────────────────────────────────────────── */
  let _toastEl = null;
  let _toastTimer = null;

  function showToast(msg) {
    if (!_toastEl) {
      _toastEl = document.createElement('div');
      _toastEl.style.cssText = [
        'position:fixed', 'bottom:24px', 'right:24px',
        'padding:10px 16px', 'border-radius:10px',
        'background:rgba(10,10,20,0.92)',
        'border:1px solid rgba(124,58,237,0.35)',
        'border-left:3px solid #9333ea',
        'color:rgba(255,255,255,0.90)',
        'font:600 13px/1.4 Inter,sans-serif',
        'letter-spacing:0.01em',
        'backdrop-filter:blur(20px)',
        '-webkit-backdrop-filter:blur(20px)',
        'box-shadow:0 8px 32px rgba(0,0,0,0.60)',
        `z-index:${10000}`,
        'transition:opacity 0.2s ease',
        'pointer-events:none',
      ].join(';');
      document.body.appendChild(_toastEl);
    }
    _toastEl.textContent = msg;
    _toastEl.style.opacity = '1';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { _toastEl.style.opacity = '0'; }, 2400);
  }

  /* ──────────────────────────────────────────────────────────────────
   * 19. Boot
   * ────────────────────────────────────────────────────────────────── */
  function boot() {
    registerCSSProperties();
    applyEffects();
    setupScrollReveal();
    setupCardTilt();
    setupHeaderScroll();
    setupTheatreMode();
    setupPageObserver();
    setupKeyboardShortcuts();

    // Initial page run after DOM settles
    setTimeout(() => {
      injectAmbientGlow();
      updateAmbient();
      setupPosterIdle();
    }, 350);

    console.info(
      '%c✦ Abyss Cinematic%c v2 — cinema engine running\n' +
      'Shortcuts: Shift+G (grain) Shift+B (bloom) Shift+L (letterbox) Shift+V (vignette)',
      'color:#9333ea;font-weight:700',
      'color:#a78bfa;font-weight:400'
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();
