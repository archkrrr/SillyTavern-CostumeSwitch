// index.js - SillyTavern-CostumeSwitch

import { getContext } from "../../../extensions.js";
import { extension_settings } from "../../../../script.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "SillyTavern-CostumeSwitch";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// Default settings
const DEFAULTS = {
  enabled: true,
  resetTimeoutMs: 3000,
  patterns: ["Shido", "Kotori"],
  defaultCostume: ""
};

// Simplified settings helper
function getSettings() {
  if (extension_settings[extensionName] === undefined) {
    extension_settings[extensionName] = structuredClone(DEFAULTS);
  }
  for (const key of Object.keys(DEFAULTS)) {
      if (!Object.hasOwn(extension_settings[extensionName], key)) {
          extension_settings[extensionName][key] = DEFAULTS[key];
      }
  }
  return extension_settings[extensionName];
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function buildNameRegex(patternList) {
  const escaped = (patternList || []).map(p => {
    const trimmed = (p || '').trim();
    if (!trimmed) return null;
    const m = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
    if (m) return `(${m[1]})`;
    return `(${escapeRegex(trimmed)})`;
  }).filter(Boolean);

  if (escaped.length === 0) return null;
  return new RegExp(`\\b(?:${escaped.join('|')})\\s*:`, 'i');
}

const perMessageBuffers = new Map();
let lastIssuedCostume = null;
let resetTimer = null;

// This is the main setup function, called only after 'app_ready'.
async function initializeExtension(context) {
  const settings = getSettings();

  try {
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $("#extensions_settings").append(settingsHtml);
    console.log("CostumeSwitch: UI panel loaded successfully.");
  } catch (e) {
    console.error("CostumeSwitch: Failed to load settings.html:", e);
    $("#extensions_settings").append(`<div><h3>Costume Switch</h3><div style="color:red;">Failed to load UI. Check console for errors.</div></div>`);
    return;
  }

  // Bind UI elements
  $("#cs-enable").prop("checked", !!settings.enabled);
  $("#cs-patterns").val((settings.patterns || []).join("\n"));
  $("#cs-default").val(settings.defaultCostume || "");
  $("#cs-timeout").val(settings.resetTimeoutMs || DEFAULTS.resetTimeoutMs);
  $("#cs-status").text("Ready");

  function persistSettings() {
    saveSettingsDebounced();
    $("#cs-status").text(`Saved ${new Date().toLocaleTimeString()}`);
    setTimeout(() => $("#cs-status").text("Ready"), 1500);
  }

  $("#cs-save").on("click", () => {
    settings.enabled = !!$("#cs-enable").prop("checked");
    settings.patterns = $("#cs-patterns").val().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    settings.defaultCostume = $("#cs-default").val().trim();
    settings.resetTimeoutMs = parseInt($("#cs-timeout").val() || DEFAULTS.resetTimeoutMs, 10);
    persistSettings();
    nameRegex = buildNameRegex(settings.patterns);
  });

  $("#cs-reset").on("click", () => manualReset());
  
  const { eventSource, event_types, characters, slashCommands } = context;
  let nameRegex = buildNameRegex(settings.patterns);

  function executeCostumeSwitch(costumeName) {
    if (!costumeName || costumeName === lastIssuedCostume) return;
    slashCommands.execute(`/costume ${costumeName}`);
    lastIssuedCostume = costumeName;
    $("#cs-status").text(`Switched -> ${costumeName}`);
    setTimeout(() => $("#cs-status").text("Ready"), 1200);
  }

  function manualReset() {
    let costumeArg = settings.defaultCostume || characters?.[context.characterId]?.name;
    if (costumeArg) {
      executeCostumeSwitch(costumeArg);
      $("#cs-status").text(`Reset -> ${costumeArg}`);
    } else {
      $("#cs-status").text("No default costume found.");
    }
  }

  function scheduleResetIfIdle() {
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
        let costumeArg = settings.defaultCostume || characters?.[context.characterId]?.name;
        if (costumeArg) {
            executeCostumeSwitch(costumeArg);
            $("#cs-status").text(`Auto-reset -> ${costumeArg}`);
        }
    }, settings.resetTimeoutMs);
  }

  const streamEventName = event_types?.STREAM_TOKEN_RECEIVED || event_types?.SMOOTH_STREAM_TOKEN_RECEIVED || 'stream_token_received';

  eventSource.on(streamEventName, (data) => {
    if (!settings.enabled || !nameRegex) return;
    try {
      let tokenText = "";
      if (typeof data === 'string') tokenText = data;
      else if (data && typeof data.token === 'string') tokenText = data.token;
      
      if (!tokenText) return;

      const bufKey = 'live_message';
      const combined = (perMessageBuffers.get(bufKey) || "") + tokenText;
      perMessageBuffers.set(bufKey, combined);

      const match = combined.match(nameRegex);
      if (match) {
        const matchedName = match.slice(1).find(Boolean);
        if (matchedName) {
          executeCostumeSwitch(matchedName.trim());
          scheduleResetIfIdle();
        }
      }
    } catch (err) {
      console.error("CostumeSwitch stream handler error:", err);
    }
  });

  // Cleanup logic
  eventSource.on(event_types.GENERATION_ENDED, () => {
    perMessageBuffers.delete('live_message');
    scheduleResetIfIdle();
  });
  eventSource.on(event_types.MESSAGE_RECEIVED, () => perMessageBuffers.delete('live_message'));
  eventSource.on(event_types.CHAT_CHANGED, () => {
    perMessageBuffers.clear();
    lastIssuedCostume = null;
  });

  console.log("CostumeSwitch: Extension initialized successfully.");
}

// NEW AND FINAL ENTRY POINT
// We wait for the DOM to be ready, then we listen for SillyTavern's own 'app_ready' signal.
$(document).ready(function () {
  const context = getContext();
  context.eventSource.on('app_ready', () => initializeExtension(context));
});
