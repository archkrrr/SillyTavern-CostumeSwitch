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
  repeatSuppressMs: 800
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

/* Build regexes */
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
  const patB = '\\b(' + names + ')\\s+' + verbs + '\\s*[:,]?\\s*["\\u201C\\u201D]';
  const body = `(?:${patA})|(?:${patB})`;
  const flags = computeFlagsFromEntries(entries, true);
  try { return new RegExp(body, flags); } catch (e) { console.warn("buildAttributionRegex compile failed:", e); return null; }
}
function buildActionRegex(patternList) {
  const entries = (patternList || []).map(parsePatternEntry).filter(Boolean);
  if (!entries.length) return null;
  const parts = entries.map(e => `(?:${e.body})`);
  const actions = '(?:nodded|leaned|smiled|laughed|stood|sat|gestured|sighed|replied|said|murmured|whispered|muttered|observed|watched|turned|glanced|held|lowered|positioned|stepped|approached|walked|looked|moved)';
  const body = `\\b(${parts.join('|')})(?:\\s+[A-Z][a-z]+)?\\b\\s+${actions}\\b`;
  const flags = computeFlagsFromEntries(entries, true);
  try { return new RegExp(body, flags); } catch (e) { console.warn("buildActionRegex compile failed:", e); return null; }
}

/* Quote ranges helpers */
function getQuoteRanges(s) {
  const q = /["\u201C\u201D]/g;
  const pos = [];
  let m;
  while ((m = q.exec(s)) !== null) pos.push(m.index);
  const ranges = [];
  for (let i = 0; i + 1 < pos.length; i += 2) ranges.push([pos[i], pos[i + 1]]);
  return ranges;
}

function findNonQuotedMatches(text, regex, quoteRanges) {
  if (!text || !regex) return [];
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  const results = [];
  let match;

  while ((match = re.exec(text)) !== null) {
      let isQuoted = false;
      const matchIndex = match.index;

      for (const range of quoteRanges) {
          if (matchIndex >= range[0] && matchIndex < range[1]) {
              isQuoted = true;
              break;
          }
      }

      if (!isQuoted) {
          results.push({ match: match[0], groups: match.slice(1), index: matchIndex });
      }
      if (match.index === re.lastIndex) {
          re.lastIndex++;
      }
  }
  return results;
}

/**
 * Scans the full text buffer for the best character match based on a priority system.
 */
function findBestMatch(buffer, regexes, settings, quoteRanges) {
    if (!buffer) return null;

    const allMatches = [];
    const { speakerRegex, attributionRegex, actionRegex, vocativeRegex, nameRegex } = regexes;

    const priorities = {
        speaker: 5,
        attribution: 4,
        action: 4, // Increased priority to match attribution
        vocative: 2,
        name: 1,
    };

    // Find matches for each type
    if (speakerRegex) {
        findNonQuotedMatches(buffer, speakerRegex, quoteRanges).forEach(m => {
            const name = m.groups?.[0]?.trim();
            if (name) allMatches.push({ name, matchKind: 'speaker', matchIndex: m.index, priority: priorities.speaker });
        });
    }
    if (attributionRegex) {
        findNonQuotedMatches(buffer, attributionRegex, quoteRanges).forEach(m => {
            const name = m.groups?.find(g => g)?.trim();
            if (name) allMatches.push({ name, matchKind: 'attribution', matchIndex: m.index, priority: priorities.attribution });
        });
    }
    if (actionRegex) {
        findNonQuotedMatches(buffer, actionRegex, quoteRanges).forEach(m => {
            const name = m.groups?.[0]?.trim();
            if (name) allMatches.push({ name, matchKind: 'action', matchIndex: m.index, priority: priorities.action });
        });
    }
    if (vocativeRegex) {
        findNonQuotedMatches(buffer, vocativeRegex, quoteRanges).forEach(m => {
            const name = m.groups?.[0]?.trim();
            if (name) allMatches.push({ name, matchKind: 'vocative', matchIndex: m.index, priority: priorities.vocative });
        });
    }
    if (nameRegex && settings.narrationSwitch) {
         findNonQuotedMatches(buffer, nameRegex, quoteRanges).forEach(m => {
            const name = String(m.groups?.[0] || m.match).replace(/-(?:sama|san)$/i, '').trim();
            if (name) allMatches.push({ name, matchKind: 'name', matchIndex: m.index, priority: priorities.name });
        });
    }

    if (allMatches.length === 0) return null;

    // Sort by index (latest first), then by priority (highest first)
    allMatches.sort((a, b) => {
        if (b.matchIndex !== a.matchIndex) {
            return b.matchIndex - a.matchIndex;
        }
        return b.priority - a.priority;
    });

    return allMatches[0];
}

function normalizeStreamText(s) {
  if (!s) return '';
  s = String(s);
  s = s.replace(/[\uFEFF\u200B\u200C\u200D]/g, '');
  s = s.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"');
  s = s.replace(/(\*\*|__|~~|`{1,3})/g, '');
  s = s.replace(/\u00A0/g, ' ');
  return s;
}

function normalizeCostumeName(n) {
  if (!n) return "";
  let s = String(n).trim();
  if (s.startsWith("/")) s = s.slice(1).trim();
  const first = s.split(/[\/\s]+/).filter(Boolean)[0] || s;
  return String(first).replace(/[-_](?:sama|san)$/i, '').trim();
}

// runtime state
const perMessageBuffers = new Map();
const perMessageStates = new Map();
let lastIssuedCostume = null;
let resetTimer = null;
let lastSwitchTimestamp = 0;
const lastTriggerTimes = new Map();
let _clickInProgress = new Set();

// Event handlers
let _streamHandler = null;
let _genStartHandler = null;
let _genEndHandler = null;
let _chatChangedHandler = null;

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

  await waitForSelector("#cs-save", 3000, 100);

  // Load settings into UI
  $("#cs-enable").prop("checked", !!settings.enabled);
  $("#cs-patterns").val((settings.patterns || []).join("\n"));
  $("#cs-default").val(settings.defaultCostume || "");
  $("#cs-timeout").val(settings.resetTimeoutMs || DEFAULTS.resetTimeoutMs);
  $("#cs-narration").prop("checked", !!settings.narrationSwitch);
  $("#cs-debug").prop("checked", !!settings.debug);
  $("#cs-global-cooldown").val(settings.globalCooldownMs || DEFAULTS.globalCooldownMs);
  $("#cs-per-cooldown").val(settings.perTriggerCooldownMs || DEFAULTS.perTriggerCooldownMs);
  $("#cs-repeat-suppress").val(settings.repeatSuppressMs || DEFAULTS.repeatSuppressMs);

  $("#cs-status").text("Ready");

  const realCtx = ctx || (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null);
  if (!realCtx) { console.error("SillyTavern context not found. Extension won't run."); return; }

  const { eventSource, event_types } = realCtx;

  // Build initial regexes
  let nameRegex = buildNameRegex(settings.patterns);
  let speakerRegex = buildSpeakerRegex(settings.patterns);
  let attributionRegex = buildAttributionRegex(settings.patterns);
  let actionRegex = buildActionRegex(settings.patterns);
  let vocativeRegex = buildVocativeRegex(settings.patterns);

  function saveAndRebuild() {
    settings.enabled = $("#cs-enable").prop("checked");
    settings.patterns = $("#cs-patterns").val().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    settings.defaultCostume = $("#cs-default").val().trim();
    settings.resetTimeoutMs = parseInt($("#cs-timeout").val(), 10) || DEFAULTS.resetTimeoutMs;
    settings.narrationSwitch = $("#cs-narration").prop("checked");
    settings.debug = $("#cs-debug").prop("checked");
    settings.globalCooldownMs = parseInt($("#cs-global-cooldown").val(), 10) || DEFAULTS.globalCooldownMs;
    settings.perTriggerCooldownMs = parseInt($("#cs-per-cooldown").val(), 10) || DEFAULTS.perTriggerCooldownMs;
    settings.repeatSuppressMs = parseInt($("#cs-repeat-suppress").val(), 10) || DEFAULTS.repeatSuppressMs;

    nameRegex = buildNameRegex(settings.patterns);
    speakerRegex = buildSpeakerRegex(settings.patterns);
    attributionRegex = buildAttributionRegex(settings.patterns);
    actionRegex = buildActionRegex(settings.patterns);
    vocativeRegex = buildVocativeRegex(settings.patterns);

    save();
    $("#cs-status").text(`Saved ${new Date().toLocaleTimeString()}`);
    setTimeout(() => $("#cs-status").text("Ready"), 1500);
  }

  $("#cs-save").on("click", saveAndRebuild);
  $("#cs-reset").on("click", () => manualReset());

  function triggerQuickReply(labelOrMessage) {
    try {
        const label = String(labelOrMessage || '').trim();
        if (!label) return false;

        const candidates = Array.from(document.querySelectorAll('.qr--button'));
        let exactLabelMatch = null;
        let exactTitleMatch = null;
        let caseInsensitiveMatch = null;

        for (const el of candidates) {
            const lblElement = el.querySelector('.qr--button-label');
            const labelText = (lblElement?.innerText || lblElement?.textContent || '').trim();
            const titleText = (el.getAttribute('title') || '').trim();

            if (labelText === label) {
                exactLabelMatch = el;
                break;
            }
            if (!exactTitleMatch && titleText === label) {
                exactTitleMatch = el;
            }
            if (!caseInsensitiveMatch && (labelText.toLowerCase() === label.toLowerCase() || titleText.toLowerCase() === label.toLowerCase())) {
                caseInsensitiveMatch = el;
            }
        }

        const buttonToClick = exactLabelMatch || exactTitleMatch || caseInsensitiveMatch;

        if (buttonToClick) {
            if (settings.debug) {
                 let matchType = (exactLabelMatch ? "exact label" : (exactTitleMatch ? "exact title" : "case-insensitive"));
                 console.debug(`[CostumeSwitch] Clicking Quick Reply (${matchType}): "${label}"`);
            }
            buttonToClick.click();
            return true;
        }
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

    const rawCandidates = [ `${name}`, `${name}/${name}`, `/costume ${name}` ];

    for (let c of rawCandidates) {
      c = String(c).trim();
      const key = c.toLowerCase();
      if (_clickInProgress.has(key)) continue;

      try {
        _clickInProgress.add(key);
        if (triggerQuickReply(c)) {
          return true;
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
    if (!costumeArg) { $("#cs-status").text("No default costume defined."); return; }
    const ok = triggerQuickReplyVariants(costumeArg);
    if (ok) { lastIssuedCostume = costumeArg; $("#cs-status").text(`Reset -> ${costumeArg}`); }
    else { $("#cs-status").text(`Quick Reply not found for ${costumeArg}`); }
    setTimeout(()=>$("#cs-status").text("Ready"), 1500);
  }

  function issueCostumeForName(name, opts = {}) {
    if (!name) return;
    name = normalizeCostumeName(name);
    const now = Date.now();
    const matchKind = opts.matchKind || null;

    const currentName = normalizeCostumeName(lastIssuedCostume || settings.defaultCostume || (realCtx?.characters?.[realCtx.characterId]?.name) || '');
    if (currentName && currentName.toLowerCase() === name.toLowerCase()) {
      scheduleResetIfIdle();
      return;
    }

    if (now - lastSwitchTimestamp < (settings.globalCooldownMs || DEFAULTS.globalCooldownMs)) {
      if (settings.debug) console.debug("CS debug: global cooldown active, skipping switch to", name);
      return;
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
      $("#cs-status").text(`Switched -> ${argFolder}`);
      setTimeout(()=>$("#cs-status").text("Ready"), 1000);
    } else {
      $("#cs-status").text(`Quick Reply not found for ${name}`);
      setTimeout(()=>$("#cs-status").text("Ready"), 1000);
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
        $("#cs-status").text(`Auto-reset -> ${costumeArg}`);
        setTimeout(()=>$("#cs-status").text("Ready"), 1200);
      }
    }, settings.resetTimeoutMs || DEFAULTS.resetTimeoutMs);
  }

  const streamEventName = event_types?.STREAM_TOKEN_RECEIVED || event_types?.SMOOTH_STREAM_TOKEN_RECEIVED || 'stream_token_received';

  _genStartHandler = (messageId) => {
    const bufKey = messageId != null ? `m${messageId}` : 'live';
    if (settings.debug) console.debug(`CS debug: Generation started for ${bufKey}, resetting state.`);
    perMessageStates.delete(bufKey);
    perMessageBuffers.delete(bufKey);
  };

  _streamHandler = (...args) => {
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
      const prevBuffer = perMessageBuffers.get(bufKey) || "";
      const newCombinedBuffer = (prevBuffer + tokenText).slice(-(settings.maxBufferChars || DEFAULTS.maxBufferChars));
      perMessageBuffers.set(bufKey, newCombinedBuffer);

      if (!perMessageStates.has(bufKey)) {
          perMessageStates.set(bufKey, { lastAcceptedName: null, lastAcceptedTs: 0, lastAcceptedIndex: -1 });
      }
      const state = perMessageStates.get(bufKey);
      const quoteRanges = getQuoteRanges(newCombinedBuffer);

      const bestMatch = findBestMatch(newCombinedBuffer, {
          speakerRegex, attributionRegex, actionRegex, vocativeRegex, nameRegex
      }, settings, quoteRanges);

      if (bestMatch) {
          let { name: matchedName, matchKind, matchIndex } = bestMatch;
          
          if (matchIndex > state.lastAcceptedIndex) {
              const now = Date.now();
              // Flicker guard
              if (state.lastAcceptedName && state.lastAcceptedName.toLowerCase() === matchedName.toLowerCase() && (now - state.lastAcceptedTs < settings.repeatSuppressMs)) {
                  if (settings.debug) console.debug('CS debug: suppressing repeat match for same name (flicker guard)', { matchedName });
                  matchedName = null;
              }

              if (matchedName) {
                  state.lastAcceptedName = matchedName;
                  state.lastAcceptedTs = now;
                  state.lastAcceptedIndex = matchIndex;
                  issueCostumeForName(matchedName, { matchKind, bufKey });
              }
          }
      }

      scheduleResetIfIdle();
      if (settings.debug) console.debug("CS debug:", { bufKey, bestMatch, state });

    } catch (err) { console.error("CostumeSwitch stream handler error:", err); }
  };

  _genEndHandler = () => { scheduleResetIfIdle(); };
  _chatChangedHandler = () => { perMessageBuffers.clear(); perMessageStates.clear(); lastIssuedCostume = null; };

  function unload() {
    try {
      if (eventSource && _streamHandler) eventSource.off?.(streamEventName, _streamHandler);
      if (eventSource && _genStartHandler) eventSource.off?.(event_types.GENERATION_STARTED, _genStartHandler);
      if (eventSource && _genEndHandler) eventSource.off?.(event_types.GENERATION_ENDED, _genEndHandler);
      if (eventSource && _chatChangedHandler) eventSource.off?.(event_types.CHAT_CHANGED, _chatChangedHandler);
    } catch (e) { /* ignore */ }
    if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
    perMessageBuffers.clear();
    perMessageStates.clear();
    lastIssuedCostume = null;
    lastTriggerTimes.clear();
    _clickInProgress.clear();
  }

  try { unload(); } catch(e) {}

  try {
    eventSource.on(streamEventName, _streamHandler);
    eventSource.on(event_types.GENERATION_STARTED, _genStartHandler);
    eventSource.on(event_types.GENERATION_ENDED, _genEndHandler);
    eventSource.on(event_types.CHAT_CHANGED, _chatChangedHandler);
  } catch (e) {
    console.error("CostumeSwitch: failed to attach event handlers:", e);
  }

  try { window[`__${extensionName}_unload`] = unload; } catch(e) {}

  console.log("SillyTavern-CostumeSwitch (patched v5.2 — priority fix) loaded.");
});

function getSettingsObj() {
  const ctx = typeof getContext === 'function' ? getContext() : (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null);
  if (ctx && ctx.extensionSettings) {
    ctx.extensionSettings[extensionName] = ctx.extensionSettings[extensionName] || { ...DEFAULTS };
    return { store: ctx.extensionSettings, save: ctx.saveSettingsDebounced || saveSettingsDebounced, ctx };
  }
  if (typeof extension_settings !== 'undefined') {
    extension_settings[extensionName] = extension_settings[extensionName] || { ...DEFAULTS };
    return { store: extension_settings, save: saveSettingsDebounced, ctx: null };
  }
  throw new Error("Can't find SillyTavern extension settings storage.");
}
