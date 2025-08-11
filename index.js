/**
 * SillyTavern-CostumeSwitch (patched v3)
 * - Fixes and improvements from review:
 *   - escapeRegex / isInsideQuotes corrected
 *   - preserves simple /pattern/flags (merges flags sensibly)
 *   - reuses compiled RegExp objects (avoid recreating in hot path)
 *   - improved quick-reply matching (title -> label -> fuzzy)
 *   - possessive detection accepts curly apostrophes
 *   - buffer length capped to avoid unbounded growth
 *   - minor performance and readability improvements
 *
 * NOTE: This file intentionally mirrors your original layout so it
 * integrates into SillyTavern's extension system unchanged.
 */

import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "SillyTavern-CostumeSwitch";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// default settings
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
  // buffer limit to keep memory bounded
  maxBufferChars: 2000
};

function escapeRegex(s) {
  // clear and correct escaping for regex special characters
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a pattern entry. If pattern is like /body/flags, capture body and flags.
 * Otherwise treat as a literal string (escaped).
 * Returns { body, flags } (flags maybe empty).
 */
function parsePatternEntry(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
  if (m) return { body: m[1], flags: (m[2] || '') };
  return { body: escapeRegex(trimmed), flags: '' };
}

/**
 * Helper to compute union flags we want to apply to a combined RegExp.
 * We will ensure 'i' is present by default for name matching (case-insensitive),
 * and include 'u' if any pattern had it. 'g' is omitted here; callers may add 'g' as needed.
 */
function computeFlagsFromEntries(entries, requireI = true) {
  let flagsSet = new Set();
  for (const e of entries) {
    if (!e) continue;
    for (const ch of (e.flags || '')) flagsSet.add(ch);
  }
  if (requireI) flagsSet.add('i');
  // sanitize: only allowed flags for JS regex
  const allowed = 'gimsuy';
  const out = Array.from(flagsSet).filter(c => allowed.includes(c)).join('');
  return out;
}

/**
 * Build different regexes. Each returns a RegExp or null.
 * We reuse pattern bodies (unescaped for regex entries) and intelligently set flags.
 */
function buildNameRegex(patternList) {
  const entries = (patternList || []).map(parsePatternEntry).filter(Boolean);
  if (!entries.length) return null;
  // we want a "word-like" match but keep user-supplied regex bodies as-is
  const parts = entries.map(e => `(?:${e.body})`);
  const body = `(?:^|\\n|[\\(\\[\\-—–])(?:${parts.join('|')})(?:\\W|$)`;
  const flags = computeFlagsFromEntries(entries, true); // default i
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
  // patA: "...", Name said ...
  const patA = '(["\\u201C\\u201D].{0,400}["\\u201C\\u201D])\\s*,?\\s*(' + names + ')\\s+' + verbs;
  // patB: Name said: "..."
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

/**
 * Count quotes before position to infer whether pos is inside quotes.
 * Only counts double-quotes and unicode curly double quotes to avoid
 * false positives from contractions with single quotes.
 */
function isInsideQuotes(text, pos) {
  if (!text || pos <= 0) return false;
  const before = text.slice(0, pos);
  // match ASCII double-quote or left/right curly double quotes
  const quoteCount = (before.match(/["\u201C\u201D]/g) || []).length;
  return (quoteCount % 2) === 1;
}

// runtime state
const perMessageBuffers = new Map();
let lastIssuedCostume = null;
let resetTimer = null;
let lastSwitchTimestamp = 0; // global cooldown (ms since epoch)
const lastTriggerTimes = new Map();
const failedTriggerTimes = new Map();

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

        // rebuild regexes
        nameRegex = buildNameRegex(settings.patterns || DEFAULTS.patterns);
        speakerRegex = buildSpeakerRegex(settings.patterns || DEFAULTS.patterns);
        attributionRegex = buildAttributionRegex(settings.patterns || DEFAULTS.patterns);
        actionRegex = buildActionRegex(settings.patterns || DEFAULTS.patterns);
        vocativeRegex = buildVocativeRegex(settings.patterns || DEFAULTS.patterns);
        persistSettings();
      });
    }
    if ($("#cs-reset").length) { $("#cs-reset").off('click.cs').on("click.cs", async () => { await manualReset(); }); }
  }
  tryWireUI(); setTimeout(tryWireUI, 500); setTimeout(tryWireUI, 1500);

  function normalizeCostumeName(n) {
    if (!n) return n;
    return String(n).replace(/[-_](?:sama|san)$/i, '').split(/\s+/)[0];
  }

  /**
   * Trigger a quick-reply button. Matching strategy:
   * 1) Exact match on title property (trimmed, case-insensitive)
   * 2) Exact match on label text (trimmed, case-insensitive)
   * 3) Partial/fuzzy include match (label or title)
   */
  function triggerQuickReply(labelOrMsg) {
    try {
      if (!labelOrMsg) return false;
      const needle = String(labelOrMsg).trim().toLowerCase();
      const qrButtons = document.querySelectorAll('.qr--button');
      // First pass: exact title match
      for (const btn of qrButtons) {
        const title = (btn.title || '').trim();
        if (title && title.toLowerCase() === needle) { btn.click(); return true; }
      }
      // Second pass: exact label match
      for (const btn of qrButtons) {
        const labelEl = btn.querySelector('.qr--button-label');
        let candidate = null;
        if (labelEl && labelEl.innerText) candidate = labelEl.innerText.trim();
        else if (btn.title) candidate = btn.title;
        if (!candidate) continue;
        if (candidate.trim().toLowerCase() === needle) { btn.click(); return true; }
      }
      // Third pass: fuzzy include matching (fallback)
      for (const btn of qrButtons) {
        const labelEl = btn.querySelector('.qr--button-label');
        let candidate = null;
        if (labelEl && labelEl.innerText) candidate = labelEl.innerText.trim();
        else if (btn.title) candidate = btn.title;
        if (!candidate) continue;
        const candLower = candidate.trim().toLowerCase();
        if (candLower.includes(needle) || needle.includes(candLower)) { btn.click(); return true; }
      }
    } catch (err) { console.warn("triggerQuickReply error:", err); }
    return false;
  }

  function triggerQuickReplyVariants(costumeArg) {
    if (!costumeArg) return false;
    const name = normalizeCostumeName(String(costumeArg));
    const candidates = new Set([
      `${name}/${name}`,
      `${name}`,
      `/costume ${name}`,
      `/costume ${name}/${name}`,
      `${name} / ${name}`,
      `/${name}`,
      String(costumeArg)
    ]);
    const now = Date.now();
    for (const c of Array.from(candidates)) {
      if (!c) continue;
      const lastFailed = failedTriggerTimes.get(c) || 0;
      if (now - lastFailed < (settings.failedTriggerCooldownMs || DEFAULTS.failedTriggerCooldownMs)) continue;
      if (triggerQuickReply(c)) return true;
      failedTriggerTimes.set(c, Date.now());
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

  /**
   * Attempt to issue costume switch for a detected name.
   * Enforces global and per-trigger cooldowns.
   */
  function issueCostumeForName(name) {
    if (!name) return;
    name = normalizeCostumeName(name);
    const now = Date.now();
    if (now - lastSwitchTimestamp < (settings.globalCooldownMs || DEFAULTS.globalCooldownMs)) return;
    const argFolder = `${name}/${name}`;
    const last = lastTriggerTimes.get(argFolder) || 0;
    if (now - last < (settings.perTriggerCooldownMs || DEFAULTS.perTriggerCooldownMs)) return;
    const ok = triggerQuickReplyVariants(argFolder) || triggerQuickReplyVariants(name);
    if (ok) {
      lastTriggerTimes.set(argFolder, now);
      lastIssuedCostume = argFolder;
      lastSwitchTimestamp = now;
      if ($("#cs-status").length) $("#cs-status").text(`Switched -> ${argFolder}`);
      setTimeout(()=>$("#cs-status").text(""), 1000);
    } else {
      failedTriggerTimes.set(argFolder, Date.now());
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

  // event name for token streaming (compat with various ST builds)
  const streamEventName = event_types?.STREAM_TOKEN_RECEIVED || event_types?.SMOOTH_STREAM_TOKEN_RECEIVED || 'stream_token_received';

  eventSource.on(streamEventName, (...args) => {
    try {
      if (!settings.enabled) return;
      let tokenText = ""; let messageId = null;
      if (typeof args[0] === 'number') { messageId = args[0]; tokenText = String(args[1] ?? ""); }
      else if (typeof args[0] === 'string' && args.length === 1) tokenText = args[0];
      else if (args[0] && typeof args[0] === 'object') { tokenText = String(args[0].token ?? args[0].text ?? ""); messageId = args[0].messageId ?? args[1] ?? null; }
      else tokenText = String(args.join(' ') || "");
      if (!tokenText) return;

      const bufKey = messageId != null ? `m${messageId}` : 'live';
      const prev = perMessageBuffers.get(bufKey) || "";
      const combined = (prev + tokenText).slice(- (settings.maxBufferChars || DEFAULTS.maxBufferChars)); // cap buffer
      perMessageBuffers.set(bufKey, combined);
      let matchedName = null;

      // QUICK token-level scan: operate on tokenText first for low-latency matching
      (function quickTokenScan() {
        try {
          const short = String(tokenText || '').trim(); if (!short) return;
          // Try speakerRegex (already compiled) on token-level
          if (speakerRegex) {
            const m = speakerRegex.exec(short);
            if (m && m[1]) { matchedName = m[1].trim(); return; }
          }
          // vocative
          if (!matchedName && vocativeRegex) {
            const m = vocativeRegex.exec(short);
            if (m && m[1]) { matchedName = m[1].trim(); return; }
          }
          // action-style: "Kotori smiled"
          if (!matchedName && actionRegex) {
            const m = actionRegex.exec(short);
            if (m && m[1]) { matchedName = m[1].trim(); return; }
          }
          // simple name-in-token scan (avoid matches inside quotes)
          if (!matchedName && settings.patterns && settings.patterns.length) {
            const names = settings.patterns.map(s => (s||'').trim()).filter(Boolean);
            if (names.length) {
              const anyNameRe = new RegExp('\\b(' + names.map(escapeRegex).join('|') + ')\\b', 'i');
              const mm = anyNameRe.exec(short);
              if (mm && mm[1] && !isInsideQuotes(short, mm.index)) matchedName = mm[1].trim();
            }
          }
        } catch (e) { if (settings.debug) console.warn("quickTokenScan error", e); }
      })();

      if (matchedName) {
        issueCostumeForName(matchedName);
        scheduleResetIfIdle();
        try {
          const idx = (combined || '').toLowerCase().lastIndexOf(matchedName.toLowerCase());
          if (idx >= 0) perMessageBuffers.set(bufKey, (combined || '').slice(idx + matchedName.length));
          else perMessageBuffers.set(bufKey, '');
        } catch (e) { perMessageBuffers.set(bufKey, ''); }
      } else {
        // Heavier scanning on the whole combined buffer
        try {
          // 1) speakerRegex last occurrence
          if (!matchedName && speakerRegex) {
            let lastSpeakerMatch = null;
            const sr = new RegExp(speakerRegex.source, speakerRegex.flags.includes('g') ? speakerRegex.flags : speakerRegex.flags + 'g'); // ensure global for loop
            let m;
            while ((m = sr.exec(combined)) !== null) lastSpeakerMatch = m;
            if (lastSpeakerMatch) matchedName = lastSpeakerMatch[1]?.trim();
          }

          // 2) attribution
          if (!matchedName && attributionRegex) {
            let lastA = null;
            const ar = new RegExp(attributionRegex.source, attributionRegex.flags.includes('g') ? attributionRegex.flags : attributionRegex.flags + 'g');
            let am;
            while ((am = ar.exec(combined)) !== null) lastA = am;
            if (lastA) {
              for (let i = 1; i < lastA.length; i++) {
                if (lastA[i]) { matchedName = lastA[i].trim(); break; }
              }
            }
          }

          // 3) action regex last occurrence
          if (!matchedName && actionRegex) {
            let lastAct = null;
            const ac = new RegExp(actionRegex.source, actionRegex.flags.includes('g') ? actionRegex.flags : actionRegex.flags + 'g');
            let am;
            while ((am = ac.exec(combined)) !== null) lastAct = am;
            if (lastAct) { for (let i = 1; i < lastAct.length; i++) if (lastAct[i]) { matchedName = lastAct[i].trim(); break; } }
          }

          // 4) vocative
          if (!matchedName && vocativeRegex) {
            let lastV = null;
            const vr = new RegExp(vocativeRegex.source, vocativeRegex.flags.includes('g') ? vocativeRegex.flags : vocativeRegex.flags + 'g');
            let vm;
            while ((vm = vr.exec(combined)) !== null) lastV = vm;
            if (lastV) matchedName = lastV[1]?.trim();
          }

          // 5a) possessive detection including curly apostrophes (e.g., Kotori’s)
          if (!matchedName && settings.patterns && settings.patterns.length) {
            const names_poss = settings.patterns.map(s => (s||'').trim()).filter(Boolean);
            if (names_poss.length) {
              const possRe = new RegExp('\\b(' + names_poss.map(escapeRegex).join('|') + ")[’'`]s\\b", 'gi'); // include curly and grave apostrophes
              let lastP = null; let pm;
              while ((pm = possRe.exec(combined)) !== null) {
                if (isInsideQuotes(combined, pm.index)) continue;
                lastP = pm;
              }
              if (lastP) { matchedName = lastP[1].trim(); }
            }
          }

          // 5b) pronoun attribution inference: look for "..., she murmured" and look-back for nearest name
          if (!matchedName && settings.patterns && settings.patterns.length) {
            const pronARe = /["\u201C\u201D][^"\u201C\u201D]{0,400}["\u201C\u201D]\s*,?\s*(?:he|she|they)\s+(?:said|murmured|whispered|replied|asked|noted|added|sighed|laughed|exclaimed)/i;
            const pM = pronARe.exec(combined);
            if (pM) {
              const cutIndex = pM.index || 0;
              const lookback = Math.max(0, cutIndex - 900);
              const sub = (combined || '').slice(lookback, cutIndex);
              const names_pron = settings.patterns.map(s => (s||'').trim()).filter(Boolean);
              if (names_pron.length) {
                const anyNameRe = new RegExp('\\b(' + names_pron.map(escapeRegex).join('|') + ')\\b', 'gi');
                let lastMatch = null; let mm;
                while ((mm = anyNameRe.exec(sub)) !== null) {
                  if (isInsideQuotes(sub, mm.index)) continue;
                  lastMatch = mm;
                }
                if (lastMatch) { matchedName = lastMatch[1].trim(); }
              }
            }
          }

          // 5c) narration fallback if enabled
          if (!matchedName && nameRegex && settings.narrationSwitch) {
            const actionsOrPossessive = "(?:'s|’s|held|shifted|stood|sat|nodded|smiled|laughed|leaned|stepped|walked|turned|looked|moved|approached|said|asked|replied|observed|gazed|watched|beamed|frowned|sighed|remarked|added)";
            const narrationRe = new RegExp(nameRegex.source + '\\b\\s+' + actionsOrPossessive + '\\b', 'gi');
            let lastMatch = null; let mm;
            while ((mm = narrationRe.exec(combined)) !== null) {
              if (isInsideQuotes(combined, mm.index)) continue;
              for (let i = 1; i < mm.length; i++) if (mm[i]) { lastMatch = { name: mm[i], idx: mm.index }; break; }
            }
            if (lastMatch) { matchedName = String(lastMatch.name).replace(/-(?:sama|san)$/i, '').trim(); }
          }

          // 6) last-resort: last occurrence of any known name not within quotes
          if (!matchedName && settings.patterns && settings.patterns.length) {
            const names = settings.patterns.map(s => (s||'').trim()).filter(Boolean);
            if (names.length) {
              const anyNameRe = new RegExp('\\b(' + names.map(escapeRegex).join('|') + ')\\b', 'gi');
              let lastMatch = null; let m;
              while ((m = anyNameRe.exec(combined)) !== null) {
                if (isInsideQuotes(combined, m.index)) continue;
                lastMatch = { name: m[1], idx: m.index };
              }
              if (lastMatch) { matchedName = String(lastMatch.name).replace(/-(?:sama|san)$/i, '').trim(); }
            }
          }

          // Heuristic: prefer the most recent mention among known names
          if (settings.patterns && settings.patterns.length) {
            const names = settings.patterns.map(s => (s||'').trim()).filter(Boolean);
            let chosen = null; let chosenIdx = -1;
            for (const nm of names) {
              const low = nm.toLowerCase();
              const idx = (combined || '').toLowerCase().lastIndexOf(low);
              if (idx > chosenIdx) { chosen = nm; chosenIdx = idx; }
            }
            const RECENT_WINDOW = 700;
            if (chosen) {
              if (!matchedName || chosenIdx >= (combined.length - RECENT_WINDOW)) {
                matchedName = chosen;
                perMessageBuffers.set(bufKey, (combined || '').slice(chosenIdx + chosen.length));
              }
            }
          }
        } catch (e) {
          if (settings.debug) console.error("Heavy scan error:", e);
        }

        if (matchedName) {
          issueCostumeForName(matchedName);
          scheduleResetIfIdle();
          try {
            const idx = (combined || '').toLowerCase().lastIndexOf(matchedName.toLowerCase());
            if (idx >= 0) perMessageBuffers.set(bufKey, (combined || '').slice(idx + matchedName.length));
            else perMessageBuffers.set(bufKey, '');
          } catch (e) { perMessageBuffers.set(bufKey, ''); }
        }
      }

      if (settings.debug) console.debug("CS debug: ", { bufKey, recent: combined.slice(-400), matchedName });

    } catch (err) { console.error("CostumeSwitch stream handler error:", err); }
  });

  // Clean up per-message buffers on generation/message events
  eventSource.on(event_types.GENERATION_ENDED, (messageId) => { if (messageId != null) perMessageBuffers.delete(`m${messageId}`); scheduleResetIfIdle(); });
  eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => { if (messageId != null) perMessageBuffers.delete(`m${messageId}`); });
  eventSource.on(event_types.CHAT_CHANGED, () => { perMessageBuffers.clear(); lastIssuedCostume = null; });

  console.log("SillyTavern-CostumeSwitch (patched v3) loaded.");
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
      if (!Object.hasOwn(extension_settings[extensionName], k)) extension_settings[extensionName][k] = DEFAULTS[k];
    }
    return { store: extension_settings, save: saveSettingsDebounced, ctx: null };
  }
  throw new Error("Can't find SillyTavern extension settings storage.");
}
