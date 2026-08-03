// Find Bar Plus — replaces the browser's Ctrl/Cmd+F with an in-page find bar
// with match-case, whole-word, regex and multi-word (colored) search.
// Highlights use the CSS Custom Highlight API (no DOM mutation).
//
// Runs in every frame. The top frame owns the UI and aggregates counts; child
// frames search their own document and are coordinated through background.js
// (which relays {fbp:1, ...} messages to all frames of the tab).
(() => {
  "use strict";

  const IS_TOP = window.top === window;
  const HOST_ID = "fbp-find-host";
  const PAGE_STYLE_ID = "fbp-page-style";
  const MAX_MATCHES = 5000;
  const MAX_TICKS = 1500;
  const HIST_MAX = 20;
  const DEBOUNCE_MS = 120;
  const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform);
  const TOKEN = IS_TOP
    ? "top"
    : (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
  // Elements whose text should never be searched. SELECT is handled
  // specially in collectTextNodes: a closed dropdown is skipped (its options
  // are invisible) but a listbox (multiple / size>1) renders its options as
  // visible text and IS searched — e.g. NDS webviewer's attribute list.
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TITLE", "HEAD", "META",
    "LINK", "IFRAME", "OBJECT", "EMBED", "AUDIO", "VIDEO", "CANVAS",
    "TEXTAREA", "INPUT",
  ]);
  // Per-term colors (multi-word mode). [0] is also the single-term yellow.
  const TERM_BG = [
    "rgba(255,214,0,.5)", "rgba(84,169,255,.45)", "rgba(87,217,120,.45)",
    "rgba(255,120,190,.45)", "rgba(191,131,255,.45)", "rgba(64,224,208,.45)",
    "rgba(255,170,90,.5)", "rgba(240,98,98,.45)",
  ];
  const TERM_SOLID = [
    "#e0b800", "#3d8fe0", "#3faf5f", "#e06aa8",
    "#9c6fe0", "#2fb5a5", "#e08a3d", "#d05555",
  ];

  // ---- pure matcher (offsets into one big string) ---------------------------
  const escapeLit = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const WORD_RE = /[\p{L}\p{N}_]/u;
  const isWord = (ch) => ch !== undefined && WORD_RE.test(ch);

  function computeMatches(text, query, o, max = MAX_MATCHES) {
    if (!query) return { spans: [], error: false, capped: false };
    let re;
    try {
      re = new RegExp(o.useRegex ? query : escapeLit(query), o.matchCase ? "g" : "gi");
    } catch {
      return { spans: [], error: true, capped: false };
    }
    const spans = [];
    let m;
    while (spans.length < max && (m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; } // never loop on empty matches
      const a = m.index, b = a + m[0].length;
      if (o.wholeWord) {
        // enforce a boundary only where the match edge itself is a word char,
        // so queries like ".NET" still work at their punctuation edges
        const badLeft = isWord(text[a]) && isWord(text[a - 1]);
        const badRight = isWord(text[b - 1]) && isWord(text[b]);
        if (badLeft || badRight) continue;
      }
      spans.push([a, b]);
    }
    return { spans, error: false, capped: spans.length >= max };
  }

  // Multi-word mode: split on whitespace, "double quotes" keep phrases.
  function tokenizeQuery(q) {
    const out = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(q)) !== null) {
      const t = m[1] !== undefined ? m[1] : m[2];
      if (t && !out.includes(t)) out.push(t);
    }
    return out;
  }

  // Search several terms at once. Returns spans [[start, end, termIndex], ...]
  // merged in document order, exact-duplicate spans dropped, capped at `max`.
  function computeMulti(text, terms, o, max = MAX_MATCHES) {
    const all = [];
    let error = false;
    let capped = false;
    terms.forEach((t, ti) => {
      const r = computeMatches(text, t, o, max);
      if (r.error) { error = true; return; }
      if (r.capped) capped = true;
      for (const [a, b] of r.spans) all.push([a, b, ti]);
    });
    const termCounts = new Array(terms.length).fill(0);
    if (error) return { spans: [], error: true, capped: false, termCounts };
    all.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const spans = [];
    for (const s of all) {
      const p = spans[spans.length - 1];
      if (p && p[0] === s[0] && p[1] === s[1]) continue; // same span via another term
      if (spans.length >= max) { capped = true; break; }
      spans.push(s);
    }
    for (const s of spans) termCounts[s[2]]++;
    return { spans, error: false, capped, termCounts };
  }

  // ---- document text index ---------------------------------------------------
  // Concatenates every visible text node (open shadow roots included) into one
  // string, remembering each node's start offset so matches map back to Ranges.
  function collectTextNodes(root, out) {
    // Text-level visibility check. Subtrees are pruned only for display-based
    // invisibility (checkVisibility() default): `visibility` is inheritable
    // but overridable, so a visibility:hidden ancestor may still have
    // visibility:visible descendants — those must stay searchable.
    const textVis = { checkVisibilityCSS: true, visibilityProperty: true };
    // `display:contents` elements generate no box, so checkVisibility() is false
    // for them even though their text IS rendered — look through contents
    // wrappers to the nearest boxed ancestor before calling a text node hidden.
    const isTextVisible = (n) => {
      let p = n.parentElement;
      if (!p || typeof p.checkVisibility !== "function") return true;
      if (p.checkVisibility(textVis)) return true;
      while (p && getComputedStyle(p).display === "contents") p = p.parentElement;
      return !p || typeof p.checkVisibility !== "function" || p.checkVisibility(textVis);
    };
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.data && isTextVisible(node)) out.push(node);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE &&
          node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName.toUpperCase();
        if (SKIP_TAGS.has(tag)) return;
        // closed dropdown: options are not rendered; listbox options are
        if (tag === "SELECT" && !(node.multiple || node.size > 1)) return;
        if (node.id === HOST_ID) return; // never search our own bar
        // Prune only genuinely non-rendered subtrees. `display:contents` has no
        // box (checkVisibility()===false) yet DOES render its children, so it
        // must not prune them.
        if (typeof node.checkVisibility === "function" && !node.checkVisibility() &&
            getComputedStyle(node).display !== "contents") return;
        if (node.shadowRoot) {
          for (let c = node.shadowRoot.firstChild; c; c = c.nextSibling) walk(c);
        }
      }
      for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
    };
    walk(root);
  }

  function buildIndex() {
    const nodes = [];
    collectTextNodes(document.body || document.documentElement, nodes);
    let text = "";
    const spans = [];
    for (const n of nodes) {
      spans.push({ start: text.length, node: n });
      text += n.data;
    }
    return { text, spans };
  }

  function locate(index, off, isEnd = false) {
    const probe = isEnd ? off - 1 : off; // for an end offset, find the span holding the last char
    let lo = 0, hi = index.spans.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (index.spans[mid].start <= probe) lo = mid;
      else hi = mid - 1;
    }
    const s = index.spans[lo];
    return { node: s.node, offset: off - s.start };
  }

  function makeRange(index, a, b) {
    try {
      const start = locate(index, a);
      const end = locate(index, b, true);
      const r = document.createRange();
      r.setStart(start.node, start.offset);
      r.setEnd(end.node, end.offset);
      return r;
    } catch {
      return null;
    }
  }

  // ---- per-frame highlight state ----------------------------------------------
  let matches = [];     // Range[] in THIS frame's document (document order)
  let matchTerms = [];  // parallel: term index of each match
  let current = -1;
  let anchorPoint = null; // {node, offset} — last click position in this frame

  function ensurePageStyle() {
    if (document.getElementById(PAGE_STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = PAGE_STYLE_ID;
    st.textContent =
      TERM_BG.map((c, i) => `::highlight(fbp-t${i}) { background-color: ${c}; }`).join("\n") +
      `\n::highlight(fbp-cur) { background-color: #ff9632; color: #000; }`;
    (document.head || document.documentElement).appendChild(st);
  }

  function paintAll() {
    ensurePageStyle();
    const buckets = new Map();
    matches.forEach((r, i) => {
      const b = (matchTerms[i] || 0) % TERM_BG.length;
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(r);
    });
    for (let b = 0; b < TERM_BG.length; b++) {
      if (buckets.has(b)) {
        const h = new Highlight(...buckets.get(b));
        h.priority = 0;
        CSS.highlights.set("fbp-t" + b, h);
      } else {
        CSS.highlights.delete("fbp-t" + b);
      }
    }
    paintCurrent();
  }

  // ::highlight() cannot paint inside <option> rows — tint the current
  // match's option directly as a fallback (restored when leaving it).
  let tinted = null; // {el, prev}
  function tintCurrentOption() {
    if (tinted) {
      tinted.el.style.backgroundColor = tinted.prev;
      tinted = null;
    }
    const r = matches[current];
    if (!r) return;
    const sc = r.startContainer;
    const el = sc.nodeType === Node.ELEMENT_NODE ? sc : sc.parentElement;
    const opt = el?.closest?.("option");
    if (opt) {
      tinted = { el: opt, prev: opt.style.backgroundColor };
      opt.style.backgroundColor = "#ff9632";
    }
  }

  function paintCurrent() {
    if (current >= 0 && matches[current]) {
      const cur = new Highlight(matches[current]);
      cur.priority = 1; // wins over term highlights where they overlap
      CSS.highlights.set("fbp-cur", cur);
    } else {
      CSS.highlights.delete("fbp-cur");
    }
    tintCurrentOption();
  }

  function clearLocal() {
    matches = [];
    matchTerms = [];
    current = -1;
    for (let b = 0; b < TERM_BG.length; b++) CSS.highlights.delete("fbp-t" + b);
    CSS.highlights.delete("fbp-cur");
    tintCurrentOption(); // current is -1 -> just restores any tinted option
  }

  function scrollToCurrent() {
    const r = matches[current];
    if (!r) return;
    const sc = r.startContainer;
    const el = sc.nodeType === Node.ELEMENT_NODE ? sc : sc.parentElement;
    el?.scrollIntoView?.({ block: "center", inline: "nearest" });
    const rect = r.getBoundingClientRect();
    if (rect && (rect.top < 0 || rect.bottom > innerHeight)) {
      window.scrollBy({ top: rect.top - innerHeight / 2 });
    }
  }

  // Search this frame's document. Returns {count, capped, error, termCounts}.
  function searchLocal(terms, o) {
    if (!terms || !terms.length) {
      clearLocal();
      return { count: 0, capped: false, termCounts: [] };
    }
    const index = buildIndex();
    const res = computeMulti(index.text, terms, o);
    if (res.error) {
      clearLocal();
      return { count: 0, capped: false, error: true, termCounts: [] };
    }
    matches = [];
    matchTerms = [];
    for (const [a, b, ti] of res.spans) {
      const r = makeRange(index, a, b);
      if (r) { matches.push(r); matchTerms.push(ti); }
    }
    current = -1;
    paintAll();
    const termCounts = new Array(terms.length).fill(0);
    for (const ti of matchTerms) termCounts[ti]++;
    return { count: matches.length, capped: res.capped, termCounts };
  }

  function gotoLocal(i) {
    if (!matches.length) return;
    current = Math.max(0, Math.min(i, matches.length - 1));
    paintCurrent();
    scrollToCurrent();
  }

  function unsetCurrent() {
    current = -1;
    paintCurrent();
  }

  // How many of this frame's matches lie entirely BEFORE the last click
  // (= insertion index of the click point into the match list).
  function anchorInsertionIndex() {
    if (!anchorPoint) return 0;
    let k = 0;
    for (const r of matches) {
      try {
        if (r.comparePoint(anchorPoint.node, anchorPoint.offset) === 1) k++;
        else break; // matches are in document order
      } catch {
        break; // different tree (shadow) / removed node — treat rest as after
      }
    }
    return k;
  }

  function caretFromPoint(x, y) {
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      return r ? { node: r.startContainer, offset: r.startOffset } : null;
    }
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    return null;
  }

  // ---- messaging / shortcuts ---------------------------------------------------
  const send = (msg) => {
    try { chrome.runtime.sendMessage({ fbp: 1, ...msg }); } catch { /* ext reloaded */ }
  };
  const isModF = (e) =>
    (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) &&
    !e.altKey && !e.shiftKey && (e.key === "f" || e.key === "F");
  const isModG = (e) =>
    (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) &&
    !e.altKey && (e.key === "g" || e.key === "G");
  const grabSelection = () => {
    const sel = String(window.getSelection?.() ?? "").trim();
    return sel && sel.length <= 200 && !sel.includes("\n") ? sel : "";
  };

  // ---- pure nav math -------------------------------------------------------------
  // ord: [{token, count}] in fixed frame order; cur: {token, local} | null
  function globalPosOf(ord, cur) {
    if (!cur) return -1;
    let g = 0;
    for (const f of ord) {
      if (f.token === cur.token) return g + cur.local;
      g += f.count;
    }
    return -1;
  }

  function stepGlobal(ord, cur, dir) {
    const total = ord.reduce((s, f) => s + f.count, 0);
    if (!total) return null;
    let g = globalPosOf(ord, cur);
    g = g === -1 ? (dir > 0 ? 0 : total - 1) : (((g + dir) % total) + total) % total;
    for (const f of ord) {
      if (g < f.count) return { token: f.token, local: g };
      g -= f.count;
    }
    return null;
  }

  // Anchor navigation: k = insertion index of the click point in frame `token`
  // (k matches of that frame are before the click). dir=+1 -> first match at
  // or after the click; dir=-1 -> last match before it. Wraps around.
  function anchorTarget(ord, token, k, dir) {
    const total = ord.reduce((s, f) => s + f.count, 0);
    if (!total) return null;
    let g = 0;
    let found = false;
    for (const f of ord) {
      if (f.token === token) { g += Math.min(k, f.count); found = true; break; }
      g += f.count;
    }
    if (!found) g = 0; // anchor frame vanished — start from the top
    let t = dir > 0 ? g : g - 1;
    if (t >= total) t = 0;
    if (t < 0) t = total - 1;
    for (const f of ord) {
      if (t < f.count) return { token: f.token, local: t };
      t -= f.count;
    }
    return null;
  }

  // ---- top frame vs child ---------------------------------------------------
  if (IS_TOP) topMain();
  else childMain();

  // ================= CHILD: search agent for this frame =============================
  function childMain() {
    let barOpen = false;
    chrome.runtime.onMessage.addListener((m) => {
      if (!m || m.fbp !== 1) return;
      switch (m.cmd) {
        case "search": {
          barOpen = true;
          const r = searchLocal(m.terms, m.opts);
          send({
            cmd: "result", seq: m.seq, token: TOKEN,
            count: r.count, capped: !!r.capped, termCounts: r.termCounts,
          });
          break;
        }
        case "goto":
          if (m.token === TOKEN) gotoLocal(m.index);
          else unsetCurrent();
          break;
        case "anchorIdx":
          if (m.token === TOKEN) {
            send({ cmd: "anchorIdxResult", token: TOKEN, k: anchorInsertionIndex(), seq: m.seq });
          }
          break;
        case "clear":
          barOpen = false;
          clearLocal();
          break;
      }
    });
    window.addEventListener(
      "keydown",
      (e) => {
        if (isModF(e)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          send({ cmd: "open", sel: grabSelection() });
        } else if (barOpen && (isModG(e) || e.key === "F3")) {
          e.preventDefault();
          e.stopImmediatePropagation();
          send({ cmd: "nav", dir: e.shiftKey ? -1 : 1 });
        }
      },
      true
    );
    // clicks inside this frame become the navigation anchor
    window.addEventListener(
      "mousedown",
      (e) => {
        if (!barOpen) return;
        const pt = caretFromPoint(e.clientX, e.clientY);
        if (!pt) return;
        anchorPoint = pt;
        send({ cmd: "anchor", token: TOKEN });
      },
      true
    );
  }

  // ================= TOP: UI + cross-frame aggregation ==============================
  function topMain() {
    const opts = { matchCase: false, wholeWord: false, useRegex: false, multiWord: false };
    const frames = new Map(); // token -> {frameId, count, capped, termCounts}
    let ui = null;
    let seq = 0;
    let cur = null;           // {token, local} | null
    let curTerms = [];
    let lastSig = null;
    let debounce = null;
    let hist = [];            // search history, most recent first
    let histIdx = -1;         // -1 = not browsing
    let histDraft = "";
    let lastCommitted = null;
    let anchor = null;        // {token} of the frame that owns the last click
    let anchorFresh = false;  // consumed by the first navigate after a click
    let pendingAnchor = null; // {dir, t, seq} — waiting for a child's anchorIdx

    chrome.storage.local.get(
      ["matchCase", "wholeWord", "useRegex", "multiWord", "history"],
      (r) => {
        opts.matchCase = !!r.matchCase;
        opts.wholeWord = !!r.wholeWord;
        opts.useRegex = !!r.useRegex;
        opts.multiWord = !!r.multiWord;
        if (opts.useRegex && opts.multiWord) opts.multiWord = false; // mutually exclusive
        hist = Array.isArray(r.history) ? r.history.slice(0, HIST_MAX) : [];
        if (ui) syncToggles();
      }
    );

    const signature = (q) =>
      JSON.stringify([q, opts.matchCase, opts.wholeWord, opts.useRegex, opts.multiWord]);
    const staleState = () => debounce !== null || lastSig !== signature(ui.input.value);
    const isOpen = () => !!ui && ui.host.style.display !== "none";
    // top first, then children by the frameId background stamped on their results
    const orderedFrames = () =>
      [...frames.entries()]
        .map(([token, f]) => ({ token, ...f }))
        .sort((a, b) => a.frameId - b.frameId);

    chrome.runtime.onMessage.addListener((m) => {
      if (!m || m.fbp !== 1) return;
      switch (m.cmd) {
        case "result": {
          if (m.seq !== seq || !isOpen()) return;
          frames.set(m.token, {
            frameId: m._frameId ?? 1e9,
            count: m.count,
            capped: !!m.capped,
            termCounts: m.termCounts || [],
          });
          // nothing selected yet (top had no matches) -> jump to first child hit
          if (!cur && m.count > 0) {
            cur = { token: m.token, local: 0 };
            applyCurrent();
          }
          updateCounter(curTerms.length > 0);
          break;
        }
        case "open":
          openBar(m.sel);
          break;
        case "nav":
          if (isOpen()) navigate(m.dir);
          break;
        case "anchor":
          anchor = { token: m.token };
          anchorFresh = true;
          break;
        case "anchorIdxResult":
          if (pendingAnchor && m.seq === pendingAnchor.seq) {
            const dir = pendingAnchor.dir;
            pendingAnchor = null;
            finishAnchorNav(m.token, m.k, dir);
          }
          break;
      }
    });

    function runSearch(jumpToFirst) {
      clearTimeout(debounce);
      debounce = null;
      const q = ui.input.value;
      lastSig = signature(q);
      ui.input.classList.remove("bad");
      seq++;
      frames.clear();
      cur = null;
      curTerms = opts.multiWord ? tokenizeQuery(q) : (q ? [q] : []);

      const r = searchLocal(curTerms, opts); // this frame ("top")
      if (r.error) {
        ui.input.classList.add("bad");
        send({ cmd: "search", seq, terms: [], opts }); // clear children too
        clearTicks();
        updateCounter(false);
        return;
      }
      frames.set("top", {
        frameId: 0, count: r.count, capped: !!r.capped, termCounts: r.termCounts,
      });
      send({ cmd: "search", seq, terms: curTerms, opts }); // children report back async
      buildTicks();
      if (!curTerms.length) { updateCounter(false); return; }
      if (jumpToFirst && r.count > 0) {
        cur = { token: "top", local: 0 };
        applyCurrent();
      }
      updateCounter(true);
    }

    function applyCurrent() {
      if (!cur) {
        unsetCurrent();
        send({ cmd: "goto", token: "", index: 0 }); // clears every child's current
      } else if (cur.token === "top") {
        gotoLocal(cur.local);
        send({ cmd: "goto", token: "top", index: 0 }); // children unset theirs
      } else {
        unsetCurrent();
        send({ cmd: "goto", token: cur.token, index: cur.local });
      }
      updateCurTick();
    }

    function navigate(dir) {
      if (staleState()) runSearch(false);
      commitHistory(ui.input.value);
      if (pendingAnchor) {
        if (Date.now() - pendingAnchor.t < 600) return; // child reply on its way
        pendingAnchor = null; // child gone — fall through to normal stepping
      }
      if (anchorFresh && anchor) {
        anchorFresh = false;
        if (anchor.token === "top") {
          finishAnchorNav("top", anchorInsertionIndex(), dir);
        } else {
          pendingAnchor = { dir, t: Date.now(), seq };
          send({ cmd: "anchorIdx", token: anchor.token, seq });
        }
        return;
      }
      const next = stepGlobal(orderedFrames(), cur, dir);
      if (!next) return;
      cur = next;
      applyCurrent();
      updateCounter(true);
    }

    function finishAnchorNav(token, k, dir) {
      const t = anchorTarget(orderedFrames(), token, k, dir);
      if (!t) return;
      cur = t;
      applyCurrent();
      updateCounter(true);
    }

    function updateCounter(hasQuery) {
      const ord = orderedFrames();
      const total = ord.reduce((s, f) => s + f.count, 0);
      const capped = ord.some((f) => f.capped);
      const pos = globalPosOf(ord, cur);
      ui.counter.textContent = hasQuery
        ? `${pos >= 0 ? pos + 1 : 0}/${total}${capped ? "+" : ""}`
        : "";
      ui.counter.classList.toggle("zero", hasQuery && total === 0);
      if (curTerms.length > 1) {
        const sums = new Array(curTerms.length).fill(0);
        for (const f of ord) {
          (f.termCounts || []).forEach((n, i) => { if (i < sums.length) sums[i] += n; });
        }
        ui.counter.title = curTerms.map((t, i) => `${t} — ${sums[i]}`).join("\n");
      } else {
        ui.counter.title = "";
      }
      const off = !hasQuery || total === 0;
      ui.prev.toggleAttribute("disabled", off);
      ui.next.toggleAttribute("disabled", off);
    }

    // ---- search history (input ArrowUp/ArrowDown) ----
    function commitHistory(q) {
      q = q.trim();
      if (!q || q === lastCommitted) return;
      lastCommitted = q;
      hist = [q, ...hist.filter((h) => h !== q)].slice(0, HIST_MAX);
      chrome.storage.local.set({ history: hist });
    }

    function histBrowse(older) { // older: +1 = back in time, -1 = forward
      if (!hist.length) return;
      if (histIdx === -1) {
        if (older < 0) return;
        histDraft = ui.input.value;
        histIdx = 0;
        // first ↑ should reach the previous DIFFERENT search — skip a leading
        // entry equal to what's already shown (the just-committed query)
        while (histIdx < hist.length && hist[histIdx] === histDraft) histIdx++;
        if (histIdx >= hist.length) { histIdx = -1; return; } // nothing else to show
      } else {
        histIdx += older;
      }
      if (histIdx > hist.length - 1) histIdx = hist.length - 1;
      if (histIdx <= -1) {
        histIdx = -1;
        ui.input.value = histDraft;
      } else {
        ui.input.value = hist[histIdx];
      }
      runSearch(true);
    }

    // ---- scrollbar tick marks (top frame's matches only) ----
    function buildTicks() {
      if (!ui) return;
      const rail = ui.rail;
      rail.textContent = "";
      ui.curTick = null;
      if (!matches.length) { rail.style.display = "none"; return; }
      rail.style.display = "block"; // explicit — CSS default is none
      const docH = Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0, 1);
      const step = Math.ceil(matches.length / MAX_TICKS);
      const frag = document.createDocumentFragment();
      for (let i = 0; i < matches.length; i += step) {
        const rect = matches[i].getBoundingClientRect();
        if (!rect || (rect.top === 0 && rect.bottom === 0)) continue; // collapsed
        const t = document.createElement("div");
        t.className = "tick t" + ((matchTerms[i] || 0) % TERM_SOLID.length);
        t.style.top = ((rect.top + window.scrollY) / docH * 100).toFixed(3) + "%";
        t.dataset.i = i;
        frag.append(t);
      }
      const c = document.createElement("div");
      c.className = "tick cur";
      c.style.display = "none";
      frag.append(c);
      ui.curTick = c;
      rail.append(frag);
    }

    function updateCurTick() {
      if (!ui || !ui.curTick) return;
      if (cur && cur.token === "top" && matches[cur.local]) {
        const rect = matches[cur.local].getBoundingClientRect();
        const docH = Math.max(document.documentElement.scrollHeight, 1);
        ui.curTick.style.top = ((rect.top + window.scrollY) / docH * 100).toFixed(3) + "%";
        ui.curTick.style.display = "";
      } else {
        ui.curTick.style.display = "none";
      }
    }

    function clearTicks() {
      if (!ui) return;
      ui.rail.textContent = "";
      ui.rail.style.display = "none";
      ui.curTick = null;
    }

    // ---- UI ----
    const CHEVRON_UP = `<svg viewBox="0 0 16 16"><path d="M4.5 9.75 8 6.25l3.5 3.5"/></svg>`;
    const CHEVRON_DOWN = `<svg viewBox="0 0 16 16"><path d="M4.5 6.25 8 9.75l3.5-3.5"/></svg>`;
    const CROSS = `<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>`;

    function buildUI() {
      const host = document.createElement("div");
      host.id = HOST_ID;
      host.style.cssText =
        "all:initial; position:fixed !important; top:8px; right:16px; z-index:2147483647;";
      const shadow = host.attachShadow({ mode: "open" });
      const tickColors = TERM_SOLID
        .map((c, i) => `.tick.t${i} { background: ${c}; }`).join("\n");
      shadow.innerHTML = `
        <style>
          .bar {
            display: flex; align-items: center; gap: 2px;
            background: #fff; color: #202124;
            border: 1px solid #dadce0; border-radius: 8px;
            box-shadow: 0 4px 16px rgba(0,0,0,.25);
            padding: 5px 8px;
            font: 13px/1.4 -apple-system, "Segoe UI", "PingFang TC", sans-serif;
          }
          .q {
            border: none; outline: none; background: transparent;
            width: 200px; padding: 2px 4px; font: inherit; color: inherit;
          }
          .q.bad { box-shadow: 0 0 0 2px #d93025 inset; border-radius: 4px; }
          .count {
            min-width: 44px; text-align: right; white-space: nowrap;
            color: #5f6368; font-size: 12px; padding: 0 4px;
          }
          .count.zero { color: #d93025; }
          .sep { width: 1px; height: 18px; background: #dadce0; margin: 0 4px; }
          button {
            all: unset; cursor: pointer; border-radius: 4px;
            height: 24px; box-sizing: border-box;
            display: inline-flex; align-items: center; justify-content: center;
            padding: 0 6px; color: #444;
            font: 12px/1 -apple-system, "Segoe UI", "PingFang TC", sans-serif;
          }
          button:hover { background: #f1f3f4; }
          button:active { background: #e8eaed; }
          button.on { background: #d3e3fd; color: #0b57d0; }
          .word { text-decoration: underline dotted; }
          .multi { gap: 2px; }
          .multi .dot { width: 7px; height: 7px; border-radius: 50%; }
          .multi .d0 { background: #e0b800; }
          .multi .d1 { background: #3d8fe0; }
          .nav { width: 24px; padding: 0; color: #5f6368; }
          .nav svg { width: 16px; height: 16px; display: block; }
          .nav path {
            fill: none; stroke: currentColor; stroke-width: 1.6;
            stroke-linecap: round; stroke-linejoin: round;
          }
          .nav[disabled] { opacity: .35; pointer-events: none; }
          .rail {
            position: fixed; top: 0; right: 0; width: 14px; height: 100vh;
            pointer-events: none; display: none;
            background: rgba(128,128,128,.12);
            border-left: 1px solid rgba(0,0,0,.10);
          }
          .tick {
            position: absolute; right: 3px; width: 11px; height: 4px;
            border-radius: 2px; opacity: 1;
            pointer-events: auto; cursor: pointer;
          }
          ${tickColors}
          .tick.cur {
            right: 1px; width: 13px; height: 6px; background: #ff7a00;
            box-shadow: 0 0 3px rgba(0,0,0,.6); pointer-events: none;
          }
        </style>
        <div class="bar" role="search">
          <input class="q" type="text" spellcheck="false" placeholder="尋找" />
          <span class="count"></span>
          <span class="sep"></span>
          <button class="tgl case" title="區分大小寫">Aa</button>
          <button class="tgl word" title="全字拼寫須相符">ab</button>
          <button class="tgl regex" title="使用正規表達式">(.*)</button>
          <button class="tgl multi" title="多詞模式：空格分隔，&quot;引號&quot;保護片語，每詞一色"><span class="dot d0"></span><span class="dot d1"></span></button>
          <span class="sep"></span>
          <button class="nav prev" title="上一個 (Shift+Enter)">${CHEVRON_UP}</button>
          <button class="nav next" title="下一個 (Enter)">${CHEVRON_DOWN}</button>
          <button class="nav close" title="關閉 (Esc)">${CROSS}</button>
        </div>
        <div class="rail"></div>`;

      ui = {
        host,
        input: shadow.querySelector(".q"),
        counter: shadow.querySelector(".count"),
        btnCase: shadow.querySelector(".case"),
        btnWord: shadow.querySelector(".word"),
        btnRegex: shadow.querySelector(".regex"),
        btnMulti: shadow.querySelector(".multi"),
        prev: shadow.querySelector(".prev"),
        next: shadow.querySelector(".next"),
        rail: shadow.querySelector(".rail"),
        curTick: null,
      };

      // Keystrokes typed in the bar must never reach page hotkey handlers
      // (single-key shortcuts on YouTube/Gmail/Teams etc).
      for (const t of ["keydown", "keyup", "keypress"]) {
        shadow.addEventListener(t, (e) => e.stopPropagation());
      }
      // Keep focus in the input when clicking buttons.
      for (const b of shadow.querySelectorAll("button")) {
        b.addEventListener("mousedown", (e) => e.preventDefault());
      }

      ui.input.addEventListener("input", () => {
        histIdx = -1;
        clearTimeout(debounce);
        debounce = setTimeout(() => runSearch(true), DEBOUNCE_MS);
      });
      ui.input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          navigate(e.shiftKey ? -1 : 1);
        } else if (e.key === "Escape") {
          e.preventDefault();
          closeBar();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          histBrowse(e.key === "ArrowUp" ? 1 : -1);
        }
      });

      const setOpts = (patch) => {
        Object.assign(opts, patch);
        chrome.storage.local.set(patch);
        syncToggles();
        runSearch(true);
        ui.input.focus();
      };
      ui.btnCase.addEventListener("click", () => setOpts({ matchCase: !opts.matchCase }));
      ui.btnWord.addEventListener("click", () => setOpts({ wholeWord: !opts.wholeWord }));
      ui.btnRegex.addEventListener("click", () => {
        const p = { useRegex: !opts.useRegex };
        if (p.useRegex) p.multiWord = false; // mutually exclusive
        setOpts(p);
      });
      ui.btnMulti.addEventListener("click", () => {
        const p = { multiWord: !opts.multiWord };
        if (p.multiWord) p.useRegex = false; // mutually exclusive
        setOpts(p);
      });

      ui.prev.addEventListener("click", () => navigate(-1));
      ui.next.addEventListener("click", () => navigate(1));
      shadow.querySelector(".close").addEventListener("click", closeBar);
      ui.rail.addEventListener("click", (e) => {
        const i = e.target?.dataset?.i;
        if (i === undefined) return;
        cur = { token: "top", local: +i };
        anchorFresh = false;
        applyCurrent();
        updateCounter(true);
      });

      syncToggles();
      (document.body || document.documentElement).appendChild(host);
    }

    function syncToggles() {
      if (!ui) return;
      ui.btnCase.classList.toggle("on", opts.matchCase);
      ui.btnWord.classList.toggle("on", opts.wholeWord);
      ui.btnRegex.classList.toggle("on", opts.useRegex);
      ui.btnMulti.classList.toggle("on", opts.multiWord);
      ui.input.placeholder = opts.multiWord ? '多詞：空格分隔，"引號"保護片語' : "尋找";
    }

    function openBar(prefill) {
      if (!ui) buildUI();
      ui.host.style.display = "";
      const sel = prefill || grabSelection();
      if (sel) ui.input.value = sel;
      ui.input.focus();
      ui.input.select();
      histIdx = -1;
      if (ui.input.value) runSearch(true);
    }

    function closeBar() {
      if (!ui) return;
      commitHistory(ui.input.value);
      ui.host.style.display = "none";
      frames.clear();
      cur = null;
      lastSig = null;
      anchor = null;
      anchorFresh = false;
      pendingAnchor = null;
      histIdx = -1;
      clearLocal();
      clearTicks();
      send({ cmd: "clear" }); // children clear their highlights too
    }

    window.addEventListener(
      "keydown",
      (e) => {
        if (isModF(e)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          openBar();
          return;
        }
        if (!isOpen()) return;
        if (isModG(e) || e.key === "F3") {
          e.preventDefault();
          e.stopImmediatePropagation();
          navigate(e.shiftKey ? -1 : 1);
        }
      },
      true
    );

    // clicks in the top page become the navigation anchor
    window.addEventListener(
      "mousedown",
      (e) => {
        if (!isOpen()) return;
        if (e.target === ui.host || ui.host.contains(e.target)) return; // our bar/ticks
        const pt = caretFromPoint(e.clientX, e.clientY);
        if (!pt) return;
        anchorPoint = pt;
        anchor = { token: "top" };
        anchorFresh = true;
      },
      true
    );

    // keep tick positions roughly right when the window resizes
    let resizeT = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => {
        if (isOpen() && matches.length) { buildTicks(); updateCurTick(); }
      }, 200);
    });
  }
})();
