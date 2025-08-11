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
  maxBufferChars: 2000
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

function isInsideQuotes(text, pos) {
  // keep fallback (counts double quotes) but prefer range-based checks in main code
  if (!text || pos <= 0) return false;
  const before = text.slice(0, pos);
  const quoteCount = (before.match(/["\u201C\u201D]/g) || []).length;
  return (quoteCount % 2) === 1;
}

// runtime state
const perMessageBuffers = new Map();
let lastIssuedCostume = null;
let resetTimer = null;
let lastSwitchTimestamp = 0;
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

  /* Quick-reply trigger with debugging output */
  function triggerQuickReplyVariants(costumeArg) {
    if (!costumeArg) return false;
    // base name cleaned (Kotori)
    const base = normalizeCostumeName(String(costumeArg));
    if (!base) return false;

    // candidate ordering: prefer the simplest forms first
    const rawCandidates = [
      // simplest : folder, single name, costume command variants
      `${base}`,                   // "Kotori"
      `${base}/${base}`,           // "Kotori/Kotori"
      `/costume ${base}`,          // "/costume Kotori"
      `/costume ${base}/${base}`,  // "/costume Kotori/Kotori"
      `/${base}`,                  // "/Kotori"
      String(costumeArg)           // fallback, original string user passed
    ];

    // dedupe + normalize candidates for the failedTriggerTimes key check
    const now = Date.now();
    const unique = [];
    const seen = new Set();
    for (const c of rawCandidates) {
      if (!c) continue;
      const norm = String(c).trim();
      if (!norm) continue;
      const low = norm.toLowerCase();
      if (seen.has(low)) continue;
      seen.add(low);
      unique.push(norm);
    }

    // attempt candidates in order, but skip ones in failed-trigger cooldown.
    for (const c of unique) {
      const key = c.toLowerCase(); // normalized key for failedTriggerTimes
      const lastFailed = failedTriggerTimes.get(key) || 0;
      const cooldown = (settings.failedTriggerCooldownMs || DEFAULTS.failedTriggerCooldownMs);
      if (now - lastFailed < cooldown) {
        if (settings.debug) console.debug("CS debug: skipping candidate due to failed-cooldown", { candidate: c, lastFailed, cooldown });
        continue;
      }
      if (settings.debug) console.debug("CS debug: trying candidate", c);
      if (triggerQuickReply(c)) {
        // success -> clear any previously cached failure for this normalized candidate
        failedTriggerTimes.delete(key);
        return true;
      }
      // mark failure on normalized key (so we don't try this same text again too quickly)
      failedTriggerTimes.set(key, Date.now());
      if (settings.debug) console.debug("CS debug: candidate failed, cached failedTriggerTimes key", key);
    }
    return false;
  }

  function triggerQuickReplyVariants(costumeArg) {
    if (!costumeArg) return false;
    const name = normalizeCostumeName(String(costumeArg));
    const candidates = new Set([`${name}/${name}`, `${name}`, `/costume ${name}`, `/costume ${name}/${name}`, `${name} / ${name}`, `/${name}`, String(costumeArg)]);
    const now = Date.now();
    if (settings.debug) console.debug("CS debug: triggerQuickReplyVariants candidates:", Array.from(candidates));
    for (const c of Array.from(candidates)) {
      if (!c) continue;
      const lastFailed = failedTriggerTimes.get(c) || 0;
      if (now - lastFailed < (settings.failedTriggerCooldownMs || DEFAULTS.failedTriggerCooldownMs)) {
        if (settings.debug) console.debug("CS debug: skipping candidate (cooldown):", c);
        continue;
      }
      if (triggerQuickReply(c)) {
        if (settings.debug) console.debug("CS debug: triggerQuickReplyVariants succeeded for", c);
        return true;
      }
      failedTriggerTimes.set(c, Date.now());
      if (settings.debug) console.debug("CS debug: triggerQuickReplyVariants failed for", c);
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
    if (now - lastSwitchTimestamp < (settings.globalCooldownMs || DEFAULTS.globalCooldownMs)) { if (settings.debug) console.debug("CS debug: global cooldown active, skipping", name); return; }
    const argFolder = `${name}/${name}`;
    const last = lastTriggerTimes.get(argFolder) || 0;
    if (now - last < (settings.perTriggerCooldownMs || DEFAULTS.perTriggerCooldownMs)) { if (settings.debug) console.debug("CS debug: per-trigger cooldown active, skipping", argFolder); return; }
    if (settings.debug) console.debug("CS debug: attempting switch for detected name:", name, "->", argFolder);
    const ok = triggerQuickReplyVariants(argFolder) || triggerQuickReplyVariants(name);
    if (ok) { lastTriggerTimes.set(argFolder, now); lastIssuedCostume = argFolder; lastSwitchTimestamp = now; if ($("#cs-status").length) $("#cs-status").text(`Switched -> ${argFolder}`); setTimeout(()=>$("#cs-status").text(""), 1000); }
    else { failedTriggerTimes.set(argFolder, Date.now()); if ($("#cs-status").length) $("#cs-status").text(`Quick Reply not found for ${name}`); setTimeout(()=>$("#cs-status").text(""), 1000); }
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

  eventSource.on(streamEventName, (...args) => {
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
      let matchedName = null;

      // build quote ranges once for this buffer
      const quoteRanges = getQuoteRanges(combined);

      // QUICK token-level scan (low-latency) using precomputed noG regexes
      (function quickTokenScan() {
        try {
          const short = String(tokenText || '').trim(); if (!short) return;
          // 1) speakerRegexNoG on short -> need to map index into combined
          if (speakerRegexNoG) {
            const m = speakerRegexNoG.exec(short);
            if (m && m[1]) {
              // compute index in combined (prev length + m.index)
              const posInCombined = (prev || '').length + (m.index || 0);
              if (!isIndexInsideQuotesRanges(quoteRanges, posInCombined)) { matchedName = m[1].trim(); return; }
            }
          }
          // 2) vocativeRegexNoG
          if (!matchedName && vocativeRegexNoG) {
            const m = vocativeRegexNoG.exec(short);
            if (m && m[1]) {
              const posInCombined = (prev || '').length + (m.index || 0);
              if (!isIndexInsideQuotesRanges(quoteRanges, posInCombined)) { matchedName = m[1].trim(); return; }
            }
          }
          // 3) actionRegexNoG
          if (!matchedName && actionRegexNoG) {
            const m = actionRegexNoG.exec(short);
            if (m && m[1]) {
              const posInCombined = (prev || '').length + (m.index || 0);
              if (!isIndexInsideQuotesRanges(quoteRanges, posInCombined)) { matchedName = m[1].trim(); return; }
            }
          }
          // 4) simple name-in-token scan (avoid matches inside quotes)
          if (!matchedName && settings.patterns && settings.patterns.length) {
            const names = settings.patterns.map(s => (s||'').trim()).filter(Boolean);
            if (names.length) {
              const anyNameRe = new RegExp('\\b(' + names.map(escapeRegex).join('|') + ')\\b', 'i');
              const mm = anyNameRe.exec(short);
              if (mm && mm[1]) {
                const posInCombined = (prev || '').length + (mm.index || 0);
                if (!isIndexInsideQuotesRanges(quoteRanges, posInCombined)) matchedName = mm[1].trim();
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

      // HEAVY scanning on the whole combined buffer
      try {
        // 1) speakerRegex last occurrence
        if (!matchedName && speakerRegex) {
          let lastSpeakerMatch = null;
          const sr = new RegExp(speakerRegex.source, speakerRegex.flags.includes('g') ? speakerRegex.flags : speakerRegex.flags + 'g');
          let m;
          while ((m = sr.exec(combined)) !== null) lastSpeakerMatch = m;
          if (lastSpeakerMatch) {
            const pos = lastSpeakerMatch.index || 0;
            if (!isIndexInsideQuotesRanges(quoteRanges, pos)) matchedName = lastSpeakerMatch[1]?.trim();
          }
        }

        // 2) attribution (last)
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

        // 4) vocative last occurrence
        if (!matchedName && vocativeRegex) {
          let lastV = null;
          const vr = new RegExp(vocativeRegex.source, vocativeRegex.flags.includes('g') ? vocativeRegex.flags : vocativeRegex.flags + 'g');
          let vm;
          while ((vm = vr.exec(combined)) !== null) lastV = vm;
          if (lastV) matchedName = lastV[1]?.trim();
        }

        // 5a) possessive detection including curly/grave apostrophes (e.g., Kotori’s)
        if (!matchedName && settings.patterns && settings.patterns.length) {
          const names_poss = settings.patterns.map(s => (s||'').trim()).filter(Boolean);
          if (names_poss.length) {
            const possRe = new RegExp('\\b(' + names_poss.map(escapeRegex).join('|') + ")[’'`]s\\b", 'gi');
            let lastP = null; let pm;
            while ((pm = possRe.exec(combined)) !== null) {
              if (isIndexInsideQuotesRanges(quoteRanges, pm.index)) continue;
              lastP = pm;
            }
            if (lastP) { matchedName = lastP[1].trim(); }
          }
        }

        // 5b) pronoun attribution inference
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
                const globalIdx = lookback + mm.index;
                if (isIndexInsideQuotesRanges(quoteRanges, globalIdx)) continue;
                lastMatch = mm;
              }
              if (lastMatch) { matchedName = lastMatch[1].trim(); }
            }
          }
        }

        // 5c) narration fallback
        if (!matchedName && nameRegex && settings.narrationSwitch) {
          const actionsOrPossessive = "(?:'s|’s|held|shifted|stood|sat|nodded|smiled|laughed|leaned|stepped|walked|turned|looked|moved|approached|said|asked|replied|observed|gazed|watched|beamed|frowned|sighed|remarked|added)";
          const narrationRe = new RegExp(nameRegex.source + '\\b\\s+' + actionsOrPossessive + '\\b', 'gi');
          let lastMatch = null; let mm;
          while ((mm = narrationRe.exec(combined)) !== null) {
            if (isIndexInsideQuotesRanges(quoteRanges, mm.index)) continue;
            for (let i = 1; i < mm.length; i++) if (mm[i]) { lastMatch = { name: mm[i], idx: mm.index }; break; }
          }
          if (lastMatch) { matchedName = String(lastMatch.name).replace(/-(?:sama|san)$/i, '').trim(); }
        }

        // 6) last-resort: last occurrence of any known name not in quotes
        if (!matchedName && settings.patterns && settings.patterns.length) {
          const names = settings.patterns.map(s => (s||'').trim()).filter(Boolean);
          if (names.length) {
            const anyNameRe = new RegExp('\\b(' + names.map(escapeRegex).join('|') + ')\\b', 'gi');
            let lastMatch = null; let m;
            while ((m = anyNameRe.exec(combined)) !== null) {
              if (isIndexInsideQuotesRanges(quoteRanges, m.index)) continue;
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
  });

  eventSource.on(event_types.GENERATION_ENDED, (messageId) => { if (messageId != null) perMessageBuffers.delete(`m${messageId}`); scheduleResetIfIdle(); });
  eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => { if (messageId != null) perMessageBuffers.delete(`m${messageId}`); });
  eventSource.on(event_types.CHAT_CHANGED, () => { perMessageBuffers.clear(); lastIssuedCostume = null; });

  console.log("SillyTavern-CostumeSwitch (patched v3.1) loaded.");
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
      if (!Object.hasOwn(extension_settings[extensionName], k)) extension_settings[extensionName][extensionName] = DEFAULTS[k];
    }
    return { store: extension_settings, save: saveSettingsDebounced, ctx: null };
  }
  throw new Error("Can't find SillyTavern extension settings storage.");
}

