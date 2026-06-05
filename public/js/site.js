/* ────────────────────────────────────────────────────────────
   Shared helpers for every page of the Maintain File-Store KB
   console. Exposes a global `MT` namespace.
   ──────────────────────────────────────────────────────────── */
(function (global) {
  "use strict";

  var KEYS = {
    kbKey: "mt_kbKey",
    geminiKey: "mt_geminiKey",
    anthropicKey: "mt_anthropicKey",
    activeStore: "mt_activeStore",
    activeDisplay: "mt_activeDisplay",
  };

  function $(id) { return document.getElementById(id); }

  function getKbKey()        { return localStorage.getItem(KEYS.kbKey)        || ""; }
  function getGeminiKey()    { return localStorage.getItem(KEYS.geminiKey)    || ""; }
  function getAnthropicKey() { return localStorage.getItem(KEYS.anthropicKey) || ""; }
  function setKeys(kb, gem, ant) {
    if (kb  != null) localStorage.setItem(KEYS.kbKey, kb);
    if (gem != null) localStorage.setItem(KEYS.geminiKey, gem);
    if (ant != null) localStorage.setItem(KEYS.anthropicKey, ant);
  }

  function getActiveStore() {
    return {
      name: localStorage.getItem(KEYS.activeStore) || "",
      display: localStorage.getItem(KEYS.activeDisplay) || "",
    };
  }
  function setActiveStore(name, display) {
    localStorage.setItem(KEYS.activeStore, name || "");
    localStorage.setItem(KEYS.activeDisplay, display || "");
  }

  function storeId(name) {
    if (!name) return "";
    return name.indexOf("/") >= 0 ? name.split("/").pop() : name;
  }

  function headers() {
    var h = {};
    var kb  = getKbKey();
    var gem = getGeminiKey();
    var ant = getAnthropicKey();
    if (kb)  h["x-api-key"] = kb;
    if (gem) h["x-gemini-key"] = gem;
    if (ant) h["x-anthropic-key"] = ant;
    return h;
  }

  async function api(method, path, opts) {
    opts = opts || {};
    var h = headers();
    var body;
    if (opts.form) {
      body = opts.form;
    } else if (opts.json !== undefined) {
      h["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    }
    var res = await fetch(path, { method: method, headers: h, body: body });
    var text = await res.text();
    var data;
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
    if (!res.ok) {
      var m = data && (data.message || data.error);
      if (Array.isArray(m)) m = m.join("; ");
      var err = new Error(m || (res.status + " " + res.statusText));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function busy(btn, fn) {
    if (!btn) return fn();
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "working…";
    try {
      return await fn();
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  /* ── Highlight the active nav link based on current pathname. */
  function paintNav() {
    var here = (location.pathname || "/").replace(/\/+$/, "") || "/";
    document.querySelectorAll(".page-nav a").forEach(function (a) {
      var href = a.getAttribute("href") || "";
      var clean = href.replace(/\/+$/, "") || "/";
      a.classList.toggle("active", clean === here);
    });
  }

  function navHtml() {
    return (
      '<nav class="page-nav" aria-label="Primary">' +
        '<a href="/">Home</a>' +
        '<a href="/console">Console <span class="arrow">→</span></a>' +
        '<a href="/documents">Documents</a>' +
        '<a href="/configure">Configure</a>' +
        '<a href="/api">Swagger</a>' +
        '<a href="/health">Health</a>' +
      '</nav>'
    );
  }

  function footerHtml() {
    return (
      '<div class="cta-bar">Maintain Technology · File Store KB · maintain.com.au</div>' +
      '<footer class="page-footer">' +
        '<span>Maintain Technology · 2026</span>' +
        '<nav>' +
          '<a href="/">Home</a>' +
          '<a href="/console">Console</a>' +
          '<a href="/documents">Documents</a>' +
          '<a href="/configure">Configure</a>' +
          '<a href="/api">Swagger</a>' +
          '<a href="/health">Health</a>' +
        '</nav>' +
      '</footer>'
    );
  }

  function mountChrome() {
    var navMount = $("nav-mount");
    if (navMount) navMount.innerHTML = navHtml();
    var footerMount = $("footer-mount");
    if (footerMount) footerMount.innerHTML = footerHtml();
    paintNav();
  }

  /* ── Activity log (writes to #log if present). */
  function log(msg, kind) {
    var el = $("log");
    if (!el) {
      log._buf = log._buf || [];
      log._buf.push([msg, kind]);
      return;
    }
    if (log._buf && log._buf.length) {
      log._buf.forEach(function (e) { log(e[0], e[1]); });
      log._buf = [];
    }
    var stamp = new Date().toLocaleTimeString();
    var prefix = kind === "err" ? "[error] " : kind === "ok" ? "[ok] " : "";
    el.textContent += "\n" + stamp + "  " + prefix + msg;
    el.scrollTop = el.scrollHeight;
  }

  /* ── Minimal Markdown renderer for LLM answers.
   * Escapes HTML first, then transforms a useful subset of Markdown.
   * Placeholders __MT_CB_N__ / __MT_IC_N__ chosen so common clinical /
   * pharmacology terms (IC50, CB1) never collide. */
  function renderMarkdown(text) {
    if (!text) return "";
    var src = escapeHtml(String(text));

    var blocks = [];
    src = src.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, function (_, code) {
      blocks.push('<pre class="ab-code"><code>' + code.replace(/^\n|\n$/g, "") + '</code></pre>');
      return "__MT_CB_" + (blocks.length - 1) + "__";
    });

    var lines = src.split("\n");
    var out = [];
    var i = 0;
    function blank(l) { return /^\s*$/.test(l); }
    function head(l)  { return /^#{1,6}\s+/.test(l); }
    function ulist(l) { return /^\s*[*-]\s+/.test(l); }
    function olist(l) { return /^\s*\d+\.\s+/.test(l); }
    function quote(l) { return /^\s*>\s?/.test(l); }
    function hrule(l) { return /^\s*(?:---+|\*\*\*+)\s*$/.test(l); }

    function gatherListItem(stripRe) {
      var item = lines[i].replace(stripRe, "");
      i++;
      while (i < lines.length &&
             !blank(lines[i]) && !ulist(lines[i]) && !olist(lines[i]) &&
             !head(lines[i]) && !quote(lines[i]) && !hrule(lines[i])) {
        item += " " + lines[i].trim();
        i++;
      }
      return item;
    }

    while (i < lines.length) {
      var line = lines[i];
      if (blank(line)) { i++; continue; }
      if (hrule(line)) { out.push('<hr class="ab-hr">'); i++; continue; }
      if (head(line)) {
        var m = line.match(/^(#{1,6})\s+(.*)$/);
        out.push('<div class="ab-h ab-h-' + m[1].length + '">' + inline(m[2]) + '</div>');
        i++; continue;
      }
      if (quote(line)) {
        var bq = [];
        while (i < lines.length && quote(lines[i])) {
          bq.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        out.push('<blockquote class="ab-bq">' + inline(bq.join("<br>")) + '</blockquote>');
        continue;
      }
      if (ulist(line)) {
        var u = [];
        while (i < lines.length && ulist(lines[i])) u.push(gatherListItem(/^\s*[*-]\s+/));
        out.push('<ul class="ab-ul">' + u.map(function (it) {
          return "<li>" + inline(it) + "</li>";
        }).join("") + "</ul>");
        continue;
      }
      if (olist(line)) {
        var o = [];
        while (i < lines.length && olist(lines[i])) o.push(gatherListItem(/^\s*\d+\.\s+/));
        out.push('<ol class="ab-ol">' + o.map(function (it) {
          return "<li>" + inline(it) + "</li>";
        }).join("") + "</ol>");
        continue;
      }
      var p = [line]; i++;
      while (i < lines.length && !blank(lines[i]) && !head(lines[i]) &&
             !ulist(lines[i]) && !olist(lines[i]) && !quote(lines[i]) && !hrule(lines[i])) {
        p.push(lines[i]); i++;
      }
      out.push("<p>" + inline(p.join("<br>")) + "</p>");
    }

    var html = out.join("");
    html = html.replace(/__MT_CB_(\d+)__/g, function (_, n) { return blocks[+n]; });
    return html;

    function inline(s) {
      var codes = [];
      s = s.replace(/`([^`]+)`/g, function (_, c) {
        codes.push('<code class="ab-ic">' + c + "</code>");
        return "__MT_IC_" + (codes.length - 1) + "__";
      });
      s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
      s = s.replace(/(^|[^_\w])_([^_\n]+?)_(?!_)/g, "$1<em>$2</em>");
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      s = s.replace(/__MT_IC_(\d+)__/g, function (_, n) { return codes[+n]; });
      return s;
    }
  }

  global.MT = {
    $: $,
    getKbKey: getKbKey,
    getGeminiKey: getGeminiKey,
    getAnthropicKey: getAnthropicKey,
    setKeys: setKeys,
    getActiveStore: getActiveStore,
    setActiveStore: setActiveStore,
    storeId: storeId,
    headers: headers,
    api: api,
    busy: busy,
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    mountChrome: mountChrome,
    log: log,
    renderMarkdown: renderMarkdown,
  };
})(window);
