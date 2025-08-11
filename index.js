// index.js - SillyTavern-CostumeSwitch (patched v2: added possessive + pronoun inference,
// improved matching, vocative fallback, last-occurrence scan, normalized names, debug,
// and safer quick-reply triggering)

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
  failedTriggerCooldownMs: 10000
};

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'); }

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

// Build regex utilities (same as before)
function buildNameRegex(patternList) {
  const escaped = patternList.map(p => {
    const trimmed = (p || '').trim();
    if (!trimmed) return null;
    const m = trimmed.match(/^\/(.+)\/(g?i?m?u?s?y?)$/);
    if (m) return m[1];
    return `${escapeRegex(trimmed)}(?:-(?:sama|san))?`;
  }).filter(Boolean);
  if (escaped.length === 0) return null;
  return new RegExp(`(?:^|\\n|[\\(\\[\\-—–])(?:${escaped.join('|')})(?:\\W|$)`, 'i');
}
function buildSpeakerRegex(patternList) {
  const escaped = patternList.map(p => {
    const trimmed = (p || '').trim();
    if (!trimmed) return null;
    const m = trimmed.match(/^\/(.+)\/(g?i?m?u?s?y?)$/);
    if (m) return m[1];
    return escapeRegex(trimmed);
  }).filter(Boolean);
  if (escaped.length === 0) return null;
  return new RegExp('(?:^|\\n)\\s*(' + escaped.join('|') + ')\\s*(?:[:;,]|\\b)\\s*', 'i');
}
function buildVocativeRegex(patternList) {
  const escaped = patternList.map(p => {
    const trimmed = (p || '').trim();
    if (!trimmed) return null;
    const m = trimmed.match(/^\/(.+)\/(g?i?m?u?s?y?)$/);
    if (m) return m[1];
    return escapeRegex(trimmed);
  }).filter(Boolean);
  if (escaped.length === 0) return null;
  return new RegExp('(?:^|\\n|\\s)(' + escaped.join('|') + ')\\s*,', 'i');
}
function buildAttributionRegex(patternList) {
  const escaped = patternList.map(p => {
    const trimmed = (p || '').trim();
    if (!trimmed) return null;
    const m = trimmed.match(/^\/(.+)\/(g?i?m?u?s?y?)$/);
    if (m) return m[1];
    return escapeRegex(trimmed);
  }).filter(Boolean);
  if (escaped.length === 0) return null;
  const names = escaped.join('|');
  const verbs = '(?:said|asked|replied|murmured|whispered|sighed|laughed|exclaimed|noted|added|answered|shouted|cried|muttered|remarked)';
  const patA = '(["\\u201C\\u201D].{0,400}["\\u201C\\u201D])\\s*,?\\s*(' + names + ')\\s+' + verbs;
  const patB = '(?:^|\\n)\\s*(' + names + ')\\s+' + verbs + '\\s*[:,]?\\s*["\\u201C\\u201D]';
  return new RegExp('(?:' + patA + ')|(?:' + patB + ')', 'i');
}
function buildActionRegex(patternList) {
  const escaped = patternList.map(p => {
    const trimmed = (p || '').trim();
    if (!trimmed) return null;
    const m = trimmed.match(/^\/(.+)\/(g?i?m?u?s?y?)$/);
    if (m) return m[1];
    return escapeRegex(trimmed);
  }).filter(Boolean);
  if (escaped.length === 0) return null;
  const actions = '(?:nodded|leaned|smiled|laughed|stood|sat|gestured|sighed|replied|said|murmured|whispered|muttered|observed|watched|turned|glanced|held|lowered|positioned|stepped|approached)';
  return new RegExp('(?:^|\\n)\\s*(' + escaped.join('|') + ')(?:\\s+[A-Z][a-z]+)?\\b\\s+' + actions + '\\b', 'i');
}
function isInsideQuotes(text, pos) {
  if (!text || pos <= 0) return false;
  const before = text.slice(0, pos);
  const quoteCount = (before.match(/[["\u201C\u201D]]/g) || []).length;
  return (quoteCount % 2) === 1;
}

// runtime state
const perMessageBuffers = new Map();
let lastIssuedCostume = null;
let resetTimer = null;
let lastSwitchTimestamp = 0; // global cooldown
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

  function normalizeCostumeName(n) { if (!n) return n; return n.replace(/[-_](?:sama|san)$/i, '').split(/\s+/)[0]; }

  function triggerQuickReply(labelOrMsg) {
    try {
      if (!labelOrMsg) return false;
      const needle = String(labelOrMsg).trim().toLowerCase();
      const qrButtons = document.querySelectorAll('.qr--button');
      for (const btn of qrButtons) {
        const labelEl = btn.querySelector('.qr--button-label');
        let candidate = null;
        if (labelEl && labelEl.innerText) candidate = labelEl.innerText.trim();
        else if (btn.title) candidate = btn.title;
        if (!candidate) continue;
        const candLower = candidate.trim().toLowerCase();
        if (candLower === needle) { btn.click(); return true; }
        if (candLower.includes(needle) || needle.includes(candLower)) { btn.click(); return true; }
      }
    } catch (err) { console.warn("triggerQuickReply error:", err); }
    return false;
  }

  function triggerQuickReplyVariants(costumeArg) {
    if (!costumeArg) return false;
    const name = normalizeCostumeName(String(costumeArg));
    const candidates = new Set([`${name}/${name}`, `${name}`, `/costume ${name}`, `/costume ${name}/${name}`, `${name} / ${name}`, `/${name}`, String(costumeArg)]);
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

  async function issueCostumeForName(name) {
    if (!name) return;
    name = normalizeCostumeName(name);
    const now = Date.now();
    if (now - lastSwitchTimestamp < (settings.globalCooldownMs || DEFAULTS.globalCooldownMs)) return;
    const argFolder = `${name}/${name}`;
    const last = lastTriggerTimes.get(argFolder) || 0;
    if (now - last < (settings.perTriggerCooldownMs || DEFAULTS.perTriggerCooldownMs)) return;
    const ok = triggerQuickReplyVariants(argFolder) || triggerQuickReplyVariants(name);
    if (ok) { lastTriggerTimes.set(argFolder, now); lastIssuedCostume = argFolder; lastSwitchTimestamp = now; if ($("#cs-status").length) $("#cs-status").text(`Switched -> ${argFolder}`); setTimeout(()=>$("#cs-status").text(""), 1000); }
    else { failedTriggerTimes.set(argFolder, Date.now()); if ($("#cs-status").length) $("#cs-status").text(`Quick Reply not found for ${name}`); setTimeout(()=>$("#cs-status").text(""), 1000); }
  }

  function scheduleResetIfIdle() { if (resetTimer) clearTimeout(resetTimer); resetTimer = setTimeout(async () => { let costumeArg = settings.defaultCostume || ""; if (!costumeArg) { const ch = realCtx.characters?.[realCtx.characterId]; if (ch && ch.name) costumeArg = `${ch.name}/${ch.name}`; } if (costumeArg && triggerQuickReplyVariants(costumeArg)) { lastIssuedCostume = costumeArg; if ($("#cs-status").length) $("#cs-status").text(`Auto-reset -> ${costumeArg}`); setTimeout(()=>$("#cs-status").text(""), 1200); } }, settings.resetTimeoutMs || DEFAULTS.resetTimeoutMs); }

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
      const combined = prev + tokenText;
      perMessageBuffers.set(bufKey, combined);
      let matchedName = null;

      // QUICK token-level scan
      (function quickTokenScan() {
        try {
          const short = String(tokenText || '').trim(); if (!short) return;
          if (speakerRegex) { const m = new RegExp(speakerRegex.source, 'i').exec(short); if (m && m[1]) { matchedName = m[1].trim(); return; } }
          if (!matchedName && vocativeRegex) { const m = new RegExp(vocativeRegex.source, 'i').exec(short); if (m && m[1]) { matchedName = m[1].trim(); return; } }
          if (!matchedName && actionRegex) { const m = new RegExp(actionRegex.source, 'i').exec(short); if (m && m[1]) { matchedName = m[1].trim(); return; } }
          if (!matchedName && settings.patterns && settings.patterns.length) { const names = settings.patterns.map(s => (s||'').trim()).filter(Boolean); if (names.length) { const anyNameRe = new RegExp('\\b(' + names.map(escapeRegex).join('|') + ')\\b', 'i'); const mm = anyNameRe.exec(short); if (mm && mm[1] && !isInsideQuotes(short, mm.index)) matchedName = mm[1].trim(); } }
        } catch (e) { }
      })();

      if (matchedName) {
        issueCostumeForName(matchedName); scheduleResetIfIdle();
        try { const idx = (combined || '').toLowerCase().lastIndexOf(matchedName.toLowerCase()); if (idx >= 0) perMessageBuffers.set(bufKey, (combined || '').slice(idx + matchedName.length)); else perMessageBuffers.set(bufKey, ''); } catch (e) { perMessageBuffers.set(bufKey, ''); }
      } else {
        // Heavier scanning
        let speakerMatchIndex = -1; if (speakerRegex) { const speakerSearchRe = new RegExp(speakerRegex.source, 'gi'); let lastSpeakerMatch = null; let m; while ((m = speakerSearchRe.exec(combined)) !== null) lastSpeakerMatch = m; if (lastSpeakerMatch) { matchedName = lastSpeakerMatch[1]?.trim(); speakerMatchIndex = lastSpeakerMatch.index || -1; } }
        let attributionMatchIndex = -1; if (!matchedName && attributionRegex) { const aRe = new RegExp(attributionRegex.source, 'gi'); let lastA = null; let am; while ((am = aRe.exec(combined)) !== null) lastA = am; if (lastA) { for (let i = 1; i < lastA.length; i++) { if (lastA[i]) { matchedName = lastA[i].trim(); attributionMatchIndex = lastA.index || -1; break; } } } }
        let actionMatchIndex = -1; if (!matchedName && actionRegex) { const acRe = new RegExp(actionRegex.source, 'gi'); let lastAct = null; let am; while ((am = acRe.exec(combined)) !== null) lastAct = am; if (lastAct) { for (let i = 1; i < lastAct.length; i++) if (lastAct[i]) { matchedName = lastAct[i].trim(); actionMatchIndex = lastAct.index || -1; break; } } }
        let vocativeMatchIndex = -1; if (!matchedName && vocativeRegex) { const vRe = new RegExp(vocativeRegex.source, 'gi'); let lastV = null; let vm; while ((vm = vRe.exec(combined)) !== null) lastV = vm; if (lastV) { matchedName = lastV[1]?.trim(); vocativeMatchIndex = lastV.index || -1; } }

        // 5) Narration / possessive / pronoun heuristics
        let narrationMatchIndex = -1;
        // 5a) Possessive detection (e.g. "Kotori's gaze")
        let possessiveMatchIndex = -1;
        if (!matchedName && settings.patterns && settings.patterns.length) {
          const names_poss = settings.patterns.map(s => (s||'').trim()).filter(Boolean);
          if (names_poss.length) {
            const possRe = new RegExp('\\b(' + names_poss.map(escapeRegex).join('|') + ")'s\\b", 'gi');
            let lastP = null; let pm;
            while ((pm = possRe.exec(combined)) !== null) {
              if (isInsideQuotes(combined, pm.index)) continue;
              lastP = pm;
            }
            if (lastP) { matchedName = lastP[1].trim(); possessiveMatchIndex = lastP.index || -1; }
          }
        }
        // 5b) Pronoun attribution inference ("\"...\", she murmured")
        if (!matchedName && settings.patterns && settings.patterns.length) {
          try {
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
          } catch (e) { /* ignore pronoun inference errors */ }
        }

        // 5c) original narration fallback (loose - matches verbs/actions)
        if (!matchedName && nameRegex && settings.narrationSwitch) {
          const actionsOrPossessive = "(?:'s|held|shifted|stood|sat|nodded|smiled|laughed|leaned|stepped|walked|turned|looked|moved|approached|said|asked|replied|observed|gazed|watched|beamed|frowned|sighed|remarked|added)";
          const narrationRe = new RegExp(nameRegex.source + '\\b\\s+' + actionsOrPossessive + '\\b', 'gi');
          let lastMatch = null; let mm;
          while ((mm = narrationRe.exec(combined)) !== null) {
            if (isInsideQuotes(combined, mm.index)) continue;
            for (let i = 1; i < mm.length; i++) if (mm[i]) { lastMatch = { name: mm[i], idx: mm.index }; break; }
          }
          if (lastMatch) { matchedName = String(lastMatch.name).replace(/-(?:sama|san)$/i, '').trim(); narrationMatchIndex = lastMatch.idx || -1; }
        }

        // 6) Last-resort: scan for last occurrence of any name
        let lastOccurIndex = -1;
        if (!matchedName && settings.patterns && settings.patterns.length) {
          const names = settings.patterns.map(s => (s||'').trim()).filter(Boolean);
          if (names.length) {
            const anyNameRe = new RegExp('\\b(' + names.map(escapeRegex).join('|') + ')\\b', 'gi');
            let lastMatch = null; let m;
            while ((m = anyNameRe.exec(combined)) !== null) {
              if (isInsideQuotes(combined, m.index)) continue;
              lastMatch = { name: m[1], idx: m.index };
            }
            if (lastMatch) { matchedName = String(lastMatch.name).replace(/-(?:sama|san)$/i, '').trim(); lastOccurIndex = lastMatch.idx || -1; }
          }
        }

        // Heuristic: prefer the most recent mention among known names (RECENT_WINDOW)
        try {
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
        } catch (e) { }

        if (matchedName) { issueCostumeForName(matchedName); scheduleResetIfIdle(); try { const idx = (combined || '').toLowerCase().lastIndexOf(matchedName.toLowerCase()); if (idx >= 0) perMessageBuffers.set(bufKey, (combined || '').slice(idx + matchedName.length)); else perMessageBuffers.set(bufKey, ''); } catch (e) { perMessageBuffers.set(bufKey, ''); } }
      }

      if (settings.debug) console.debug("CS debug: ", { bufKey, recent: combined.slice(-400), matchedName });

    } catch (err) { console.error("CostumeSwitch stream handler error:", err); }
  });

  eventSource.on(event_types.GENERATION_ENDED, (messageId) => { if (messageId != null) perMessageBuffers.delete(`m${messageId}`); scheduleResetIfIdle(); });
  eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => { if (messageId != null) perMessageBuffers.delete(`m${messageId}`); });
  eventSource.on(event_types.CHAT_CHANGED, () => { perMessageBuffers.clear(); lastIssuedCostume = null; });

  console.log("SillyTavern-CostumeSwitch (patched v2) loaded.");
});
