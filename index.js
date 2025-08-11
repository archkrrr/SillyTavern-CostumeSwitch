import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "SillyTavern-CostumeSwitch";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// This regex identifies common scene change markers to reset context.
const sceneChangeRegex = /^(?:\*\*|--|##|__|\*--).*(?:\*\*|--|##|__|\*--)$|^Back in Central Park,$/i;

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
  const before = combined.slice(0, pos);
  const quoteCount = (before.match(/["\u201C\u201D]/g) || []).length;
  return (quoteCount % 2) === 1;
}

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

function findBestMatch(combined, regexes, settings, quoteRanges) {
    if (!combined) return null;

    const allMatches = [];
    const { speakerRegex, attributionRegex, actionRegex, vocativeRegex, nameRegex } = regexes;

    const priorities = {
        speaker: 5,
        attribution: 4,
        action: 3,
        vocative: 3,
        possessive: 2,
        name: 1,
    };

    if (speakerRegex) {
        findNonQuotedMatches(combined, speakerRegex, quoteRanges).forEach(m => {
            const name = m.groups?.[0]?.trim();
            if (name) allMatches.push({ name, matchKind: 'speaker', matchIndex: m.index, priority: priorities.speaker });
        });
    }
    
    if (attributionRegex) {
        findNonQuotedMatches(combined, attributionRegex, quoteRanges).forEach(m => {
            const name = m.groups?.find(g => g)?.trim();
            if (name) allMatches.push({ name, matchKind: 'attribution', matchIndex: m.index, priority: priorities.attribution });
        });
    }

    if (actionRegex) {
        findNonQuotedMatches(combined, actionRegex, quoteRanges).forEach(m => {
            const name = m.groups?.[0]?.trim();
            if (name) allMatches.push({ name, matchKind: 'action', matchIndex: m.index, priority: priorities.action });
        });
    }

    if (vocativeRegex) {
        findNonQuotedMatches(combined, vocativeRegex, quoteRanges).forEach(m => {
            const name = m.groups?.[0]?.trim();
            if (name) allMatches.push({ name, matchKind: 'vocative', matchIndex: m.index, priority: priorities.vocative });
        });
    }

    if (settings.patterns && settings.patterns.length) {
        const names_poss = settings.patterns.map(s => (s||'').trim()).filter(Boolean);
        if (names_poss.length) {
            const possRe = new RegExp('\\b(' + names_poss.map(escapeRegex).join('|') + ")[’'`]s\\b", 'gi');
            findNonQuotedMatches(combined, possRe, quoteRanges).forEach(m => {
                const name = m.groups?.[0]?.trim();
                if (name) allMatches.push({ name, matchKind: 'possessive', matchIndex: m.index, priority: priorities.possessive });
            });
        }
    }

    if (nameRegex && settings.narrationSwitch) {
         findNonQuotedMatches(combined, nameRegex, quoteRanges).forEach(m => {
            const name = String(m.groups?.[0] || m.match).replace(/-(?:sama|san)$/i, '').trim();
            if (name) allMatches.push({ name, matchKind: 'name', matchIndex: m.index, priority: priorities.name });
        });
    }

    if (allMatches.length === 0) return null;

    allMatches.sort((a, b) => {
        if (b.priority !== a.priority) {
            return b.priority - a.priority;
        }
        return b.matchIndex - a.matchIndex;
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

const perMessageBuffers = new Map();
const perMessageStates = new Map();
let lastIssuedCostume = null;
let resetTimer = null;
let lastSwitchTimestamp = 0;
const lastTriggerTimes = new Map();
let _clickInProgress = new Set();

let _streamHandler = null;
let _genStartHandler = null;
let _genEndHandler = null;
let _msgRecvHandler = null;
let _chatChangedHandler = null;
let _reasoningStartHandler = null;
let _reasoningEndHandler = null;

const MAX_MESSAGE_BUFFERS = 60;
function ensureBufferLimit() {
  if (perMessageBuffers.size <= MAX_MESSAGE_BUFFERS) return;
  while (perMessageBuffers.size > MAX_MESSAGE_BUFFERS) {
    const firstKey = perMessageBuffers.keys().next().value;
    perMessageBuffers.delete(firstKey);
    perMessageStates.delete(firstKey);
  }
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

jQuery(async () => {
  const { store, save, ctx } = getSettingsObj();
  const settings = store[extensionName];
  let isReasoning = false;

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
  if ($("#cs-repeat-suppress").length) $("#cs-repeat-suppress").val(settings.repeatSuppressMs || DEFAULTS.repeatSuppressMs);

  $("#cs-status").text("Ready");

  function persistSettings() { if (save) save(); if (jQuery("#cs-status").length) $("#cs-status").text(`Saved ${new Date().toLocaleTimeString()}`); setTimeout(()=>jQuery("#cs-status").text(""), 1500); }

  const realCtx = ctx || (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null);
  if (!realCtx) { console.error("SillyTavern context not found. Extension won't run."); return; }

  const { eventSource, event_types } = realCtx;

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
        settings.narrationSwitch = !!$("#cs-narration").prop("checked");
        settings.debug = !!$("#cs-debug").prop("checked");
        settings.globalCooldownMs = parseInt($("#cs-global-cooldown").val() || DEFAULTS.globalCooldownMs, 10);
        settings.perTriggerCooldownMs = parseInt($("#cs-per-cooldown").val() || DEFAULTS.perTriggerCooldownMs, 10);
        settings.failedTriggerCooldownMs = parseInt($("#cs-failed-cooldown").val() || DEFAULTS.failedTriggerCooldownMs, 10);
        const mb = parseInt($("#cs-max-buffer").val() || DEFAULTS.maxBufferChars, 10);
        settings.maxBufferChars = isFinite(mb) && mb > 0 ? mb : DEFAULTS.maxBufferChars;
        const rsp = parseInt($("#cs-repeat-suppress").val() || DEFAULTS.repeatSuppressMs, 10);
        settings.repeatSuppressMs = isFinite(rsp) && rsp >= 0 ? rsp : DEFAULTS.repeatSuppressMs;

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
  tryWireUI(); setTimeout(tryWireUI, 500);

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
            
            setTimeout(() => {
                try {
                    buttonToClick.click();
                } catch (e) {
                    console.error(`[CostumeSwitch] Error during deferred click for "${label}":`, e);
                }
            }, 0);
            
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
    if (!costumeArg) { if ($("#cs-status").length) $("#cs-status").text("No default costume defined."); return; }
    const ok = triggerQuickReplyVariants(costumeArg);
    if (ok) { lastIssuedCostume = costumeArg; if ($("#cs-status").length) $("#cs-status").text(`Reset -> ${costumeArg}`); }
    else { if ($("#cs-status").length) $("#cs-status").text(`Quick Reply not found for ${costumeArg}`); }
    setTimeout(()=>$("#cs-status").text(""), 1500);
  }

  function issueCostumeForName(name, opts = {}) {
    if (!name) return;
    name = normalizeCostumeName(name);
    const now = Date.now();
    const matchKind = opts.matchKind || null;

    const currentName = normalizeCostumeName(lastIssuedCostume || settings.defaultCostume || (realCtx?.characters?.[realCtx.characterId]?.name) || '');
    if (currentName && currentName.toLowerCase() === name.toLowerCase()) {
      if (settings.debug) console.debug("CS debug: already using costume for", name, "- skipping switch.");
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
      if ($("#cs-status").length) $("#cs-status").text(`Switched -> ${argFolder}`);
      setTimeout(()=>$("#cs-status").text(""), 1000);
    } else {
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

  _genStartHandler = (messageId) => {
    const bufKey = messageId != null ? `m${messageId}` : 'live';
    if (settings.debug) console.debug(`CS debug: Generation started for ${bufKey}, resetting state.`);
    perMessageStates.delete(bufKey);
    perMessageBuffers.delete(bufKey);
  };
  
  _reasoningStartHandler = () => {
      if (settings.debug) console.debug("[CostumeSwitch] Reasoning block started. Pausing detection.");
      isReasoning = true;
  };

  _reasoningEndHandler = () => {
      if (settings.debug) console.debug("[CostumeSwitch] Reasoning block ended. Resuming detection.");
      isReasoning = false;
  };

  _streamHandler = (...args) => {
    try {
      if (!settings.enabled || isReasoning) return;
      
      let tokenText = ""; let messageId = null;
      if (typeof args[0] === 'number') { messageId = args[0]; tokenText = String(args[1] ?? ""); }
      else if (typeof args[0] === 'string' && args.length === 1) tokenText = args[0];
      else if (args[0] && typeof args[0] === 'object') { tokenText = String(args[0].token ?? args[0].text ?? ""); messageId = args[0].messageId ?? args[1] ?? null; }
      else tokenText = String(args.join(' ') || "");
      if (!tokenText) return;

      const bufKey = messageId != null ? `m${messageId}` : 'live';

      if (sceneChangeRegex.test(tokenText.trim())) {
          if (settings.debug) console.debug(`[CostumeSwitch] Scene change detected. Resetting context for: ${bufKey}`);
          perMessageBuffers.delete(bufKey);
          perMessageStates.delete(bufKey);
          return; 
      }

      tokenText = normalizeStreamText(tokenText);

      const prev = perMessageBuffers.get(bufKey) || "";
      const combined = (prev + tokenText).slice(- (settings.maxBufferChars || DEFAULTS.maxBufferChars));
      perMessageBuffers.set(bufKey, combined);
      ensureBufferLimit();

      if (!perMessageStates.has(bufKey)) {
          perMessageStates.set(bufKey, {
              lastAcceptedName: null,
              lastAcceptedTs: 0,
          });
      }
      const state = perMessageStates.get(bufKey);
      const quoteRanges = getQuoteRanges(combined);

      const bestMatch = findBestMatch(combined, {
          speakerRegex,
          attributionRegex,
          actionRegex,
          vocativeRegex,
          nameRegex
      }, settings, quoteRanges);


      if (bestMatch) {
          let { name: matchedName, matchKind } = bestMatch;

          const now = Date.now();
          const suppressMs = Number(settings.repeatSuppressMs || DEFAULTS.repeatSuppressMs);
          if (matchedName && state.lastAcceptedName && state.lastAcceptedName.toLowerCase() === matchedName.toLowerCase() && (now - state.lastAcceptedTs < suppressMs)) {
              if (settings.debug) console.debug('CS debug: suppressing repeat accepted match for same name (flicker guard)', { matchedName });
              matchedName = null;
          }

          if (matchedName) {
              state.lastAcceptedName = matchedName;
              state.lastAcceptedTs = now;
              perMessageStates.set(bufKey, state);
              issueCostumeForName(matchedName, { matchKind, bufKey });
          }
      }

      scheduleResetIfIdle();

      if (settings.debug) console.debug("CS debug:", { bufKey, bestMatch, state });

    } catch (err) { console.error("CostumeSwitch stream handler error:", err); }
  };

  _genEndHandler = (messageId) => { if (messageId != null) { perMessageBuffers.delete(`m${messageId}`); perMessageStates.delete(`m${messageId}`); } scheduleResetIfIdle(); };
  _msgRecvHandler = (messageId) => { if (messageId != null) { perMessageBuffers.delete(`m${messageId}`); perMessageStates.delete(`m${messageId}`); } };
  _chatChangedHandler = () => { perMessageBuffers.clear(); perMessageStates.clear(); lastIssuedCostume = null; };

  function unload() {
    try {
      if (eventSource && _streamHandler) eventSource.off?.(streamEventName, _streamHandler);
      if (eventSource && _genStartHandler) eventSource.off?.(event_types.GENERATION_STARTED, _genStartHandler);
      if (eventSource && _genEndHandler) eventSource.off?.(event_types.GENERATION_ENDED, _genEndHandler);
      if (eventSource && _msgRecvHandler) eventSource.off?.(event_types.MESSAGE_RECEIVED, _msgRecvHandler);
      if (eventSource && _chatChangedHandler) eventSource.off?.(event_types.CHAT_CHANGED, _chatChangedHandler);
      if (eventSource && _reasoningStartHandler) eventSource.off?.(event_types.STREAM_REASONING_STARTED, _reasoningStartHandler);
      if (eventSource && _reasoningEndHandler) eventSource.off?.(event_types.STREAM_REASONING_DONE, _reasoningEndHandler);
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
    eventSource.on(event_types.MESSAGE_RECEIVED, _msgRecvHandler);
    eventSource.on(event_types.CHAT_CHANGED, _chatChangedHandler);
    eventSource.on(event_types.STREAM_REASONING_STARTED, _reasoningStartHandler);
    eventSource.on(event_types.STREAM_REASONING_DONE, _reasoningEndHandler);
  } catch (e) {
    console.error("CostumeSwitch: failed to attach event handlers:", e);
  }

  try { window[`__${extensionName}_unload`] = unload; } catch(e) {}

  console.log("SillyTavern-CostumeSwitch (fully patched) loaded.");
});

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
