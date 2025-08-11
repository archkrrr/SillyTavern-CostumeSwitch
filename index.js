import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "SillyTavern-CostumeSwitch";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const DEFAULTS = {
  enabled: true,
  resetTimeoutMs: 3000,
  patterns: ["Tohka", "Shido", "Kotori"],
  defaultCostume: "",
  narrationSwitch: false,
  debug: false,
  globalCooldownMs: 1200,
  perTriggerCooldownMs: 250,
  failedTriggerCooldownMs: 10000,
  maxBufferChars: 2000,

  // NEW tunables (safe defaults)
  tokenBoundarySize: 80,        // chars of prev buffer to include when quick-scanning tokens
  pronounLookbackChars: 1400   // how far back to search for names when resolving pronouns
};

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* robust pattern parsing (accepts escaped slashes) */
function parsePatternEntry(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^\/((?:\\.|[^\/])+)\/([gimsuy]*)$/);
  if (m) return { body: m[1], flags: (m[2] || '') };
  return { body: escapeRegex(trimmed), flags: '' };
}

function computeFlagsFromEntries(entries, requireI = true) {
  let flagsSet = new Set();
  for (const e of entries) {
    if (!e) continue;
    for (const ch of (e.flags || '')) flagsSet.add(ch);
  }
  if (requireI) flagsSet.add('i');
  const allowed = 'gimsuy';
  return Array.from(flagsSet).filter(c => allowed.includes(c)).join('');
}

/* Build regexes (same logic as before) */
function buildNameRegex(patternList) {
  const entries = (patternList || []).map(parsePatternEntry).filter(Boolean);
  if (!entries.length) return null;
  const parts = entries.map(e => `(?:${e.body})`);
  const body = `(?:^|\\n|[\\(\\[\\-—–])(?:${parts.join('|')})(?:\\W|$)`;
  const flags = computeFlagsFromEntries(entries, true);
  try { return new RegExp(body, flags); } catch (e) { console.warn("buildNameRegex compile failed:", e); return null; }
}
function buildSpeakerRegex(patternList) {
  const entries = (patternList || []).map(parsePatternEntry).filter(Boolean);
  if (!entries.length) return null;
  const parts = entries.map(e => `(?:${e.body})`);
  const body = `(?:^|\\n)\\s*(${parts.join('|')})\\s*(?:[:;,]|\\b)\\s*`;
  const flags = computeFlagsFromEntries(entries, true);
  try { return new RegExp(body, flags); } catch (e) { console.warn("buildSpeakerRegex compile failed:", e); return null; }
}
function buildVocativeRegex(patternList) {
  const entries = (patternList || []).map(parsePatternEntry).filter(Boolean);
  if (!entries.length) return null;
  const parts = entries.map(e => `(?:${e.body})`);
  const body = `(?:^|\\n|\\s)(${parts.join('|')})\\s*,`;
  const flags = computeFlagsFromEntries(entries, true);
  try { return new RegExp(body, flags); } catch (e) { console.warn("buildVocativeRegex compile failed:", e); return null; }
}
function buildAttributionRegex(patternList) {
  const entries = (patternList || []).map(parsePatternEntry).filter(Boolean);
  if (!entries.length) return null;
  const names = entries.map(e => `(?:${e.body})`).join('|');
  const verbs = '(?:said|asked|replied|murmured|whispered|sighed|laughed|exclaimed|noted|added|answered|shouted|cried|muttered|remarked)';
  const patA = '(["\\u201C\\u201D].{0,400}["\\u201C\\u201D])\\s*,?\\s*(' + names + ')\\s+' + verbs;
  const patB = '(?:^|\\n)\\s*(' + names + ')\\s+' + verbs + '\\s*[:,]?\\s*["\\u201C\\u201D]';
  const body = `(?:${patA})|(?:${patB})`;
  const flags = computeFlagsFromEntries(entries, true);
  try { return new RegExp(body, flags); } catch (e) { console.warn("buildAttributionRegex compile failed:", e); return null; }
}
function buildActionRegex(patternList) {
  const entries = (patternList || []).map(parsePatternEntry).filter(Boolean);
  if (!entries.length) return null;
  const parts = entries.map(e => `(?:${e.body})`);
  const actions = '(?:nodded|leaned|smiled|laughed|stood|sat|gestured|sighed|replied|said|murmured|whispered|muttered|observed|watched|turned|glanced|held|lowered|positioned|stepped|approached)';
  const body = `(?:^|\\n)\\s*(${parts.join('|')})(?:\\s+[A-Z][a-z]+)?\\b\\s+${actions}\\b`;
  const flags = computeFlagsFromEntries(entries, true);
  try { return new RegExp(body, flags); } catch (e) { console.warn("buildActionRegex compile failed:", e); return null; }
}

/* Quote ranges helpers (robust inside-quote checks) */
function getQuoteRanges(s) {
  const q = /["\u201C\u201D]/g;
  const pos = [];
  let m;
  while ((m = q.exec(s)) !== null) pos.push(m.index);
  const ranges = [];
  for (let i = 0; i + 1 < pos.length; i += 2) ranges.push([pos[i], pos[i + 1]]);
  return ranges;
}
function isIndexInsideQuotesRanges(ranges, idx) {
  for (const [a, b] of ranges) if (idx > a && idx < b) return true;
  return false;
}

// New quote-aware helpers
function posIsInsideQuotes(pos, combined, quoteRanges) {
  if (pos == null || !combined) return false;
  if (quoteRanges && quoteRanges.length) {
    if (isIndexInsideQuotesRanges(quoteRanges, pos)) return true;
  }
  // parity fallback for streaming/unclosed quotes
  return isInsideQuotes(combined, pos);
}

// Iterate and collect non-quoted matches for a regex (returns array of {match, groups, index})
function findNonQuotedMatches(combined, regex, quoteRanges) {
  if (!combined || !regex) return [];
  const flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
  const re = new RegExp(regex.source, flags);
  const results = [];
  let m;
  while ((m = re.exec(combined)) !== null) {
    const idx = m.index || 0;
    if (!posIsInsideQuotes(idx, combined, quoteRanges)) {
      results.push({ match: m[0], groups: m.slice(1), index: idx });
    }
    // avoid infinite loop for zero-length matches
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return results;
}
function lastNonQuotedMatch(combined, regex, quoteRanges) {
  const ms = findNonQuotedMatches(combined, regex, quoteRanges);
  return ms.length ? ms[ms.length - 1] : null;
}

function isInsideQuotes(text, pos) {
  // keep fallback (counts double quotes) but prefer range-based checks in main code
  if (!text || pos <= 0) return false;
  const before = text.slice(0, pos);
  const quoteCount = (before.match(/["\u201C\u201D]/g) || []).length;
  return (quoteCount % 2) === 1;
}

/* Text normalization for incoming tokens */
function normalizeStreamText(s) {
  if (!s) return '';
  s = String(s);
  // strip zero-width / BOM
  s = s.replace(/[\uFEFF\u200B\u200C\u200D]/g, '');
  // convert smart quotes to straight quotes
  s = s.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"');
  // remove common markdown wrappers that often surround text
  s = s.replace(/(\*\*|__|~~|`{1,3})/g, '');
  // NBSP -> space
  s = s.replace(/\u00A0/g, ' ');
  return s;
}

// --- MOVE normalizeCostumeName to top-level so all helpers can use it ---
function normalizeCostumeName(n) {
  if (!n) return "";
  let s = String(n).trim();
  // remove leading slash if present
  if (s.startsWith("/")) s = s.slice(1).trim();
  // if it's a folder-like "name/name" or "/name/name", use the first segment
  // split on forward slash or whitespace and take first meaningful token
  const first = s.split(/[\/\s]+/).filter(Boolean)[0] || s;
  // strip common honorifics appended with - or _ (keep simpler)
  return String(first).replace(/[-_](?:sama|san)$/i, '').trim();
}

// runtime state
const perMessageBuffers = new Map();
let lastIssuedCostume = null;
let resetTimer = null;
let lastSwitchTimestamp = 0;
const lastTriggerTimes = new Map();
const failedTriggerTimes = new Map();

// NEW: stable handler refs for cleanup
let _streamHandler = null;
let _genEndHandler = null;
let _msgRecvHandler = null;
let _chatChangedHandler = null;

// NEW: click guard set
let _clickInProgress = new Set();

// NEW: buffer cap helpers
const MAX_MESSAGE_BUFFERS = 60; // tuneable
function ensureBufferLimit() {
  if (perMessageBuffers.size <= MAX_MESSAGE_BUFFERS) return;
  while (perMessageBuffers.size > MAX_MESSAGE_BUFFERS) {
    const firstKey = perMessageBuffers.keys().next().value;
    perMessageBuffers.delete(firstKey);
  }
}

// NEW: recent speaker stack for pronoun resolution
const recentSpeakers = []; // {name, ts}
const RECENT_SPEAKER_MAX = 8;
function pushRecentSpeaker(name) {
  name = normalizeCostumeName(name || '');
  if (!name) return;
  const ts = Date.now();
  if (recentSpeakers.length && recentSpeakers[recentSpeakers.length-1].name.toLowerCase() === name.toLowerCase()) {
    recentSpeakers[recentSpeakers.length-1].ts = ts;
    return;
  }
  recentSpeakers.push({ name, ts });
  if (recentSpeakers.length > RECENT_SPEAKER_MAX) recentSpeakers.shift();
}
function getMostRecentSpeakerBefore(cutoffTs = Date.now()) {
  for (let i = recentSpeakers.length - 1; i >= 0; --i) {
    if (recentSpeakers[i].ts <= cutoffTs) return recentSpeakers[i].name;
  }
  return null;
}

function waitForSelector(selector, timeout = 3000, interval = 120) {
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const el = document.querySelector(selector);
      if (el) { clearInterval(iv); resolve(true); return; }
      if (Date.now() - start > timeout) { clearInterval(iv); resolve(false); }
    }, interval);
  });
}

/* flags helper */
function flagsWithoutG(regex) {
  if (!regex) return '';
  return (regex.flags || '').replace(/g/g, '');
}

/* precomputed non-global regex slots (filled when building regexes) */
let speakerRegexNoG = null;
let vocativeRegexNoG = null;
let actionRegexNoG = null;

jQuery(async () => {
  const { store, save, ctx } = getSettingsObj();
  const settings = store[extensionName];

  try {
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings").append(settingsHtml);
  } catch (e) {
    console.warn("Failed to load settings.html:", e);
    $("#extensions_settings").append('<div><h3>Costume Switch</h3><div>Failed to load UI (see console)</div></div>');
  }

  const ok = await waitForSelector("#cs-save", 3000, 100);
  if (!ok) console.warn("CostumeSwitch: settings UI did not appear within timeout. Attempting to continue (UI may be unresponsive).");

  if (jQuery("#cs-enable").length) $("#cs-enable").prop("checked", !!settings.enabled);
  if (jQuery("#cs-patterns").length) $("#cs-patterns").val((settings.patterns || []).join("\n"));
  if (jQuery("#cs-default").length) $("#cs-default").val(settings.defaultCostume || "");
  if (jQuery("#cs-timeout").length) $("#cs-timeout").val(settings.resetTimeoutMs || DEFAULTS.resetTimeoutMs);
  if (jQuery("#cs-narration").length) $("#cs-narration").prop("checked", !!settings.narrationSwitch);
  if (jQuery("#cs-debug").length) $("#cs-debug").prop("checked", !!settings.debug);
  if ($("#cs-global-cooldown").length) $("#cs-global-cooldown").val(settings.globalCooldownMs || DEFAULTS.globalCooldownMs);
  if ($("#cs-per-cooldown").length) $("#cs-per-cooldown").val(settings.perTriggerCooldownMs || DEFAULTS.perTriggerCooldownMs);
  if ($("#cs-failed-cooldown").length) $("#cs-failed-cooldown").val(settings.failedTriggerCooldownMs || DEFAULTS.failedTriggerCooldownMs);
  if ($("#cs-max-buffer").length) $("#cs-max-buffer").val(settings.maxBufferChars || DEFAULTS.maxBufferChars);
  // new inputs (if you added them to settings.html) should be wired similarly:
  if ($("#cs-token-boundary").length) $("#cs-token-boundary").val(settings.tokenBoundarySize || DEFAULTS.tokenBoundarySize);
  if ($("#cs-pronoun-lookback").length) $("#cs-pronoun-lookback").val(settings.pronounLookbackChars || DEFAULTS.pronounLookbackChars);

  $("#cs-status").text("Ready");

  function persistSettings() { if (save) save(); if (jQuery("#cs-status").length) $("#cs-status").text(`Saved ${new Date().toLocaleTimeString()}`); setTimeout(()=>jQuery("#cs-status").text(""), 1500); }

  const realCtx = ctx || (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null);
  if (!realCtx) { console.error("SillyTavern context not found. Extension won't run."); return; }

  const { eventSource, event_types, characters } = realCtx;

  // Build initial regexes and precompute NoG variants
  let nameRegex = buildNameRegex(settings.patterns || DEFAULTS.patterns);
  let speakerRegex = buildSpeakerRegex(settings.patterns || DEFAULTS.patterns);
  let attributionRegex = buildAttributionRegex(settings.patterns || DEFAULTS.patterns);
  let actionRegex = buildActionRegex(settings.patterns || DEFAULTS.patterns);
  let vocativeRegex = buildVocativeRegex(settings.patterns || DEFAULTS.patterns);

  function buildNoGVariants() {
    speakerRegexNoG = speakerRegex ? new RegExp(speakerRegex.source, flagsWithoutG(speakerRegex) || 'i') : null;
    vocativeRegexNoG = vocativeRegex ? new RegExp(vocativeRegex.source, flagsWithoutG(vocativeRegex) || 'i') : null;
    actionRegexNoG = actionRegex ? new RegExp(actionRegex.source, flagsWithoutG(actionRegex) || 'i') : null;
  }
  buildNoGVariants();

  function tryWireUI() {
    if ($("#cs-save").length) {
      $("#cs-save").off('click.cs').on("click.cs", () => {
        settings.enabled = !!$("#cs-enable").prop("checked");
        settings.patterns = $("#cs-patterns").val().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        settings.defaultCostume = $("#cs-default").val().trim();
        settings.resetTimeoutMs = parseInt($("#cs-timeout").val()||DEFAULTS.resetTimeoutMs, 10);
        if ($("#cs-narration").length) settings.narrationSwitch = !!$("#cs-narration").prop("checked");
        if ($("#cs-debug").length) settings.debug = !!$("#cs-debug").prop("checked");
        settings.globalCooldownMs = parseInt($("#cs-global-cooldown").val() || DEFAULTS.globalCooldownMs, 10);
        settings.perTriggerCooldownMs = parseInt($("#cs-per-cooldown").val() || DEFAULTS.perTriggerCooldownMs, 10);
        settings.failedTriggerCooldownMs = parseInt($("#cs-failed-cooldown").val() || DEFAULTS.failedTriggerCooldownMs, 10);
        const mb = parseInt($("#cs-max-buffer").val() || DEFAULTS.maxBufferChars, 10);
        settings.maxBufferChars = isFinite(mb) && mb > 0 ? mb : DEFAULTS.maxBufferChars;

        // wire new tunables if present in UI
        const tbs = parseInt($("#cs-token-boundary").val() || DEFAULTS.tokenBoundarySize, 10);
        settings.tokenBoundarySize = isFinite(tbs) && tbs > 0 ? tbs : DEFAULTS.tokenBoundarySize;
        const pl = parseInt($("#cs-pronoun-lookback").val() || DEFAULTS.pronounLookbackChars, 10);
        settings.pronounLookbackChars = isFinite(pl) && pl > 0 ? pl : DEFAULTS.pronounLookbackChars;

        // rebuild regexes & noG variants
        nameRegex = buildNameRegex(settings.patterns || DEFAULTS.patterns);
        speakerRegex = buildSpeakerRegex(settings.patterns || DEFAULTS.patterns);
        attributionRegex = buildAttributionRegex(settings.patterns || DEFAULTS.patterns);
        actionRegex = buildActionRegex(settings.patterns || DEFAULTS.patterns);
        vocativeRegex = buildVocativeRegex(settings.patterns || DEFAULTS.patterns);
        buildNoGVariants();
        persistSettings();
      });
    }
    if ($("#cs-reset").length) { $("#cs-reset").off('click.cs').on("click.cs", async () => { await manualReset(); }); }
  }
  tryWireUI(); setTimeout(tryWireUI, 500); setTimeout(tryWireUI, 1500);

  /* Simulate a real quick-reply click on SillyTavern's QR buttons.
     Uses .qr--button (visible button) and falls back to title (message). */
  function triggerQuickReply(labelOrMessage) {
    try {
      const label = String(labelOrMessage || '').trim();
      if (!label) return false;

      const candidates = Array.from(document.querySelectorAll('.qr--button'));

      // 1) match by visible label text inside .qr--button-label
      for (const el of candidates) {
        try {
          const lbl = el.querySelector('.qr--button-label');
          if (lbl && String(lbl.innerText || lbl.textContent || '').trim() === label) {
            if (window.console && console.debug) console.debug(`[CostumeSwitch] Clicking Quick Reply (label): "${label}"`);
            el.click();
            return true;
          }
        } catch (e) { /* continue */ }
      }

      // 2) match by title attribute (underlying quick-reply message text, e.g. "/costume Shido")
      for (const el of candidates) {
        try {
          const title = (el.getAttribute && el.getAttribute('title')) || '';
          if (String(title || '').trim() === label) {
            if (window.console && console.debug) console.debug(`[CostumeSwitch] Clicking Quick Reply (title): "${label}"`);
            el.click();
            return true;
          }
        } catch (e) { /* continue */ }
      }

      // 3) try matching trimmed/normalized variations (some installs may store label slightly differently)
      for (const el of candidates) {
        try {
          const lbl = el.querySelector('.qr--button-label');
          const content = String(lbl?.innerText || lbl?.textContent || el.getAttribute('title') || '').trim();
          if (!content) continue;
          if (content.toLowerCase() === label.toLowerCase()) {
            el.click();
            if (window.console && console.debug) console.debug(`[CostumeSwitch] Clicking Quick Reply (case-insensitive match): "${content}"`);
            return true;
          }
        } catch (e) { /* continue */ }
      }

      console.warn(`[CostumeSwitch] Quick Reply not found: "${label}"`);
      return false;
    } catch (err) {
      console.error(`[CostumeSwitch] Error triggering Quick Reply "${labelOrMessage}":`, err);
      return false;
    }
  }

  /* Quick-reply trigger that attempts multiple candidate message forms and respects failed cooldowns */
  function triggerQuickReplyVariants(costumeArg) {
    if (!costumeArg) return false;
    const name = normalizeCostumeName(String(costumeArg));
    if (!name) return false;

    // candidate order (prefer simplest)
    const rawCandidates = [
      `${name}`,
      `${name}/${name}`,
      `/costume ${name}`,
      `/costume ${name}/${name}`,
      `/${name}`,
      `${name} / ${name}`,
      String(costumeArg)
    ];

    const now = Date.now();
    if (settings.debug) console.debug("CS debug: triggerQuickReplyVariants candidates:", rawCandidates);

    for (let c of rawCandidates) {
      if (!c) continue;
      c = String(c).trim();
      const key = c.toLowerCase();
      const lastFailed = failedTriggerTimes.get(key) || 0;
      const cooldown = (settings.failedTriggerCooldownMs || DEFAULTS.failedTriggerCooldownMs);
      if (now - lastFailed < cooldown) {
        if (settings.debug) console.debug("CS debug: skipping candidate due to failed-cooldown", { candidate: c, lastFailed, cooldown });
        continue;
      }
      if (_clickInProgress.has(key)) {
        if (settings.debug) console.debug("CS debug: click in progress, skipping candidate", key);
        continue;
      }
      try {
        _clickInProgress.add(key);
        if (triggerQuickReply(c)) {
          failedTriggerTimes.delete(key);
          if (settings.debug) console.debug("CS debug: triggerQuickReplyVariants succeeded for", c);
          return true;
        } else {
          failedTriggerTimes.set(key, Date.now());
          if (settings.debug) console.debug("CS debug: triggerQuickReplyVariants failed for", c);
        }
      } finally {
        _clickInProgress.delete(key);
      }
    }
    return false;
  }

  async function manualReset() {
    let costumeArg = settings.defaultCostume || "";
    if (!costumeArg) {
      const ch = realCtx.characters?.[realCtx.characterId]; if (ch && ch.name) costumeArg = `${ch.name}/${ch.name}`;
    }
    if (!costumeArg) { if ($("#cs-status").length) $("#cs-status").text("No default costume defined."); return; }
    const ok = triggerQuickReplyVariants(costumeArg);
    if (ok) { lastIssuedCostume = costumeArg; if ($("#cs-status").length) $("#cs-status").text(`Reset -> ${costumeArg}`); setTimeout(()=>$("#cs-status").text(""), 1500); }
    else { if ($("#cs-status").length) $("#cs-status").text(`Quick Reply not found for ${costumeArg}`); setTimeout(()=>$("#cs-status").text(""), 1500); }
  }

  function issueCostumeForName(name) {
    if (!name) return;
    name = normalizeCostumeName(name);
    const now = Date.now();

    // --- EARLY: check if we're already using this costume (avoid needless re-switching) ---
    const currentName = normalizeCostumeName(lastIssuedCostume || settings.defaultCostume || (realCtx?.characters?.[realCtx.characterId]?.name) || '');
    if (currentName && currentName.toLowerCase() === name.toLowerCase()) {
      if (settings.debug) console.debug("CS debug: already using costume for", name, "- skipping switch.");
      // keep the idle-reset timer alive so auto-reset still happens after timeout
      scheduleResetIfIdle();
      return;
    }

    // --- global cooldown (only after confirming name differs from current) ---
    if (now - lastSwitchTimestamp < (settings.globalCooldownMs || DEFAULTS.globalCooldownMs)) {
      if (settings.debug) console.debug("CS debug: global cooldown active, skipping switch to", name, {
        lastSwitchTimestamp, cooldownMs: settings.globalCooldownMs || DEFAULTS.globalCooldownMs
      });
      return;
    }

    const argFolder = `${name}/${name}`;
    const last = lastTriggerTimes.get(argFolder) || 0;
    if (now - last < (settings.perTriggerCooldownMs || DEFAULTS.perTriggerCooldownMs)) {
      if (settings.debug) console.debug("CS debug: per-trigger cooldown active, skipping", argFolder);
      return;
    }

    if (settings.debug) console.debug("CS debug: attempting switch for detected name:", name, "->", argFolder);
    const ok = triggerQuickReplyVariants(argFolder) || triggerQuickReplyVariants(name);
    if (ok) {
      lastTriggerTimes.set(argFolder, now);
      lastIssuedCostume = argFolder;
      lastSwitchTimestamp = now;
      pushRecentSpeaker(name); // record successful switch as a confident speaker detection
      if ($("#cs-status").length) $("#cs-status").text(`Switched -> ${argFolder}`);
      setTimeout(()=>$("#cs-status").text(""), 1000);
    } else {
      failedTriggerTimes.set(argFolder.toLowerCase(), Date.now());
      if ($("#cs-status").length) $("#cs-status").text(`Quick Reply not found for ${name}`);
      setTimeout(()=>$("#cs-status").text(""), 1000);
    }
  }


  function scheduleResetIfIdle() {
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(async () => {
      let costumeArg = settings.defaultCostume || "";
      if (!costumeArg) {
        const ch = realCtx.characters?.[realCtx.characterId];
        if (ch && ch.name) costumeArg = `${ch.name}/${ch.name}`;
      }
      if (costumeArg && triggerQuickReplyVariants(costumeArg)) {
        lastIssuedCostume = costumeArg;
        if ($("#cs-status").length) $("#cs-status").text(`Auto-reset -> ${costumeArg}`);
        setTimeout(()=>$("#cs-status").text(""), 1200);
      }
    }, settings.resetTimeoutMs || DEFAULTS.resetTimeoutMs);
  }

  const streamEventName = event_types?.STREAM_TOKEN_RECEIVED || event_types?.SMOOTH_STREAM_TOKEN_RECEIVED || 'stream_token_received';

  // -------------------------
  // STREAM HANDLER (main)
  // -------------------------
  _streamHandler = (...args) => {
    try {
      if (!settings.enabled) return;
      let tokenText = ""; let messageId = null;
      if (typeof args[0] === 'number') { messageId = args[0]; tokenText = String(args[1] ?? ""); }
      else if (typeof args[0] === 'string' && args.length === 1) tokenText = args[0];
      else if (args[0] && typeof args[0] === 'object') { tokenText = String(args[0].token ?? args[0].text ?? ""); messageId = args[0].messageId ?? args[1] ?? null; }
      else tokenText = String(args.join(' ') || "");
      if (!tokenText) return;

      // normalize the streamed token
      tokenText = normalizeStreamText(tokenText);

      const bufKey = messageId != null ? `m${messageId}` : 'live';
      const prev = perMessageBuffers.get(bufKey) || "";
      const combined = (prev + tokenText).slice(- (settings.maxBufferChars || DEFAULTS.maxBufferChars)); // cap buffer
      perMessageBuffers.set(bufKey, combined);
      ensureBufferLimit();
      let matchedName = null;

      // build quote ranges once for this buffer
      const quoteRanges = getQuoteRanges(combined);

      // QUICK token-level scan (low-latency) using precomputed noG regexes
      (function quickTokenScan() {
        try {
          const short = String(tokenText || '').trim();
          if (!short) return;

          // QUICK heuristic: skip tokens that look like internal logs / UI text
          const systemNoiseRe = /Event emitted:|Added\/edited expression override|Expression set|force redrawing character|Streaming in progress:|Timeout waiting for is_send_press|Invalid URI|Empty string passed to getElementById/i;
          if (systemNoiseRe.test(short)) {
            if (settings.debug) console.debug("CS debug: skipping system-noise token:", short.slice(0,120));
            return;
          }

          // Build a small "boundary window" which includes the tail of the previous buffer
          // so we can detect names/actions split across token boundaries.
          const boundarySize = Number(settings.tokenBoundarySize || DEFAULTS.tokenBoundarySize) || DEFAULTS.tokenBoundarySize;
          const prevTailStart = Math.max(0, (prev || '').length - boundarySize);
          const prevTail = (prev || '').slice(prevTailStart);
          const window = prevTail + short;
          const windowOffset = prevTailStart; // index of window[0] inside combined
          const prevLength = (prev || '').length;

          // helper: accept match only if it overlaps into the new token (not fully inside prev)
          function matchOverlapsNewToken(matchIndex, matchTextLen) {
            const startInCombined = windowOffset + matchIndex;
            const endInCombined = startInCombined + (matchTextLen || 0);
            // require that match end is greater than prevLength (i.e., some of it is in the new token)
            return endInCombined > prevLength;
          }

          // Prepare quote ranges for the window (parity fallback still ok)
          const windowQuoteRanges = getQuoteRanges(window);

          // 1) speakerRegexNoG on window (helps capture "Kotori:" or "Kotori Yatogami:" when split)
          if (speakerRegexNoG) {
            const matches = findNonQuotedMatches(window, speakerRegexNoG, windowQuoteRanges);
            if (matches.length) {
              const m = matches[0]; // short window should have earliest match
              if (matchOverlapsNewToken(m.index, m.match.length)) {
                const posInCombined = windowOffset + m.index;
                if (!posIsInsideQuotes(posInCombined, combined, quoteRanges)) { matchedName = m.groups && m.groups[0] ? m.groups[0].trim() : null; return; }
              } else {
                if (settings.debug) console.debug("CS debug: speakerRegex window match ignored (entirely in prev buffer).");
              }
            }
          }

          // 2) vocativeRegexNoG on window
          if (!matchedName && vocativeRegexNoG) {
            const matches = findNonQuotedMatches(window, vocativeRegexNoG, windowQuoteRanges);
            if (matches.length) {
              const m = matches[0];
              if (matchOverlapsNewToken(m.index, m.match.length)) {
                const posInCombined = windowOffset + m.index;
                if (!posIsInsideQuotes(posInCombined, combined, quoteRanges)) { matchedName = m.groups && m.groups[0] ? m.groups[0].trim() : null; return; }
              } else {
                if (settings.debug) console.debug("CS debug: vocativeRegex window match ignored (entirely in prev buffer).");
              }
            }
          }

          // 3) actionRegexNoG on window (catches "Kotori Itsuka leaned..." where "Kotori" might have been token-boundary-split)
          if (!matchedName && actionRegexNoG) {
            const matches = findNonQuotedMatches(window, actionRegexNoG, windowQuoteRanges);
            if (matches.length) {
              const m = matches[0];
              if (matchOverlapsNewToken(m.index, m.match.length)) {
                const posInCombined = windowOffset + m.index;
                if (!posIsInsideQuotes(posInCombined, combined, quoteRanges)) { matchedName = m.groups && m.groups[0] ? m.groups[0].trim() : null; return; }
              } else {
                if (settings.debug) console.debug("CS debug: actionRegex window match ignored (entirely in prev buffer).");
              }
            }
          }

          // 4) simple name-in-token scan on window (case-insensitive)
          if (!matchedName && settings.patterns && settings.patterns.length) {
            const names = settings.patterns.map(s => (s||'').trim()).filter(Boolean);
            if (names.length) {
              const anyNameRe = new RegExp('\\b(' + names.map(escapeRegex).join('|') + ')\\b', 'i');
              const matches = findNonQuotedMatches(window, anyNameRe, windowQuoteRanges);
              if (matches.length) {
                for (const mm of matches) {
                  if (!matchOverlapsNewToken(mm.index, mm.match.length)) {
                    if (settings.debug) console.debug("CS debug: name-in-window match ignored (entirely in prev buffer).", mm);
                    continue;
                  }
                  const posInCombined = windowOffset + mm.index;
                  if (!posIsInsideQuotes(posInCombined, combined, quoteRanges)) {
                    matchedName = (mm.groups && mm.groups[0]) ? mm.groups[0].trim() : mm.match;
                    break;
                  } else {
                    if (settings.debug) console.debug("CS debug: name-in-window match skipped due to quotes", mm);
                  }
                }
              }
            }
          }
        } catch (e) { if (settings.debug) console.warn("quickTokenScan error", e); }
      })();

      if (matchedName) {
        if (settings.debug) console.debug("CS debug: quickTokenScan matchedName =", matchedName, "bufKey:", bufKey);
        issueCostumeForName(matchedName);
        scheduleResetIfIdle();
        try {
          const idx = (combined || '').toLowerCase().lastIndexOf(matchedName.toLowerCase());
          if (idx >= 0) perMessageBuffers.set(bufKey, (combined || '').slice(idx + matchedName.length));
          else perMessageBuffers.set(bufKey, '');
        } catch (e) { perMessageBuffers.set(bufKey, ''); }
        return;
      }

      // HEAVY scanning on the whole combined buffer (quote-aware)
      try {
        // 1) speakerRegex last non-quoted occurrence
        if (!matchedName && speakerRegex) {
          const lastSpeaker = lastNonQuotedMatch(combined, speakerRegex, quoteRanges);
          if (lastSpeaker) matchedName = lastSpeaker.groups && lastSpeaker.groups[0] ? lastSpeaker.groups[0].trim() : null;
        }

        // 2) attribution (last non-quoted)
        if (!matchedName && attributionRegex) {
          const lastA = lastNonQuotedMatch(combined, attributionRegex, quoteRanges);
          if (lastA) {
            if (lastA.groups && lastA.groups.length) {
              for (const g of lastA.groups) {
                if (g) { matchedName = g.trim(); break; }
              }
            }
          }
        }

        // 3) action regex last non-quoted occurrence
        if (!matchedName && actionRegex) {
          const lastAct = lastNonQuotedMatch(combined, actionRegex, quoteRanges);
          if (lastAct && lastAct.groups && lastAct.groups.length) matchedName = lastAct.groups[0].trim();
        }

        // 4) vocative last non-quoted occurrence
        if (!matchedName && vocativeRegex) {
          const lastV = lastNonQuotedMatch(combined, vocativeRegex, quoteRanges);
          if (lastV && lastV.groups && lastV.groups.length) matchedName = lastV.groups[0].trim();
        }

        // 5a) possessive detection (non-quoted)
        if (!matchedName && settings.patterns && settings.patterns.length) {
          const names_poss = settings.patterns.map(s => (s||'').trim()).filter(Boolean);
          if (names_poss.length) {
            const possRe = new RegExp('\\b(' + names_poss.map(escapeRegex).join('|') + ")[’'`]s\\b", 'gi');
            const lastP = lastNonQuotedMatch(combined, possRe, quoteRanges);
            if (lastP && lastP.groups && lastP.groups.length) matchedName = lastP.groups[0].trim();
          }
        }

        // 5b) pronoun attribution inference (prefer recent-speaker stack first)
        if (!matchedName && settings.patterns && settings.patterns.length) {
          const pronARe = /["\u201C\u201D][^"\u201C\u201D]{0,400}["\u201C\u201D]\s*,?\s*(?:he|she|they)\s+(?:said|murmured|whispered|replied|asked|noted|added|sighed|laughed|exclaimed)/i;
          const pM = pronARe.exec(combined);
          if (pM) {
            // try recentSpeakers stack first
            const chosenFromStack = getMostRecentSpeakerBefore();
            if (chosenFromStack) {
              matchedName = chosenFromStack;
            } else {
              const cutIndex = pM.index || 0;
              const lookback = Math.max(0, cutIndex - (settings.pronounLookbackChars || DEFAULTS.pronounLookbackChars));
              const sub = (combined || '').slice(lookback, cutIndex);
              const names_pron = settings.patterns.map(s => (s||'').trim()).filter(Boolean);
              if (names_pron.length) {
                const anyNameRe = new RegExp('\\b(' + names_pron.map(escapeRegex).join('|') + ')\\b', 'gi');
                const lastMatch = lastNonQuotedMatch(sub, anyNameRe, getQuoteRanges(sub));
                if (lastMatch && lastMatch.groups && lastMatch.groups.length) matchedName = lastMatch.groups[0].trim();
              }
            }
          }
        }

        // 5c) narration fallback (only if user enabled narrationSwitch)
        if (!matchedName && nameRegex && settings.narrationSwitch) {
          const actionsOrPossessive = "(?:'s|’s|held|shifted|stood|sat|nodded|smiled|laughed|leaned|stepped|walked|turned|looked|moved|approached|said|asked|replied|observed|gazed|watched|beamed|frowned|sighed|remarked|added)";
          const narrationRe = new RegExp(nameRegex.source + '\\b\\s+' + actionsOrPossessive + '\\b', 'gi');
          const lastMatch = lastNonQuotedMatch(combined, narrationRe, quoteRanges);
          if (lastMatch && lastMatch.groups && lastMatch.groups.length) {
            matchedName = String(lastMatch.groups[0] || lastMatch.match).replace(/-(?:sama|san)$/i, '').trim();
          }
        }

        // 6) last-resort: last non-quoted occurrence of any known name
        if (!matchedName && settings.patterns && settings.patterns.length) {
          const names = settings.patterns.map(s => (s||'').trim()).filter(Boolean);
          if (names.length) {
            const anyNameRe = new RegExp('\\b(' + names.map(escapeRegex).join('|') + ')\\b', 'gi');
            const lastMatch = lastNonQuotedMatch(combined, anyNameRe, quoteRanges);
            if (lastMatch && lastMatch.groups && lastMatch.groups.length) matchedName = String(lastMatch.groups[0] || lastMatch.match).replace(/-(?:sama|san)$/i, '').trim();
          }
        }

        // Heuristic: prefer the most recent mention among known names
        // Only accept chosen if it is recent enough
        if (!matchedName && settings.patterns && settings.patterns.length) {
          const names = settings.patterns.map(s => (s||'').trim()).filter(Boolean);
          let chosen = null; let chosenIdx = -1;
          for (const nm of names) {
            const low = nm.toLowerCase();
            const idx = (combined || '').toLowerCase().lastIndexOf(low);
            if (idx > chosenIdx) { chosen = nm; chosenIdx = idx; }
          }
          const RECENT_WINDOW = 700;
          if (chosen && chosenIdx >= (combined.length - RECENT_WINDOW)) {
            matchedName = chosen;
            perMessageBuffers.set(bufKey, (combined || '').slice(chosenIdx + chosen.length));
          }
        }
      } catch (e) {
        if (settings.debug) console.error("Heavy scan error:", e);
      }

      if (matchedName) {
        if (settings.debug) console.debug("CS debug: heavy scan matchedName =", matchedName, "bufKey:", bufKey);
        issueCostumeForName(matchedName);
        scheduleResetIfIdle();
        try {
          const idx = (combined || '').toLowerCase().lastIndexOf(matchedName.toLowerCase());
          if (idx >= 0) perMessageBuffers.set(bufKey, (combined || '').slice(idx + matchedName.length));
          else perMessageBuffers.set(bufKey, '');
        } catch (e) { perMessageBuffers.set(bufKey, ''); }
      }

      if (settings.debug) console.debug("CS debug: ", { bufKey, recent: combined.slice(-400), matchedName });

    } catch (err) { console.error("CostumeSwitch stream handler error:", err); }
  };

  // -------------------------
  // OTHER EVENT HANDLERS
  // -------------------------
  _genEndHandler = (messageId) => { if (messageId != null) perMessageBuffers.delete(`m${messageId}`); scheduleResetIfIdle(); };
  _msgRecvHandler = (messageId) => { if (messageId != null) perMessageBuffers.delete(`m${messageId}`); };
  _chatChangedHandler = () => { perMessageBuffers.clear(); lastIssuedCostume = null; recentSpeakers.length = 0; };

  // Ensure previous handlers (if any) are cleared first to avoid duplication
  function unload() {
    try {
      if (eventSource && _streamHandler) eventSource.off?.(streamEventName, _streamHandler);
      if (eventSource && _genEndHandler) eventSource.off?.(event_types.GENERATION_ENDED, _genEndHandler);
      if (eventSource && _msgRecvHandler) eventSource.off?.(event_types.MESSAGE_RECEIVED, _msgRecvHandler);
      if (eventSource && _chatChangedHandler) eventSource.off?.(event_types.CHAT_CHANGED, _chatChangedHandler);
    } catch (e) { /* hosts may not expose off(); ignore */ }
    if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
    perMessageBuffers.clear();
    lastIssuedCostume = null;
    lastTriggerTimes.clear();
    failedTriggerTimes.clear();
    recentSpeakers.length = 0;
    _clickInProgress.clear();
  }

  // call unload proactively in case of hot-reload
  try { unload(); } catch(e) {}

  // attach handlers
  try {
    eventSource.on(streamEventName, _streamHandler);
    eventSource.on(event_types.GENERATION_ENDED, _genEndHandler);
    eventSource.on(event_types.MESSAGE_RECEIVED, _msgRecvHandler);
    eventSource.on(event_types.CHAT_CHANGED, _chatChangedHandler);
  } catch (e) {
    console.error("CostumeSwitch: failed to attach event handlers:", e);
  }

  // Expose a manual unload for dev convenience (optional)
  try {
    const globalKey = `__${extensionName}_unload`;
    window[globalKey] = unload;
  } catch (e) { /* ignore */ }

  console.log("SillyTavern-CostumeSwitch (patched v4.1 — quick-window quote fix + cleanup) loaded.");
});

/* Helper: getSettingsObj copied from original but preserved for context storage lookup */
function getSettingsObj() {
  const ctx = typeof getContext === 'function' ? getContext() : (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null);
  if (ctx && ctx.extensionSettings) {
    ctx.extensionSettings[extensionName] = ctx.extensionSettings[extensionName] || structuredClone(DEFAULTS);
    for (const k of Object.keys(DEFAULTS)) {
      if (!Object.hasOwn(ctx.extensionSettings[extensionName], k)) ctx.extensionSettings[extensionName][k] = DEFAULTS[k];
    }
    return { store: ctx.extensionSettings, save: ctx.saveSettingsDebounced || saveSettingsDebounced, ctx };
  }
  if (typeof extension_settings !== 'undefined') {
    extension_settings[extensionName] = extension_settings[extensionName] || structuredClone(DEFAULTS);
    for (const k of Object.keys(DEFAULTS)) {
      if (!Object.hasOwn(extension_settings[extensionName], k)) extension_settings[extension_settings[extensionName]] = DEFAULTS[k];
    }
    return { store: extension_settings, save: saveSettingsDebounced, ctx: null };
  }
  throw new Error("Can't find SillyTavern extension settings storage.");
}
