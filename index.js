// index.js - SillyTavern-CostumeSwitch (quick-reply mode, honorific-aware name matching)
// Keep relative imports like the official examples
import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "SillyTavern-CostumeSwitch";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// default settings
const DEFAULTS = {
  enabled: true,
  resetTimeoutMs: 3000,
  patterns: ["Shido", "Kotori"], // default simple names (one per line in UI)
  defaultCostume: "" // empty => use current character's own folder
};

// simple safe regex-building util (escape plain text)
function escapeRegex(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// helper - read or init settings (works with either import-based or getContext() storage)
function getSettingsObj() {
  const ctx = getContext ? getContext() : (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null);
  // prefer context.extensionSettings when available
  if (ctx && ctx.extensionSettings) {
    ctx.extensionSettings[extensionName] = ctx.extensionSettings[extensionName] || structuredClone(DEFAULTS);
    // ensure defaults are present (useful after updates)
    for (const k of Object.keys(DEFAULTS)) {
      if (!Object.hasOwn(ctx.extensionSettings[extensionName], k)) ctx.extensionSettings[extensionName][k] = DEFAULTS[k];
    }
    return { store: ctx.extensionSettings, save: ctx.saveSettingsDebounced || saveSettingsDebounced, ctx };
  }

  // fallback to import-based extension_settings
  if (typeof extension_settings !== 'undefined') {
    extension_settings[extensionName] = extension_settings[extensionName] || structuredClone(DEFAULTS);
    for (const k of Object.keys(DEFAULTS)) {
      if (!Object.hasOwn(extension_settings[extensionName], k)) extension_settings[extensionName][k] = DEFAULTS[k];
    }
    return { store: extension_settings, save: saveSettingsDebounced, ctx: null };
  }

  throw new Error("Can't find SillyTavern extension settings storage.");
}

// small utility to build a combined regex from pattern list
// Changes here: match the listed name anywhere (no colon required), allow optional
// honorific-like suffixes "-sama" and "-san" (case-insensitive).
// For plain-text patterns we build capture groups like: (Name(?:-(?:sama|san))?)
// We then wrap the union with (?:^|\W)(?:...)(?:\W|$) so we match names when surrounded
// by non-word characters or boundaries (avoids partial matches inside letters).
function buildNameRegex(patternList) {
  const escaped = patternList.map(p => {
    const trimmed = (p || '').trim();
    if (!trimmed) return null;
    // allow literal /.../flags entries to be used directly
    const m = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
    if (m) return `(${m[1]})`;
    // for plain names, allow optional "-sama" or "-san" suffix
    return `(${escapeRegex(trimmed)}(?:-(?:sama|san))?)`;
  }).filter(Boolean);

  if (escaped.length === 0) return null;

  // Wrap with non-word boundary anchors so names are found anywhere but not inside other words.
  // The final regex looks like: (?:^|\W)(?:(Name(?:-sama)?)|(Name2(?:-san)?)))(?:\W|$)
  return new RegExp(`(?:^|\\W)(?:${escaped.join('|')})(?:\\W|$)`, 'i');
}

// store runtime buffers per-message so we can check mid-stream
const perMessageBuffers = new Map();
let lastIssuedCostume = null;
let resetTimer = null;

jQuery(async () => {
  const { store, save, ctx } = getSettingsObj();
  const settings = store[extensionName];

  // load settings UI HTML
  try {
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings").append(settingsHtml);
  } catch (e) {
    console.warn("Failed to load settings.html:", e);
    // If load fails, create a minimal UI container
    $("#extensions_settings").append(`<div><h3>Costume Switch</h3><div>Failed to load UI (see console)</div></div>`);
  }

  // initialize UI values
  $("#cs-enable").prop("checked", !!settings.enabled);
  $("#cs-patterns").val((settings.patterns || []).join("\n"));
  $("#cs-default").val(settings.defaultCostume || "");
  $("#cs-timeout").val(settings.resetTimeoutMs || DEFAULTS.resetTimeoutMs);
  $("#cs-status").text("Ready");

  // a tiny helper to persist
  function persistSettings() {
    if (save) save();
    $("#cs-status").text(`Saved ${new Date().toLocaleTimeString()}`);
    setTimeout(()=>$("#cs-status").text(""), 1500);
  }

  $("#cs-save").on("click", () => {
    settings.enabled = !!$("#cs-enable").prop("checked");
    settings.patterns = $("#cs-patterns").val().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    settings.defaultCostume = $("#cs-default").val().trim();
    settings.resetTimeoutMs = parseInt($("#cs-timeout").val()||DEFAULTS.resetTimeoutMs, 10);
    persistSettings();
  });

  $("#cs-reset").on("click", async () => {
    await manualReset();
  });

  // get ST context (eventSource, event_types, characters, etc.)
  const realCtx = ctx || (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null);
  if (!realCtx) {
    console.error("SillyTavern context not found. Extension won't run.");
    return;
  }
  const { eventSource, event_types, characters } = realCtx;

  // Build initial regex
  let nameRegex = buildNameRegex(settings.patterns || DEFAULTS.patterns);

  // rebuild regex when user saves new patterns
  $("#cs-save").on("click", () => {
    nameRegex = buildNameRegex(settings.patterns || DEFAULTS.patterns);
  });

  // ===== Quick Reply trigger helpers (use DOM .qr--button / .qr--button-label) =====
  // Try to find a quick-reply button whose visible label or title equals labelOrMsg and click it.
  function triggerQuickReply(labelOrMsg) {
    try {
      const qrButtons = document.querySelectorAll('.qr--button');
      for (const btn of qrButtons) {
        const labelEl = btn.querySelector('.qr--button-label');
        if (labelEl && labelEl.innerText && labelEl.innerText.trim() === labelOrMsg) {
          btn.click();
          return true;
        }
        // some quick replies set the underlying message on the title attribute
        if (btn.title && btn.title === labelOrMsg) {
          btn.click();
          return true;
        }
      }
    } catch (err) {
      // DOM might not be available; ignore
      console.warn("triggerQuickReply error:", err);
    }
    return false;
  }

  // Given a costumeArg (e.g. "Shido" or "Shido/Shido"), try a set of likely variants.
  // Returns true if any quick-reply was clicked.
  function triggerQuickReplyVariants(costumeArg) {
    if (!costumeArg) return false;
    const candidates = [];
    if (costumeArg.includes('/')) {
      const parts = costumeArg.split('/');
      const name = parts[0];
      candidates.push(costumeArg); // label: "Name/Folder" or title
      candidates.push(name);       // label: "Name"
      candidates.push(`/costume ${costumeArg}`); // message title
      candidates.push(`/costume ${name}`);       // message title (no folder)
    } else {
      const name = costumeArg;
      candidates.push(name);                     // label "Name"
      candidates.push(`${name}/${name}`);        // label "Name/Name"
      candidates.push(`/costume ${name}`);       // title
      candidates.push(`/costume ${name}/${name}`); // title with folder
    }

    for (const c of candidates) {
      if (triggerQuickReply(c)) return true;
    }
    return false;
  }

  // manual reset helper (now triggers quick reply instead of emitting /costume)
  async function manualReset() {
    // choose default costume:
    let costumeArg = settings.defaultCostume || "";
    if (!costumeArg) {
      // use current character name as both folder and name (typical)
      const ch = realCtx.characters?.[realCtx.characterId];
      if (ch && ch.name) costumeArg = `${ch.name}/${ch.name}`;
    }
    if (!costumeArg) {
      $("#cs-status").text("No default costume defined.");
      return;
    }

    const ok = triggerQuickReplyVariants(costumeArg);
    if (ok) {
      lastIssuedCostume = costumeArg;
      $("#cs-status").text(`Reset -> ${costumeArg}`);
      setTimeout(()=>$("#cs-status").text(""), 1500);
    } else {
      $("#cs-status").text(`Quick Reply not found for ${costumeArg}`);
      setTimeout(()=>$("#cs-status").text(""), 1500);
    }
  }

  // function to issue costume switch when a new character is detected
  async function issueCostumeForName(name) {
    if (!name) return;
    // Format: try both "Name" and "Name/Name" variants
    const argFolder = `${name}/${name}`;
    // avoid spam if already set
    if (argFolder === lastIssuedCostume || name === lastIssuedCostume) return;

    // Try variants: folder form first, then bare name, then /costume forms
    const ok = triggerQuickReplyVariants(argFolder) || triggerQuickReplyVariants(name);
    if (ok) {
      // set lastIssuedCostume to the folder variant (most specific), but accept name if needed
      lastIssuedCostume = argFolder;
      $("#cs-status").text(`Switched -> ${argFolder}`);
      setTimeout(()=>$("#cs-status").text(""), 1000);
    } else {
      $("#cs-status").text(`Quick Reply not found for ${name}`);
      setTimeout(()=>$("#cs-status").text(""), 1000);
    }
  }

  // reset timer management (uses quick replies instead of eventSource.emit)
  function scheduleResetIfIdle() {
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      (async () => {
        let costumeArg = settings.defaultCostume || "";
        if (!costumeArg) {
          const ch = realCtx.characters?.[realCtx.characterId];
          if (ch && ch.name) costumeArg = `${ch.name}/${ch.name}`;
        }
        if (costumeArg) {
          const ok = triggerQuickReplyVariants(costumeArg);
          if (ok) {
            lastIssuedCostume = costumeArg;
            $("#cs-status").text(`Auto-reset -> ${costumeArg}`);
            setTimeout(()=>$("#cs-status").text(""), 1200);
          } else {
            // optionally silence if not found
            console.debug("Auto-reset quick reply not found for", costumeArg);
          }
        }
      })();
    }, settings.resetTimeoutMs || DEFAULTS.resetTimeoutMs);
  }

  // STREAM_TOKEN_RECEIVED fires on every token/chunk (good for mid-stream detection). Use fallback to MESSAGE_RECEIVED if not available.
  const streamEventName = event_types?.STREAM_TOKEN_RECEIVED || event_types?.SMOOTH_STREAM_TOKEN_RECEIVED || 'stream_token_received';

  // message buffer and detection:
  eventSource.on(streamEventName, (...args) => {
    try {
      if (!settings.enabled) return;

      // Determine token text and message id from args - shape can vary by ST version.
      // Common shapes: (messageId, token) OR ({ token, messageId }) OR (tokenString)
      let tokenText = "";
      let messageId = null;

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

      // decide a key for buffer; prefer messageId if known, else use 'live'
      const bufKey = messageId != null ? `m${messageId}` : 'live';
      const prev = perMessageBuffers.get(bufKey) || "";
      const combined = prev + tokenText;
      perMessageBuffers.set(bufKey, combined);

      // run regex search on the combined text for any listed name (now honorific-aware)
      if (!nameRegex) return;
      const m = combined.match(nameRegex);
      if (m) {
        // extract the matched name (the first non-empty capture group)
        let matchedName = null;
        for (let i = 1; i < m.length; i++) {
          if (m[i]) { matchedName = m[i].replace(/\s*[:]/, '').trim(); break; }
        }
        if (matchedName) {
          issueCostumeForName(matchedName);
          // reset idle timer
          scheduleResetIfIdle();
        }
      }
    } catch (err) {
      console.error("CostumeSwitch stream handler error:", err);
    }
  });

  // Also listen for GENERATION_ENDED and MESSAGE_RECEIVED to clear buffers for finished message ids
  eventSource.on(event_types.GENERATION_ENDED, (messageId) => {
    if (messageId != null) perMessageBuffers.delete(`m${messageId}`);
    scheduleResetIfIdle();
  });

  eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
    // sometimes MESSAGE_RECEIVED means full message is present; clear older buffers
    if (messageId != null) perMessageBuffers.delete(`m${messageId}`);
  });

  // When chat/character changes, clear state
  eventSource.on(event_types.CHAT_CHANGED, () => {
    perMessageBuffers.clear();
    lastIssuedCostume = null;
  });

  // done
  console.log("SillyTavern-CostumeSwitch (quick-reply mode, honorific-aware) loaded.");
});
