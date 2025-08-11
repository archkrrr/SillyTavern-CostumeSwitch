// index.js - SillyTavern-CostumeSwitch (DEBUG-FRIENDLY, FULL)
// Imports follow the standard example you provided
import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "SillyTavern-CostumeSwitch";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// Default settings
const DEFAULTS = {
  enabled: true,
  resetTimeoutMs: 3000,
  patterns: ["Shido", "Kotori"],
  defaultCostume: ""  // if empty, will default to current character folder/name
};

// runtime state
let lastIssuedCostume = null;
let resetTimer = null;
const perMessageBuffers = new Map(); // buffer per message id
let nameRegex = null;

// Utility: escape plain text -> regex
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Build master regex from pattern list (accepts plain names or /regex/ flags)
function buildNameRegex(patternList) {
  const list = (patternList || []).map(p => (p || '').trim()).filter(Boolean);
  if (!list.length) return null;
  const pieces = list.map(p => {
    const m = p.match(/^\/(.+)\/([gimsuy]*)$/);
    if (m) return `(${m[1]})`;
    return `(${escapeRegex(p)})`;
  });
  // match "Name:" with optional whitespace before colon; case-insensitive
  return new RegExp(`\\b(?:${pieces.join('|')})\\s*:`, 'i');
}

// Helper to get live SillyTavern context (safe fallback)
function getRealContext() {
  try {
    if (typeof getContext === 'function') {
      const c = getContext();
      if (c) return c;
    }
  } catch (e) {
    console.warn("getContext() threw:", e);
  }
  try {
    if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
      return SillyTavern.getContext();
    }
  } catch (e) {
    console.warn("SillyTavern.getContext() threw:", e);
  }
  return null;
}

// Initialize or ensure extension settings exist (works with extension_settings import or ctx.extensionSettings)
function ensureSettings() {
  const ctx = getRealContext();
  if (ctx && ctx.extensionSettings) {
    ctx.extensionSettings[extensionName] = ctx.extensionSettings[extensionName] || structuredClone(DEFAULTS);
    const s = ctx.extensionSettings[extensionName];
    for (const k of Object.keys(DEFAULTS)) if (!Object.hasOwn(s, k)) s[k] = DEFAULTS[k];
    return { storage: ctx.extensionSettings, save: ctx.saveSettingsDebounced || saveSettingsDebounced, ctx };
  }
  if (typeof extension_settings !== 'undefined') {
    extension_settings[extensionName] = extension_settings[extensionName] || structuredClone(DEFAULTS);
    const s = extension_settings[extensionName];
    for (const k of Object.keys(DEFAULTS)) if (!Object.hasOwn(s, k)) s[k] = DEFAULTS[k];
    return { storage: extension_settings, save: saveSettingsDebounced, ctx: null };
  }
  throw new Error("Unable to find extension settings storage.");
}

// Robust manual reset (very verbose for debugging)
async function manualResetHandler(event) {
  try {
    if (event && event.preventDefault) event.preventDefault();
    console.log("CostumeSwitch: manualResetHandler invoked");

    const realCtx = getRealContext();
    if (!realCtx) {
      console.error("CostumeSwitch: ST context NOT FOUND at manual reset time.");
      $("#cs-status").text("Error: ST context not found (see console).");
      return;
    }
    const { eventSource, event_types, characters, characterId } = realCtx;
    if (!eventSource || !event_types) {
      console.error("CostumeSwitch: eventSource or event_types missing:", eventSource, event_types);
      $("#cs-status").text("Error: ST event API missing (see console).");
      return;
    }

    // Read settings live
    const settings = (realCtx.extensionSettings && realCtx.extensionSettings[extensionName])
                   || (typeof extension_settings !== 'undefined' && extension_settings[extensionName])
                   || DEFAULTS;
    console.log("CostumeSwitch: live settings:", settings);

    // Determine costume arg
    let costumeArg = (settings.defaultCostume || "").trim();
    if (!costumeArg) {
      // fallback: use current characterId
      if (characterId != null && characters && characters[characterId] && characters[characterId].name) {
        const n = characters[characterId].name.trim();
        costumeArg = `${n}/${n}`;
        console.log("CostumeSwitch: fallback -> current characterId:", costumeArg);
      } else if (characters && Object.keys(characters).length > 0) {
        const first = characters[Object.keys(characters)[0]];
        if (first && first.name) {
          const n = first.name.trim();
          costumeArg = `${n}/${n}`;
          console.log("CostumeSwitch: fallback -> first character in list:", costumeArg);
        }
      }
    } else {
      console.log("CostumeSwitch: using configured defaultCostume:", costumeArg);
    }

    if (!costumeArg) {
      $("#cs-status").text("No default costume configured and no character available.");
      console.warn("CostumeSwitch: manual reset aborted - no costumeArg found.");
      return;
    }

    console.log(`CostumeSwitch: emitting ${event_types.MESSAGE_SENT} with message "/costume ${costumeArg}"`);
    await eventSource.emit(event_types.MESSAGE_SENT, { message: `/costume ${costumeArg}`, name: characters?.[characterId]?.name || '' });
    lastIssuedCostume = costumeArg;
    $("#cs-status").text(`Reset -> ${costumeArg}`);
    setTimeout(()=>$("#cs-status").text(""), 1400);
    console.log("CostumeSwitch: MESSAGE_SENT emitted successfully.");
  } catch (err) {
    console.error("CostumeSwitch manualResetHandler error:", err);
    $("#cs-status").text("Error resetting costume (see console).");
  }
}

// Issue costume change for a detected name (non-blocking)
async function issueCostumeForName(name) {
  try {
    if (!name) return;
    const realCtx = getRealContext();
    if (!realCtx) {
      console.warn("CostumeSwitch: cannot issue costume - context missing.");
      return;
    }
    const { eventSource, event_types, characters, characterId } = realCtx;
    // Format: name/name by default
    const arg = `${name}/${name}`;
    if (arg === lastIssuedCostume) {
      // nothing to do
      return;
    }
    console.log(`CostumeSwitch: issuing costume for detected name '${name}' -> /costume ${arg}`);
    await eventSource.emit(event_types.MESSAGE_SENT, { message: `/costume ${arg}`, name: characters?.[characterId]?.name || '' });
    lastIssuedCostume = arg;
    $("#cs-status").text(`Switched -> ${arg}`);
    setTimeout(()=>$("#cs-status").text(""), 900);
  } catch (err) {
    console.error("CostumeSwitch issueCostumeForName error:", err);
  }
}

// Schedule auto-reset after user-configured timeout
function scheduleResetIfIdle(settings) {
  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = null;
  }
  resetTimer = setTimeout(async () => {
    try {
      const realCtx = getRealContext();
      if (!realCtx) return;
      const { eventSource, event_types, characters, characterId } = realCtx;
      let costumeArg = (settings.defaultCostume || "").trim();
      if (!costumeArg) {
        if (characterId != null && characters && characters[characterId] && characters[characterId].name) {
          const n = characters[characterId].name.trim();
          costumeArg = `${n}/${n}`;
        } else if (characters && Object.keys(characters).length > 0) {
          const first = characters[Object.keys(characters)[0]];
          if (first && first.name) costumeArg = `${first.name}/${first.name}`;
        }
      }
      if (costumeArg) {
        console.log("CostumeSwitch: idle reset ->", costumeArg);
        await eventSource.emit(event_types.MESSAGE_SENT, { message: `/costume ${costumeArg}`, name: characters?.[characterId]?.name || '' });
        lastIssuedCostume = costumeArg;
        $("#cs-status").text(`Auto-reset -> ${costumeArg}`);
        setTimeout(()=>$("#cs-status").text(""), 1200);
      } else {
        console.log("CostumeSwitch: idle reset skipped (no costumeArg)");
      }
    } catch (e) {
      console.error("CostumeSwitch scheduleResetIfIdle error:", e);
    }
  }, (settings.resetTimeoutMs || DEFAULTS.resetTimeoutMs));
}

// STREAM token handler: robust parsing of arguments + buffer logic
function streamTokenHandlerFactory(settings, realCtx) {
  return (...args) => {
    try {
      if (!settings.enabled) return;
      // Determine token text and message id from args (shapes vary)
      let tokenText = "";
      let messageId = null;

      if (args.length === 0) return;
      // Common shapes:
      // (messageId, token)  OR  (tokenString)  OR ({ token, messageId })
      if (typeof args[0] === 'number') {
        messageId = args[0];
        tokenText = String(args[1] ?? "");
      } else if (typeof args[0] === 'string' && args.length === 1) {
        tokenText = args[0];
      } else if (args[0] && typeof args[0] === 'object') {
        tokenText = String(args[0].token ?? args[0].text ?? "");
        messageId = args[0].messageId ?? args[1] ?? null;
      } else {
        tokenText = String(args.join(' ') || "");
      }

      if (!tokenText) return;

      const bufKey = messageId != null ? `m${messageId}` : 'live';
      const prev = perMessageBuffers.get(bufKey) || "";
      const combined = prev + tokenText;
      perMessageBuffers.set(bufKey, combined);

      if (!nameRegex) return;
      const m = combined.match(nameRegex);
      if (m) {
        // find which capture matched
        let matchedName = null;
        for (let i = 1; i < m.length; i++) {
          if (m[i]) { matchedName = m[i].replace(/\s*:/,'').trim(); break; }
        }
        if (matchedName) {
          console.log("CostumeSwitch: detected name in stream:", matchedName);
          issueCostumeForName(matchedName);
          scheduleResetIfIdle(settings);
        }
      }
    } catch (err) {
      console.error("CostumeSwitch stream handler error:", err);
    }
  };
}

// jQuery ready - setup UI, bindings, event listeners
jQuery(async () => {
  console.log("CostumeSwitch: initializing...");
  const { storage, save, ctx } = ensureSettings();
  const settings = storage[extensionName];

  // Load settings.html if available
  try {
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings").append(settingsHtml);
  } catch (e) {
    console.warn("CostumeSwitch: failed to load settings.html, creating minimal UI.", e);
    $("#extensions_settings").append(`
      <div class="st-ext-card" style="padding:8px;">
        <h3>Costume Switch</h3>
        <label><input id="cs-enable" type="checkbox" /> Enable real-time switching</label>
        <div><textarea id="cs-patterns" rows="6" style="width:100%"></textarea></div>
        <div><input id="cs-default" type="text" placeholder="Default costume (e.g. Date a Live)"/></div>
        <div><input id="cs-timeout" type="number" min="100" /></div>
        <div><button id="cs-reset">Manual Reset Costume</button> <button id="cs-save">Save</button></div>
        <div id="cs-status" style="color:#777;margin-top:6px;"></div>
      </div>`);
  }

  // Initialize UI controls from settings
  $("#cs-enable").prop("checked", !!settings.enabled);
  $("#cs-patterns").val((settings.patterns || []).join("\n"));
  $("#cs-default").val(settings.defaultCostume || "");
  $("#cs-timeout").val(settings.resetTimeoutMs || DEFAULTS.resetTimeoutMs);

  // Save settings helper
  function persistSettings() {
    if (save) save();
    $("#cs-status").text(`Saved ${new Date().toLocaleTimeString()}`);
    setTimeout(()=>$("#cs-status").text(""), 1200);
  }

  $("#cs-save").on("click", () => {
    settings.enabled = !!$("#cs-enable").prop("checked");
    settings.patterns = $("#cs-patterns").val().split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    settings.defaultCostume = $("#cs-default").val().trim();
    settings.resetTimeoutMs = parseInt($("#cs-timeout").val()||DEFAULTS.resetTimeoutMs, 10);
    // rebuild regex
    nameRegex = buildNameRegex(settings.patterns);
    console.log("CostumeSwitch: patterns saved ->", settings.patterns, "regex:", nameRegex);
    persistSettings();
  });

  // Delegated binding for manual reset (survives DOM re-renders)
  $(document).off('click', '#cs-reset', manualResetHandler);
  $(document).on('click', '#cs-reset', manualResetHandler);

  // Expose quick test function
  window.CostumeSwitch_manualReset_test = () => {
    console.log("CostumeSwitch: manual test invoked");
    return manualResetHandler();
  };

  // Build regex initially
  nameRegex = buildNameRegex(settings.patterns || DEFAULTS.patterns);
  console.log("CostumeSwitch: initial regex:", nameRegex);

  // Get ST context and hook streaming events
  const realCtx = ctx || getRealContext();
  if (!realCtx) {
    console.error("CostumeSwitch: SillyTavern context not available - extension will not hook events.");
    $("#cs-status").text("ST context not found - extension inactive.");
    return;
  }
  const { eventSource, event_types } = realCtx;
  if (!eventSource || !event_types) {
    console.error("CostumeSwitch: eventSource/event_types missing in context.", realCtx);
    $("#cs-status").text("ST event API missing - extension inactive.");
    return;
  }

  // Decide stream event name (supports different ST versions)
  const streamEventName = event_types.STREAM_TOKEN_RECEIVED || event_types.SMOOTH_STREAM_TOKEN_RECEIVED || event_types.stream_token_received || 'stream_token_received';
  console.log("CostumeSwitch: hooking stream event:", streamEventName);

  // Attach handler
  const streamHandler = streamTokenHandlerFactory(settings, realCtx);
  try {
    eventSource.on(streamEventName, streamHandler);
    // keep additional listeners to clean up buffers and schedule reset
    eventSource.on(event_types.GENERATION_ENDED, (messageId) => {
      if (messageId != null) perMessageBuffers.delete(`m${messageId}`);
      scheduleResetIfIdle(settings);
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
      if (messageId != null) perMessageBuffers.delete(`m${messageId}`);
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
      perMessageBuffers.clear();
      lastIssuedCostume = null;
    });
    console.log("CostumeSwitch: event listeners registered.");
  } catch (e) {
    console.error("CostumeSwitch: failed to register event listeners:", e);
  }

  console.log("CostumeSwitch: loaded (debug mode).");
});
