/* SillyTavern-CostumeSwitch - Tier-A intelligent attribution
   Replaces the previous heuristic-only logic with a stateful, quote-aware,
   recent-speaker-backed attribution pipeline. Fast, in-browser, no external deps.
   - Keeps quickTokenScan + heavy scan, but uses stronger acceptance rules.
   - Adds repeat suppression and stricter "matchIndex > lastSpeakerIndex" rule.
   - Provides tryCorefResolution hook (no-op by default) for future ML integration.
*/

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

  tokenBoundarySize: 80,        // chars of prev buffer to include when quick-scanning tokens
  pronounLookbackChars: 1400,   // how far back to search for names when resolving pronouns
  repeatSuppressMs: 800,        // suppress repeated accepted matches/logs for this many ms
  sentenceFlushThreshold: 120,  // tokens/characters to force a sentence-level decision (trade latency vs accuracy)
};

// ---------- small helpers ----------
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
function buildAttributionRegex(patternList) {
  const entries = (patternList || []).map(parsePatternEntry).filter(Boolean);
  if (!entries.length) return null;
  const names = entries.map(e => `(?:${e.body})`).join('|');
  const verbs = '(?:said|asked|replied|murmured|whispered|sighed|laughed|exclaimed|noted|added|answered|shouted|cried|muttered|remarked|ordered|commanded|reported)';
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
  const actions = '(?:nodded|leaned|smiled|laughed|stood|sat|gestured|sighed|replied|said|murmured|whispered|muttered|observed|watched|turned|glanced|held|lowered|positioned|stepped|approached|walked|looked|moved|offered)';
  const body = `(?:^|\\n)\\s*(${parts.join('|')})(?:\\s+[A-Z][a-z]+)?\\b\\s+${actions}\\b`;
  const flags = computeFlagsFromEntries(entries, true);
  try { return new RegExp(body, flags); } catch (e) { console.warn("buildActionRegex compile failed:", e); return null; }
}
function buildVocativeRegex(patternList) {
  const entries = (patternList || []).map(parsePatternEntry).filter(Boolean);
  if (!entries.length) return null;
  const parts = entries.map(e => `(?:${e.body})`);
  const body = `(?:^|\\n|\\s)(${parts.join('|')})\\s*,`;
  const flags = computeFlagsFromEntries(entries, true);
  try { return new RegExp(body, flags); } catch (e) { console.warn("buildVocativeRegex compile failed:", e); return null; }
}

// Quote helpers
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
function posIsInsideQuotes(pos, combined, quoteRanges) {
  if (pos == null || !combined) return false;
  if (quoteRanges && quoteRanges.length) {
    if (isIndexInsideQuotesRanges(quoteRanges, pos)) return true;
  }
  return isInsideQuotes(combined, pos);
}
function isInsideQuotes(text, pos) {
  if (!text || pos <= 0) return false;
  const before = text.slice(0, pos);
  const quoteCount = (before.match(/["\u201C\u201D]/g) || []).length;
  return (quoteCount % 2) === 1;
}

// non-quoted match helpers
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
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return results;
}
function lastNonQuotedMatch(combined, regex, quoteRanges) {
  const ms = findNonQuotedMatches(combined, regex, quoteRanges);
  return ms.length ? ms[ms.length - 1] : null;
}

// normalize stream token text
function normalizeStreamText(s) {
  if (!s) return '';
  s = String(s);
  s = s.replace(/[\uFEFF\u200B\u200C\u200D]/g, '');
  s = s.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"');
  s = s.replace(/(\*\*|__|~~|`{1,3})/g, '');
  s = s.replace(/\u00A0/g, ' ');
  return s;
}

// clean costume name
function normalizeCostumeName(n) {
  if (!n) return "";
  let s = String(n).trim();
  if (s.startsWith("/")) s = s.slice(1).trim();
  const first = s.split(/[\/\s]+/).filter(Boolean)[0] || s;
  return String(first).replace(/[-_](?:sama|san)$/i, '').trim();
}

// ---------- runtime state ----------
const perMessageBuffers = new Map();
const perMessageStates = new Map(); // bufKey -> state object
let lastIssuedCostume = null;
let resetTimer = null;
let lastSwitchTimestamp = 0;
const lastTriggerTimes = new Map();
const failedTriggerTimes = new Map();

let _streamHandler = null;
let _genEndHandler = null;
let _msgRecvHandler = null;
let _chatChangedHandler = null;

let _clickInProgress = new Set();

const MAX_MESSAGE_BUFFERS = 60;
function ensureBufferLimit() {
  if (perMessageBuffers.size <= MAX_MESSAGE_BUFFERS) return;
  while (perMessageBuffers.size > MAX_MESSAGE_BUFFERS) {
    const firstKey = perMessageBuffers.keys().next().value;
    perMessageBuffers.delete(firstKey);
    perMessageStates.delete(firstKey);
  }
}

// recent speaker stack for simple coref fallback
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

// ---------- UI / settings wiring & main ----------

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

  // set UI defaults if present
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
  if ($("#cs-token-boundary").length) $("#cs-token-boundary").val(settings.tokenBoundarySize || DEFAULTS.tokenBoundarySize);
  if ($("#cs-pronoun-lookback").length) $("#cs-pronoun-lookback").val(settings.pronounLookbackChars || DEFAULTS.pronounLookbackChars);
  if ($("#cs-repeat-suppress").length) $("#cs-repeat-suppress").val(settings.repeatSuppressMs || DEFAULTS.repeatSuppressMs);

  $("#cs-status").text("Ready");

  function persistSettings() { if (save) save(); if (jQuery("#cs-status").length) $("#cs-status").text(`Saved ${new Date().toLocaleTimeString()}`); setTimeout(()=>jQuery("#cs-status").text(""), 1500); }

  const realCtx = ctx || (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null);
  if (!realCtx) { console.error("SillyTavern context not found. Extension won't run."); return; }
  const { eventSource, event_types, characters } = realCtx;

  // Build initial regexes
  let nameRegex = buildNameRegex(settings.patterns || DEFAULTS.patterns);
  let speakerRegex = buildSpeakerRegex(settings.patterns || DEFAULTS.patterns);
  let attributionRegex = buildAttributionRegex(settings.patterns || DEFAULTS.patterns);
  let actionRegex = buildActionRegex(settings.patterns || DEFAULTS.patterns);
  let vocativeRegex = buildVocativeRegex(settings.patterns || DEFAULTS.patterns);

  // non-global variants for quick checks
  function buildNoGVariants() {
    speakerRegexNoG = speakerRegex ? new RegExp(speakerRegex.source, flagsWithoutG(speakerRegex) || 'i') : null;
    vocativeRegexNoG = vocativeRegex ? new RegExp(vocativeRegex.source, flagsWithoutG(vocativeRegex) || 'i') : null;
    actionRegexNoG = actionRegex ? new RegExp(actionRegex.source, flagsWithoutG(actionRegex) || 'i') : null;
  }
  let speakerRegexNoG = null, vocativeRegexNoG = null, actionRegexNoG = null;
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

        const tbs = parseInt($("#cs-token-boundary").val() || DEFAULTS.tokenBoundarySize, 10);
        settings.tokenBoundarySize = isFinite(tbs) && tbs > 0 ? tbs : DEFAULTS.tokenBoundarySize;
        const pl = parseInt($("#cs-pronoun-lookback").val() || DEFAULTS.pronounLookbackChars, 10);
        settings.pronounLookbackChars = isFinite(pl) && pl > 0 ? pl : DEFAULTS.pronounLookbackChars;

        const rsp = parseInt($("#cs-repeat-suppress").val() || DEFAULTS.repeatSuppressMs, 10);
        settings.repeatSuppressMs = isFinite(rsp) && rsp >= 0 ? rsp : DEFAULTS.repeatSuppressMs;

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

  // simulate quick reply clicks
  function triggerQuickReply(labelOrMessage) {
    try {
      const label = String(labelOrMessage || '').trim();
      if (!label) return false;

      const candidates = Array.from(document.querySelectorAll('.qr--button'));

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

      if (settings.debug) console.warn(`[CostumeSwitch] Quick Reply not found: "${label}"`);
      return false;
    } catch (err) {
      console.error(`[CostumeSwitch] Error triggering Quick Reply "${labelOrMessage}":`, err);
      return false;
    }
  }

  function triggerQuickReplyVariants(costumeArg) {
    if (!costumeArg) return false;
    const name = normalizeCostumeName(String(costumeArg));
    if (!name) return false;

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

  // core function - robust, context-aware issuing
  function issueCostumeForName(name, opts = {}) {
    if (!name) return;
    name = normalizeCostumeName(name || '');
    const now = Date.now();
    const matchKind = opts.matchKind || null;

    // strong kinds that we allow to bypass global cooldown
    const strongKinds = new Set(['speaker','action','attribution','vocative','narration','pronoun-infer']);

    // early: avoid redundant switches (log suppressed)
    const currentName = normalizeCostumeName(lastIssuedCostume || settings.defaultCostume || (realCtx?.characters?.[realCtx.characterId]?.name) || '');
    if (currentName && currentName.toLowerCase() === name.toLowerCase()) {
      try {
        const stateForBuf = perMessageStates.get(opts?.bufKey) || {};
        const lastLog = stateForBuf.lastAlreadyUsingLogTs || 0;
        const now2 = Date.now();
        const suppressMs = Number(settings.repeatSuppressMs || DEFAULTS.repeatSuppressMs) || DEFAULTS.repeatSuppressMs;
        if (now2 - lastLog > suppressMs) {
          if (settings.debug) console.debug("CS debug: already using costume for", name, "- skipping switch.");
          stateForBuf.lastAlreadyUsingLogTs = now2;
          perMessageStates.set(opts?.bufKey || 'live', stateForBuf);
        }
      } catch (e) { if (settings.debug) console.debug("CS debug: already using costume (log suppressed on error)"); }
      scheduleResetIfIdle();
      return;
    }

    // global cooldown: allow bypass for strong kinds
    if (!strongKinds.has(matchKind)) {
      if (now - lastSwitchTimestamp < (settings.globalCooldownMs || DEFAULTS.globalCooldownMs)) {
        if (settings.debug) console.debug("CS debug: global cooldown active, skipping switch to", name, {
          lastSwitchTimestamp, cooldownMs: settings.globalCooldownMs || DEFAULTS.globalCooldownMs
        });
        return;
      }
    } else {
      if (settings.debug) console.debug("CS debug: strong-kind bypass attempt for", name, "kind:", matchKind);
    }

    const argFolder = `${name}/${name}`;
    const last = lastTriggerTimes.get(argFolder) || 0;
    if (now - last < (settings.perTriggerCooldownMs || DEFAULTS.perTriggerCooldownMs)) {
      if (settings.debug) console.debug("CS debug: per-trigger cooldown active, skipping", argFolder);
      return;
    }

    if (settings.debug) console.debug("CS debug: attempting switch for detected name:", name, "->", argFolder, "kind:", matchKind);
    const ok = triggerQuickReplyVariants(argFolder) || triggerQuickReplyVariants(name);
    if (ok) {
      lastTriggerTimes.set(argFolder, now);
      lastIssuedCostume = argFolder;
      lastSwitchTimestamp = now;
      pushRecentSpeaker(name);
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

  // small utility: try to run optional coref hook if provided by host (no-op by default)
  // This lets advanced users add a global function `window.tryCorefResolution(text, names)` that returns { name, confidence }
  async function tryCorefResolutionStub(text, names) {
    try {
      if (typeof window !== 'undefined' && typeof window.tryCorefResolution === 'function') {
        // ensure it's awaited if promise
        const r = await window.tryCorefResolution(text, names);
        if (r && r.name) return r;
      }
    } catch (e) {
      if (settings.debug) console.warn("CS debug: tryCorefResolution hook failed:", e);
    }
    return null;
  }
  const tryCorefResolution = tryCorefResolutionStub; // exported internal

  // -------------------------
  // STREAM HANDLER
  // -------------------------
  _streamHandler = async (...args) => {
    try {
      if (!settings.enabled) return;
      let tokenText = ""; let messageId = null;
      if (typeof args[0] === 'number') { messageId = args[0]; tokenText = String(args[1] ?? ""); }
      else if (typeof args[0] === 'string' && args.length === 1) tokenText = args[0];
      else if (args[0] && typeof args[0] === 'object') { tokenText = String(args[0].token ?? args[0].text ?? ""); messageId = args[0].messageId ?? args[1] ?? null; }
      else tokenText = String(args.join(' ') || "");
      if (!tokenText) return;

      tokenText = normalizeStreamText(tokenText);

      const bufKey = messageId != null ? `m${messageId}` : 'live';
      const prev = perMessageBuffers.get(bufKey) || "";
      const combined = (prev + tokenText).slice(- (settings.maxBufferChars || DEFAULTS.maxBufferChars));
      perMessageBuffers.set(bufKey, combined);
      ensureBufferLimit();

      if (!perMessageStates.has(bufKey)) perMessageStates.set(bufKey, {
        currentSpeaker: null,
        lastSpeakerIndex: -1,
        lastAcceptedName: null,
        lastAcceptedIndex: -1,
        lastAcceptedTs: 0,
        lastAlreadyUsingLogTs: 0,
      });
      const state = perMessageStates.get(bufKey);

      // compute quick metadata
      const quoteRanges = getQuoteRanges(combined);

      let matchedName = null;
      let matchKind = null;
      let matchIndex = -1;

      // QUICK: window scan (use non-global regex variants to avoid index drift)
      (function quickTokenScan() {
        try {
          const short = String(tokenText || '').trim();
          if (!short) return;

          const systemNoiseRe = /Event emitted:|Added\/edited expression override|Expression set|force redrawing character|Streaming in progress:|Timeout waiting for is_send_press|Invalid URI|Empty string passed to getElementById/i;
          if (systemNoiseRe.test(short)) { if (settings.debug) console.debug("CS debug: skipping system-noise token"); return; }

          const boundarySize = Number(settings.tokenBoundarySize || DEFAULTS.tokenBoundarySize) || DEFAULTS.tokenBoundarySize;
          const prevTailStart = Math.max(0, (prev || '').length - boundarySize);
          const prevTail = (prev || '').slice(prevTailStart);
          const window = prevTail + short;
          const windowOffset = prevTailStart;
          const prevLength = (prev || '').length;

          function matchOverlapsNewToken(matchIndexLocal, matchTextLen) {
            const startInCombined = windowOffset + matchIndexLocal;
            const endInCombined = startInCombined + (matchTextLen || 0);
            return endInCombined > prevLength;
          }

          const windowQuoteRanges = getQuoteRanges(window);

          // speaker: e.g., "Kotori:" or "Kotori Itsuka:"
          if (speakerRegexNoG) {
            const matches = findNonQuotedMatches(window, speakerRegexNoG, windowQuoteRanges);
            if (matches.length) {
              const m = matches[0];
              if (matchOverlapsNewToken(m.index, m.match.length)) {
                const posInCombined = windowOffset + m.index;
                if (!posIsInsideQuotes(posInCombined, combined, quoteRanges)) {
                  matchedName = m.groups && m.groups[0] ? m.groups[0].trim() : null;
                  matchKind = 'speaker';
                  matchIndex = posInCombined;
                  // update speaker marker
                  state.currentSpeaker = matchedName;
                  state.lastSpeakerIndex = matchIndex;
                  return;
                }
              } else {
                if (settings.debug) console.debug("CS debug: speakerRegex window match ignored (in prev buffer).");
              }
            }
          }

          // vocative: "Tohka, ..."
          if (!matchedName && vocativeRegexNoG) {
            const matches = findNonQuotedMatches(window, vocativeRegexNoG, windowQuoteRanges);
            if (matches.length) {
              const m = matches[0];
              if (matchOverlapsNewToken(m.index, m.match.length)) {
                const posInCombined = windowOffset + m.index;
                if (!posIsInsideQuotes(posInCombined, combined, quoteRanges)) {
                  matchedName = m.groups && m.groups[0] ? m.groups[0].trim() : null;
                  matchKind = 'vocative';
                  matchIndex = posInCombined;
                  return;
                }
              } else {
                if (settings.debug) console.debug("CS debug: vocativeRegex window match ignored (in prev buffer).");
              }
            }
          }

          // action: "Tohka leaned..."
          if (!matchedName && actionRegexNoG) {
            const matches = findNonQuotedMatches(window, actionRegexNoG, windowQuoteRanges);
            if (matches.length) {
              const m = matches[0];
              if (matchOverlapsNewToken(m.index, m.match.length)) {
                const posInCombined = windowOffset + m.index;
                if (!posIsInsideQuotes(posInCombined, combined, quoteRanges)) {
                  matchedName = m.groups && m.groups[0] ? m.groups[0].trim() : null;
                  matchKind = 'action';
                  matchIndex = posInCombined;
                  return;
                }
              } else {
                if (settings.debug) console.debug("CS debug: actionRegex window match ignored (in prev buffer).");
              }
            }
          }

          // simple name in window (small chance)
          if (!matchedName && settings.patterns && settings.patterns.length) {
            const names = settings.patterns.map(s => (s||'').trim()).filter(Boolean);
            if (names.length) {
              const anyNameRe = new RegExp('\\b(' + names.map(escapeRegex).join('|') + ')\\b', 'i');
              const matches = findNonQuotedMatches(window, anyNameRe, windowQuoteRanges);
              if (matches.length) {
                for (const mm of matches) {
                  if (!matchOverlapsNewToken(mm.index, mm.match.length)) continue;
                  const posInCombined = windowOffset + mm.index;
                  if (!posIsInsideQuotes(posInCombined, combined, quoteRanges)) {
                    matchedName = (mm.groups && mm.groups[0]) ? mm.groups[0].trim() : mm.match;
                    matchKind = 'name';
                    matchIndex = posInCombined;
                    break;
                  }
                }
              }
            }
          }
        } catch (e) { if (settings.debug) console.warn("quickTokenScan error", e); }
      })();

      // quick suppress/accept logic
      if (matchedName) {
        const nowT = Date.now();
        const suppressMs = Number(settings.repeatSuppressMs || DEFAULTS.repeatSuppressMs) || DEFAULTS.repeatSuppressMs;
        if (typeof matchIndex === 'number' && matchIndex <= (state.lastAcceptedIndex || -1)) {
          if (settings.debug) console.debug('CS debug: skipping quick matched occurrence because matchIndex <= lastAcceptedIndex', { matchedName, matchIndex, lastAcceptedIndex: state.lastAcceptedIndex });
          matchedName = null;
        }
        if (matchedName && state.lastAcceptedName && state.lastAcceptedName.toLowerCase() === matchedName.toLowerCase() && (nowT - (state.lastAcceptedTs || 0) < suppressMs)) {
          if (settings.debug) console.debug('CS debug: suppressing quick repeat accepted match for same name', { matchedName });
          matchedName = null;
        }
        // if a different current speaker exists, only accept strong kinds and require matchIndex > lastSpeakerIndex
        if (matchedName && state.currentSpeaker && state.currentSpeaker.toLowerCase() !== matchedName.toLowerCase()) {
          const strongKinds = new Set(['action','speaker','attribution','vocative','narration','pronoun-infer']);
          if (!strongKinds.has(matchKind)) {
            if (settings.debug) console.debug("CS debug: suppressed quick-scan match because different currentSpeaker present", { curSpeaker: state.currentSpeaker, matchedName, matchKind });
            matchedName = null;
          } else {
            if (typeof matchIndex === 'number' && typeof state.lastSpeakerIndex === 'number' && matchIndex <= state.lastSpeakerIndex) {
              if (settings.debug) console.debug("CS debug: suppressed quick strong match due to matchIndex <= lastSpeakerIndex", { matchedName, matchIndex, lastSpeakerIndex: state.lastSpeakerIndex });
              matchedName = null;
            }
          }
        }
      }

      if (matchedName) {
        // record acceptance and switch
        const now2 = Date.now();
        state.lastAcceptedName = matchedName;
        state.lastAcceptedIndex = (typeof matchIndex === 'number') ? matchIndex : (state.lastAcceptedIndex || -1);
        state.lastAcceptedTs = now2;
        perMessageStates.set(bufKey, state);

        issueCostumeForName(matchedName, { matchKind, matchIndex, bufKey });
        scheduleResetIfIdle();
        try {
          const idx = (combined || '').toLowerCase().lastIndexOf(matchedName.toLowerCase());
          if (idx >= 0) perMessageBuffers.set(bufKey, (combined || '').slice(idx + matchedName.length));
          else perMessageBuffers.set(bufKey, '');
        } catch (e) { perMessageBuffers.set(bufKey, ''); }
        return;
      }

      // HEAVY scan: sentence-level & quote-aware attribution
      try {
        // sentence splitting (simple): split by newline or punctuation while keeping offsets
        // We'll search for last few sentences because attribution should be local
        const text = combined || '';
        // We'll analyze the last 1600 chars to keep it fast/targeted
        const analysisWindow = text.slice(-2000);
        const analysisOffset = text.length - analysisWindow.length;
        const qRanges = getQuoteRanges(analysisWindow);

        // 1) try explicit speaker labels (global, not-in-quote)
        if (speakerRegex) {
          const lastSpeaker = lastNonQuotedMatch(analysisWindow, speakerRegex, qRanges);
          if (lastSpeaker) {
            matchedName = lastSpeaker.groups && lastSpeaker.groups[0] ? lastSpeaker.groups[0].trim() : null;
            matchKind = 'speaker';
            matchIndex = (lastSpeaker.index || 0) + analysisOffset;
            if (matchedName) {
              state.currentSpeaker = matchedName;
              state.lastSpeakerIndex = matchIndex;
              perMessageStates.set(bufKey, state);
            }
          }
        }

        // 2) attribution (quote then speaker, or Name said ...)
        if (!matchedName && attributionRegex) {
          const lastA = lastNonQuotedMatch(analysisWindow, attributionRegex, qRanges);
          if (lastA) {
            if (lastA.groups && lastA.groups.length) {
              for (const g of lastA.groups) {
                if (g) { matchedName = g.trim(); matchKind = 'attribution'; matchIndex = (lastA.index || 0) + analysisOffset; break; }
              }
            }
          }
        }

        // 3) action pattern
        if (!matchedName && actionRegex) {
          const lastAct = lastNonQuotedMatch(analysisWindow, actionRegex, qRanges);
          if (lastAct && lastAct.groups && lastAct.groups.length) {
            matchedName = lastAct.groups[0].trim();
            matchKind = 'action';
            matchIndex = (lastAct.index || 0) + analysisOffset;
          }
        }

        // 4) vocative
        if (!matchedName && vocativeRegex) {
          const lastV = lastNonQuotedMatch(analysisWindow, vocativeRegex, qRanges);
          if (lastV && lastV.groups && lastV.groups.length) {
            matchedName = lastV.groups[0].trim();
            matchKind = 'vocative';
            matchIndex = (lastV.index || 0) + analysisOffset;
          }
        }

        // 5) possessive "Tohka's ..." detection
        if (!matchedName && settings.patterns && settings.patterns.length) {
          const names_poss = settings.patterns.map(s => (s||'').trim()).filter(Boolean);
          if (names_poss.length) {
            const possRe = new RegExp('\\b(' + names_poss.map(escapeRegex).join('|') + ")[’'`]s\\b", 'gi');
            const lastP = lastNonQuotedMatch(analysisWindow, possRe, qRanges);
            if (lastP && lastP.groups && lastP.groups.length) {
              matchedName = lastP.groups[0].trim();
              matchKind = 'possessive';
              matchIndex = (lastP.index || 0) + analysisOffset;
            }
          }
        }

        // 6) pronoun inference with lookback
        if (!matchedName && settings.patterns && settings.patterns.length) {
          const pronARe = /["\u201C\u201D][^"\u201C\u201D]{0,400}["\u201C\u201D]\s*,?\s*(?:he|she|they)\s+(?:said|murmured|whispered|replied|asked|noted|added|sighed|laughed|exclaimed)/i;
          const pM = pronARe.exec(analysisWindow);
          if (pM) {
            // check recent speakers stack first
            const chosenFromStack = getMostRecentSpeakerBefore();
            if (chosenFromStack) {
              matchedName = chosenFromStack;
              matchKind = 'pronoun-infer';
              matchIndex = (pM.index || 0) + analysisOffset;
            } else {
              const cutIndex = pM.index || 0;
              const lookback = Math.max(0, cutIndex - (settings.pronounLookbackChars || DEFAULTS.pronounLookbackChars));
              const sub = analysisWindow.slice(lookback, cutIndex);
              const names_pron = settings.patterns.map(s => (s||'').trim()).filter(Boolean);
              if (names_pron.length) {
                const anyNameRe = new RegExp('\\b(' + names_pron.map(escapeRegex).join('|') + ')\\b', 'gi');
                const lastMatch = lastNonQuotedMatch(sub, anyNameRe, getQuoteRanges(sub));
                if (lastMatch && lastMatch.groups && lastMatch.groups.length) {
                  matchedName = lastMatch.groups[0].trim();
                  matchKind = 'pronoun-infer';
                  matchIndex = lookback + (lastMatch.index || 0) + analysisOffset;
                } else {
                  // try optional coref hook (user may provide a window.tryCorefResolution)
                  const hook = await tryCorefResolution(analysisWindow, settings.patterns || DEFAULTS.patterns);
                  if (hook && hook.name) {
                    matchedName = hook.name;
                    matchKind = 'pronoun-infer';
                    matchIndex = (pM.index || 0) + analysisOffset;
                    if (settings.debug) console.debug("CS debug: tryCorefResolution returned:", hook);
                  }
                }
              }
            }
          }
        }

        // 7) narration fallback if enabled
        if (!matchedName && nameRegex && settings.narrationSwitch) {
          const actionsOrPossessive = "(?:'s|’s|held|shifted|stood|sat|nodded|smiled|laughed|leaned|stepped|walked|turned|looked|moved|approached|said|asked|replied|observed|gazed|watched|beamed|frowned|sighed|remarked|added|offered)";
          const narrationRe = new RegExp(nameRegex.source + '\\b\\s+' + actionsOrPossessive + '\\b', 'gi');
          const lastMatch = lastNonQuotedMatch(analysisWindow, narrationRe, qRanges);
          if (lastMatch && lastMatch.groups && lastMatch.groups.length) {
            matchedName = String(lastMatch.groups[0] || lastMatch.match).replace(/-(?:sama|san)$/i, '').trim();
            matchKind = 'narration';
            matchIndex = (lastMatch.index || 0) + analysisOffset;
          }
        }

        // 8) last-resort: last non-quoted occurrence of any known name
        if (!matchedName && settings.patterns && settings.patterns.length) {
          const names = settings.patterns.map(s => (s||'').trim()).filter(Boolean);
          if (names.length) {
            const anyNameRe = new RegExp('\\b(' + names.map(escapeRegex).join('|') + ')\\b', 'gi');
            const lastMatch = lastNonQuotedMatch(analysisWindow, anyNameRe, qRanges);
            if (lastMatch && lastMatch.groups && lastMatch.groups.length) {
              matchedName = String(lastMatch.groups[0] || lastMatch.match).replace(/-(?:sama|san)$/i, '').trim();
              matchKind = 'name';
              matchIndex = (lastMatch.index || 0) + analysisOffset;
            }
          }
        }

        // Heuristic: if we found candidate, apply stricter acceptance rules
        if (matchedName) {
          const nowT = Date.now();
          const suppressMs = Number(settings.repeatSuppressMs || DEFAULTS.repeatSuppressMs) || DEFAULTS.repeatSuppressMs;

          // skip if same or older occurrence already accepted
          if (typeof matchIndex === 'number' && matchIndex <= (state.lastAcceptedIndex || -1)) {
            if (settings.debug) console.debug('CS debug: heavy-scan skipping because matchIndex <= lastAcceptedIndex', { matchedName, matchIndex, lastAcceptedIndex: state.lastAcceptedIndex });
            matchedName = null;
          }

          // skip if same name accepted recently
          if (matchedName && state.lastAcceptedName && state.lastAcceptedName.toLowerCase() === matchedName.toLowerCase() && (nowT - (state.lastAcceptedTs || 0) < suppressMs)) {
            if (settings.debug) console.debug('CS debug: heavy-scan suppressing repeat accepted match for same name', { matchedName });
            matchedName = null;
          }

          // if different currentSpeaker exists, require strong kinds and occurrence after lastSpeakerIndex
          if (matchedName && state.currentSpeaker && state.currentSpeaker.toLowerCase() !== matchedName.toLowerCase()) {
            const strongKinds = new Set(['action','speaker','attribution','vocative','narration','pronoun-infer']);
            if (!strongKinds.has(matchKind)) {
              if (settings.debug) console.debug("CS debug: heavy-scan suppressed because different currentSpeaker present", { curSpeaker: state.currentSpeaker, matchedName, matchKind });
              matchedName = null;
            } else {
              if (typeof matchIndex === 'number' && typeof state.lastSpeakerIndex === 'number' && matchIndex <= state.lastSpeakerIndex) {
                if (settings.debug) console.debug("CS debug: heavy-scan suppressed strong kind due to stale matchIndex", { matchedName, matchIndex, lastSpeakerIndex: state.lastSpeakerIndex });
                matchedName = null;
              }
            }
          }
        }
      } catch (e) {
        if (settings.debug) console.error("Heavy scan error:", e);
      }

      // Accept heavy-scan match if present
      if (matchedName) {
        const now3 = Date.now();
        state.lastAcceptedName = matchedName;
        state.lastAcceptedIndex = (typeof matchIndex === 'number') ? matchIndex : (state.lastAcceptedIndex || -1);
        state.lastAcceptedTs = now3;
        perMessageStates.set(bufKey, state);

        issueCostumeForName(matchedName, { matchKind, matchIndex, bufKey });
        scheduleResetIfIdle();
        try {
          const idx = (combined || '').toLowerCase().lastIndexOf(matchedName.toLowerCase());
          if (idx >= 0) perMessageBuffers.set(bufKey, (combined || '').slice(idx + matchedName.length));
          else perMessageBuffers.set(bufKey, '');
        } catch (e) { perMessageBuffers.set(bufKey, ''); }
      }

      if (settings.debug) console.debug("CS debug stream snapshot", { bufKey, recent: combined.slice(-400), matchedName, matchKind, state: perMessageStates.get(bufKey) });

    } catch (err) { console.error("CostumeSwitch stream handler error:", err); }
  };

  // -------------------------
  // EVENT HANDLERS
  // -------------------------
  _genEndHandler = (messageId) => { if (messageId != null) { perMessageBuffers.delete(`m${messageId}`); perMessageStates.delete(`m${messageId}`); } scheduleResetIfIdle(); };
  _msgRecvHandler = (messageId) => { if (messageId != null) { perMessageBuffers.delete(`m${messageId}`); perMessageStates.delete(`m${messageId}`); } };
  _chatChangedHandler = () => { perMessageBuffers.clear(); perMessageStates.clear(); lastIssuedCostume = null; recentSpeakers.length = 0; };

  function unload() {
    try {
      if (eventSource && _streamHandler) eventSource.off?.(streamEventName, _streamHandler);
      if (eventSource && _genEndHandler) eventSource.off?.(event_types.GENERATION_ENDED, _genEndHandler);
      if (eventSource && _msgRecvHandler) eventSource.off?.(event_types.MESSAGE_RECEIVED, _msgRecvHandler);
      if (eventSource && _chatChangedHandler) eventSource.off?.(event_types.CHAT_CHANGED, _chatChangedHandler);
    } catch (e) { /* ignore */ }
    if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
    perMessageBuffers.clear();
    perMessageStates.clear();
    lastIssuedCostume = null;
    lastTriggerTimes.clear();
    failedTriggerTimes.clear();
    recentSpeakers.length = 0;
    _clickInProgress.clear();
  }

  // hot-reload safe
  try { unload(); } catch (e) {}

  try {
    eventSource.on(streamEventName, _streamHandler);
    eventSource.on(event_types.GENERATION_ENDED, _genEndHandler);
    eventSource.on(event_types.MESSAGE_RECEIVED, _msgRecvHandler);
    eventSource.on(event_types.CHAT_CHANGED, _chatChangedHandler);
  } catch (e) {
    console.error("CostumeSwitch: failed to attach event handlers:", e);
  }

  try { window[`__${extensionName}_unload`] = unload; } catch(e) {}

  console.log("SillyTavern-CostumeSwitch (Tier-A intelligent attribution) loaded.");
});

// ---------- small helpers used above ----------
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
function flagsWithoutG(regex) {
  if (!regex) return '';
  return (regex.flags || '').replace(/g/g, '');
}

// ---------- settings storage helper ----------
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
      if (!Object.hasOwn(extension_settings[extensionName], k)) extension_settings[extensionName][k] = DEFAULTS[k];
    }
    return { store: extension_settings, save: saveSettingsDebounced, ctx: null };
  }
  throw new Error("Can't find SillyTavern extension settings storage.");
}
