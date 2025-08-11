// index.js - SillyTavern-CostumeSwitch (patched: improved matching, vocative fallback,
// last-occurrence scan, normalized names, debug, and safer quick-reply triggering)

import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "SillyTavern-CostumeSwitch";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// default settings
const DEFAULTS = {
  enabled: true,
  resetTimeoutMs: 3000,
  patterns: ["Tohka", "Shido", "Kotori"], // sensible defaults for your setup
  defaultCostume: "", // empty => use current character's own folder
  narrationSwitch: false, // opt-in loose narration fallback (matches outside quotes only)
  debug: false,
  globalCooldownMs: 1200,
  perTriggerCooldownMs: 250,
  failedTriggerCooldownMs: 10000 // don't retry a missing quick-reply for 10s
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

// Build regex utilities
function buildNameRegex(patternList) {
  const escaped = patternList.map(p => {
    const trimmed = (p || '').trim();
    if (!trimmed) return null;
    const m = trimmed.match(/^\/(.+)\/(g?i?m?u?s?y?)$/);
    if (m) return m[1];
    return `${escapeRegex(trimmed)}(?:-(?:sama|san))?`;
  }).filter(Boolean);
  if (escaped.length === 0) return null;
  // require start-of-line OR newline OR opening bracket/dash before the name (less permissive)
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
  // match at start of line: "Name:" or "Name," or single Name followed by boundary (vocative/end)
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
  const patA = '(["\u201C\u201D].{0,400}["\u201C\u201D])\\s*,?\\s*(' + names + ')\\s+' + verbs;
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
  // allow "Name" or "Name Lastname" followed by action verb
  return new RegExp('(?:^|\\n)\\s*(' + escaped.join('|') + ')(?:\\s+[A-Z][a-z]+)?\\b\\s+' + actions + '\\b', 'i');
}

function isInsideQuotes(text, pos) {
  if (!text || pos <= 0) return false;
  const before = text.slice(0, pos);
  const quoteCount = (before.match(/["\u201C\u201D]/g) || []).length;
  return (quoteCount % 2) === 1;
}

// runtime state
const perMessageBuffers = new Map();
let lastIssuedCostume = null;
let resetTimer = null;
let lastSwitchTimestamp = 0; // global cooldown
const lastTriggerTimes = new Map();
const failedTriggerTimes = new Map();

// small helper to wait for a DOM selector to appear (polling)
function waitForSelector(selector, timeout = 3000, interval = 120) {
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const el = document.querySelector(selector);
      if (el) {
        clearInterval(iv);
        resolve(true);
        return;
      }
      if (Date.now() - start > timeout) {
        clearInterval(iv);
        resolve(false);
      }
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
  $("#cs-status").text("Ready");

  function persistSettings() {
    if (save) save();
    if (jQuery("#cs-status").length) $("#cs-status").text(`Saved ${new Date().toLocaleTimeString()}`);
    setTimeout(()=>jQuery("#cs-status").text(""), 1500);
  }

  const realCtx = ctx || (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null);
  if (!realCtx) {
    console.error("SillyTavern context not found. Extension won't run.");
    return;
  }

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
        // rebuild regexes
        nameRegex = buildNameRegex(settings.patterns || DEFAULTS.patterns);
        speakerRegex = buildSpeakerRegex(settings.patterns || DEFAULTS.patterns);
        attributionRegex = buildAttributionRegex(settings.patterns || DEFAULTS.patterns);
        actionRegex = buildActionRegex(settings.patterns || DEFAULTS.patterns);
        vocativeRegex = buildVocativeRegex(settings.patterns || DEFAULTS.patterns);
        persistSettings();
      });
    }

    if ($("#cs-reset").length) {
      $("#cs-reset").off('click.cs').on("click.cs", async () => { await manualReset(); });
    }
  }

  tryWireUI();
  setTimeout(tryWireUI, 500);
  setTimeout(tryWireUI, 1500);

  function normalizeCostumeName(n) {
    if (!n) return n;
    return n.replace(/[-_](?:sama|san)$/i, '').split(/\s+/)[0];
  }

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
        // allow partial matches where the needle is contained (handles extra whitespace or prefixes)
        if (candLower.includes(needle) || needle.includes(candLower)) { btn.click(); return true; }
      }
    } catch (err) {
      console.warn("triggerQuickReply error:", err);
    }
    return false;
  }

  function triggerQuickReplyVariants(costumeArg) {
    if (!costumeArg) return false;
    const name = normalizeCostumeName(String(costumeArg));
    const candidates = new Set();
    // Common expected forms
    candidates.add(`${name}/${name}`);
    candidates.add(`${name}`);
    candidates.add(`/costume ${name}`);
    candidates.add(`/costume ${name}/${name}`);
    candidates.add(`${name} / ${name}`);
    candidates.add(`${name}/${name}`);
    candidates.add(`/${name}`);
    // Also try the raw costumeArg as provided
    candidates.add(String(costumeArg));

    // Filter and try, but check recent failure timestamps to avoid thrashing
    const now = Date.now();
    for (const c of Array.from(candidates)) {
      if (!c) continue;
      const lastFailed = failedTriggerTimes.get(c) || 0;
      if (now - lastFailed < (settings.failedTriggerCooldownMs || DEFAULTS.failedTriggerCooldownMs)) continue;
      if (triggerQuickReply(c)) return true;
      // mark failed attempt
      failedTriggerTimes.set(c, Date.now());
    }
    return false;
  }

  async function manualReset() {
    let costumeArg = settings.defaultCostume || "";
    if (!costumeArg) {
      const ch = realCtx.characters?.[realCtx.characterId];
      if (ch && ch.name) costumeArg = `${ch.name}/${ch.name}`;
    }
    if (!costumeArg) {
      if ($("#cs-status").length) $("#cs-status").text("No default costume defined.");
      return;
    }
    const ok = triggerQuickReplyVariants(costumeArg);
    if (ok) {
      lastIssuedCostume = costumeArg;
      if ($("#cs-status").length) $("#cs-status").text(`Reset -> ${costumeArg}`);
      setTimeout(()=>$("#cs-status").text(""), 1500);
    } else {
      if ($("#cs-status").length) $("#cs-status").text(`Quick Reply not found for ${costumeArg}`);
      setTimeout(()=>$("#cs-status").text(""), 1500);
    }
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
    if (ok) {
      lastTriggerTimes.set(argFolder, now);
      lastIssuedCostume = argFolder;
      lastSwitchTimestamp = now;
      if ($("#cs-status").length) $("#cs-status").text(`Switched -> ${argFolder}`);
      setTimeout(()=>$("#cs-status").text(""), 1000);
    } else {
      // record a failed overall attempt for the main arg
      failedTriggerTimes.set(argFolder, Date.now());
      if ($("#cs-status").length) $("#cs-status").text(`Quick Reply not found for ${name}`);
      setTimeout(()=>$("#cs-status").text(""), 1000);
    }
  }

  function scheduleResetIfIdle() {
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      (async () => {
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
      })();
    }, settings.resetTimeoutMs || DEFAULTS.resetTimeoutMs);
  }

  const streamEventName = event_types?.STREAM_TOKEN_RECEIVED || event_types?.SMOOTH_STREAM_TOKEN_RECEIVED || 'stream_token_received';

  eventSource.on(streamEventName, (...args) => {
    try {
      if (!settings.enabled) return;
      let tokenText = "";
      let messageId = null;
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

      // 1) Speaker regex at line starts
      if (speakerRegex) {
        const speakerSearchRe = new RegExp(speakerRegex.source, 'gi');
        let lastSpeakerMatch = null;
        let m;
        while ((m = speakerSearchRe.exec(combined)) !== null) lastSpeakerMatch = m;
        if (lastSpeakerMatch) matchedName = lastSpeakerMatch[1]?.trim();
      }

      // 2) Attribution ("...", Name said) or (Name said, "...")
      if (!matchedName && attributionRegex) {
        const aRe = new RegExp(attributionRegex.source, 'gi');
        let lastA = null; let am;
        while ((am = aRe.exec(combined)) !== null) lastA = am;
        if (lastA) {
          for (let i = 1; i < lastA.length; i++) {
            if (lastA[i]) { matchedName = lastA[i].trim(); break; }
          }
        }
      }

      // 3) Action/narration lines that start with name ("Kotori nodded..." or "Tohka held aloft")
      if (!matchedName && actionRegex) {
        const acRe = new RegExp(actionRegex.source, 'gi');
        let lastAct = null; let am;
        while ((am = acRe.exec(combined)) !== null) lastAct = am;
        if (lastAct) {
          for (let i = 1; i < lastAct.length; i++) if (lastAct[i]) { matchedName = lastAct[i].trim(); break; }
        }
      }

      // 4) Vocative ("Shido, stay ready.")
      if (!matchedName && vocativeRegex) {
        const vRe = new RegExp(vocativeRegex.source, 'gi');
        let lastV = null; let vm;
        while ((vm = vRe.exec(combined)) !== null) lastV = vm;
        if (lastV) matchedName = lastV[1]?.trim();
      }

      // 5) Optional narration fallback (loose) -- only if enabled
      if (!matchedName && nameRegex && settings.narrationSwitch) {
        const actionsOrPossessive = "(?:'s|held|shifted|stood|sat|nodded|smiled|laughed|leaned|stepped|walked|turned|looked|moved|approached|said|asked|replied|observed|gazed|watched|beamed|frowned|sighed|remarked|added)";
        const narrationRe = new RegExp(nameRegex.source + '\\b\\s+' + actionsOrPossessive + '\\b', 'gi');
        let lastMatch = null; let mm;
        while ((mm = narrationRe.exec(combined)) !== null) {
          if (isInsideQuotes(combined, mm.index)) continue;
          for (let i = 1; i < mm.length; i++) if (mm[i]) { lastMatch = { name: mm[i], idx: mm.index }; break; }
        }
        if (lastMatch) matchedName = String(lastMatch.name).replace(/-(?:sama|san)$/i, '').trim();
      }

      // 6) Last-resort: scan for last occurrence of any name in the buffer (prefer not-inside-quotes)
      if (!matchedName && settings.patterns && settings.patterns.length) {
        const names = settings.patterns.map(s => (s||'').trim()).filter(Boolean);
        if (names.length) {
          const anyNameRe = new RegExp('\\\b(' + names.map(escapeRegex).join('|') + ')\\\b', 'gi');
          let lastMatch = null; let m;
          while ((m = anyNameRe.exec(combined)) !== null) {
            if (isInsideQuotes(combined, m.index)) continue;
            lastMatch = { name: m[1], idx: m.index };
          }
          if (lastMatch) matchedName = String(lastMatch.name).replace(/-(?:sama|san)$/i, '').trim();
        }
      }

      if (matchedName) {
        issueCostumeForName(matchedName);
        scheduleResetIfIdle();
        perMessageBuffers.set(bufKey, "");
      }

      if (settings.debug) console.debug("CS debug: ", { bufKey, recent: combined.slice(-400), matchedName });

    } catch (err) {
      console.error("CostumeSwitch stream handler error:", err);
    }
  });

  eventSource.on(event_types.GENERATION_ENDED, (messageId) => {
    if (messageId != null) perMessageBuffers.delete(`m${messageId}`);
    scheduleResetIfIdle();
  });

  eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
    if (messageId != null) perMessageBuffers.delete(`m${messageId}`);
  });

  eventSource.on(event_types.CHAT_CHANGED, () => {
    perMessageBuffers.clear();
    lastIssuedCostume = null;
  });

  console.log("SillyTavern-CostumeSwitch (patched) loaded.");
});
