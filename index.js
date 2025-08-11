// index.js (Dynamic Costumer)
import { eventSource, event_types } from "../../../../script.js";
import { extension_settings } from "../../../../../../scripts/extensions.js";

export const extensionName = "Dynamic Costumer";
const extKey = extensionName.toLowerCase();

if (!extension_settings[extKey]) extension_settings[extKey] = {};
export const extensionSettings = extension_settings[extKey];

// Defaults and state
const DEFAULTS = { enabled: false, inactivityTimeoutMs: 300000 };
let settings = { ...DEFAULTS };
let inactivityTimer = null;
let costumeLock = false;
let currentCostume = null;
let costumeMap = []; // array of {name, regex, targetCostume, re}
let defaultCostume = 'default';
let observer = null;
let processedTextLength = 0;
let targetNode = null;

// Try to execute /costume via STscript runner or safe fallbacks
function runCostumeCommand(costumeName) {
  if (!costumeName) return false;
  const cmd = `/costume ${costumeName}`;
  try {
    // Preferred: SillyTavern.STscript.run
    if (window.SillyTavern && window.SillyTavern.STscript && typeof window.SillyTavern.STscript.run === 'function') {
      window.SillyTavern.STscript.run(cmd);
      return true;
    }
    // Alternative: context-based STscript
    const ctx = SillyTavern.getContext && SillyTavern.getContext();
    if (ctx && ctx.STscript && typeof ctx.STscript.run === 'function') {
      ctx.STscript.run(cmd);
      return true;
    }
  } catch (err) {
    console.warn('[DynamicCostumer] STscript.run failed:', err);
  }

  // DOM fallback (fragile)
  try {
    const input = document.querySelector('textarea, input[type="text"]');
    if (!input) throw new Error('chat input not found');
    const old = input.value;
    input.value = cmd;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const sendBtn = document.querySelector('button[type="submit"], .SillyTavern--send-btn');
    if (sendBtn) {
      sendBtn.click();
      input.value = old;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      console.warn('[DynamicCostumer] Used DOM fallback to send command (fragile).');
      return true;
    }
    input.value = old;
  } catch (err) {
    console.warn('[DynamicCostumer] DOM fallback failed:', err);
  }

  console.error('[DynamicCostumer] Could not execute costume command programmatically.');
  return false;
}

function resetToDefault() {
  if (costumeLock) return;
  if (currentCostume === defaultCostume) return;
  runCostumeCommand(defaultCostume);
  currentCostume = defaultCostume;
}

function resetInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  if (!settings.inactivityTimeoutMs || settings.inactivityTimeoutMs <= 0) return;
  inactivityTimer = setTimeout(() => {
    if (!costumeLock) resetToDefault();
  }, settings.inactivityTimeoutMs);
}

// Load per-character costumeMap from character's extension field
function loadCharacterCostumeMap() {
  try {
    const ctx = SillyTavern.getContext();
    const cid = ctx.characterId;
    if (typeof cid === 'undefined' || cid === null) {
      costumeMap = [];
      defaultCostume = 'default';
      return;
    }
    const char = ctx.characters[cid];
    const ext = char && char.data && char.data.extensions && char.data.extensions[extKey];
    if (ext) {
      defaultCostume = ext.defaultCostume || defaultCostume;
      costumeMap = Array.isArray(ext.costumeMap) ? ext.costumeMap.map(m => {
        try {
          return { ...m, re: new RegExp(m.regex, 'i') };
        } catch (e) {
          console.warn('[DynamicCostumer] Invalid regex in mapping', m, e);
          return null;
        }
      }).filter(Boolean) : [];
    } else {
      costumeMap = [];
    }
    processedTextLength = 0;
    console.log('[DynamicCostumer] Loaded costumeMap:', costumeMap, 'default:', defaultCostume);
  } catch (err) {
    console.error('[DynamicCostumer] loadCharacterCostumeMap error', err);
    costumeMap = [];
  }
}

// Heuristics to find the streaming text node
function findStreamingNode() {
  const candidates = [
    '.streaming-message-content',
    '.SillyTavern--message .SillyTavern--message-text',
    '.character-message .message-text',
    '.message .content',
    '.message[data-streaming="true"]'
  ];
  for (const s of candidates) {
    const el = document.querySelector(s);
    if (el) return el;
  }
  const msgs = document.querySelectorAll('.SillyTavern--message, .message, .character-message');
  if (msgs.length) {
    const last = msgs[msgs.length - 1];
    const content = last.querySelector('p, div, .SillyTavern--message-text, .message-text, .content');
    if (content) return content;
  }
  return null;
}

function observerCallback(mutations) {
  if (!targetNode) return;
  const text = targetNode.textContent || '';
  if (text.length <= processedTextLength) return;
  const newText = text.substring(processedTextLength);
  for (const mapping of costumeMap) {
    if (!mapping || !mapping.re) continue;
    if (mapping.re.test(newText)) {
      const target = mapping.targetCostume || mapping.target || mapping.fileName;
      if (target && target !== currentCostume) {
        costumeLock = true;
        runCostumeCommand(target);
        currentCostume = target;
        setTimeout(() => { costumeLock = false; }, 500);
        processedTextLength = text.length;
        resetInactivityTimer();
        break;
      }
    }
  }
  processedTextLength = text.length;
}

function startObserving() {
  stopObserving();
  if (!settings.enabled) return;
  targetNode = findStreamingNode();
  if (!targetNode) return;
  processedTextLength = (targetNode.textContent || '').length;
  observer = new MutationObserver(observerCallback);
  observer.observe(targetNode, { childList: true, characterData: true, subtree: true });
  console.log('[DynamicCostumer] MutationObserver attached.');
}

function stopObserving() {
  if (observer) {
    try { observer.disconnect(); } catch (e) {}
    observer = null;
    console.log('[DynamicCostumer] MutationObserver disconnected.');
  }
}

// UI binding (runs after HTML is injected)
function bindUIElements() {
  try {
    const enabledToggle = document.querySelector('#dc-enabled-toggle');
    const timeoutInput = document.querySelector('#dc-timeout-input');
    const resetBtn = document.querySelector('#dc-reset-button');
    const openJsonBtn = document.querySelector('#dc-open-json');

    if (enabledToggle) {
      enabledToggle.checked = !!settings.enabled;
      enabledToggle.addEventListener('change', () => {
        settings.enabled = !!enabledToggle.checked;
        extensionSettings.enabled = settings.enabled;
        extensionSettings.inactivityTimeoutMs = settings.inactivityTimeoutMs;
        SillyTavern.getContext().saveSettingsDebounced && SillyTavern.getContext().saveSettingsDebounced();
        if (settings.enabled) startObserving(); else stopObserving();
      });
    }

    if (timeoutInput) {
      timeoutInput.value = Math.round(settings.inactivityTimeoutMs / 1000);
      timeoutInput.addEventListener('change', () => {
        settings.inactivityTimeoutMs = Math.max(0, Number(timeoutInput.value || 0) * 1000);
        extensionSettings.inactivityTimeoutMs = settings.inactivityTimeoutMs;
        SillyTavern.getContext().saveSettingsDebounced && SillyTavern.getContext().saveSettingsDebounced();
        resetInactivityTimer();
      });
    }

    if (resetBtn) resetBtn.addEventListener('click', () => { resetToDefault(); });

    if (openJsonBtn) openJsonBtn.addEventListener('click', () => {
      try {
        const ctx = SillyTavern.getContext();
        const cid = ctx.characterId;
        if (typeof cid === 'undefined' || cid === null) { alert('No character selected'); return; }
        const char = ctx.characters[cid];
        const ext = (char && char.data && char.data.extensions && char.data.extensions[extKey]) || {};
        console.log('[DynamicCostumer] character extension JSON:', JSON.stringify(ext, null, 2));
        alert('Printed dynamic_costumer JSON to console.');
      } catch (e) {
        console.error(e);
        alert('Failed to open JSON in console.');
      }
    });
  } catch (e) {
    console.error('[DynamicCostumer] bindUIElements error', e);
  }
}

// Initialization on app ready-ish
jQuery(async () => {
  try {
    // load global settings (extensionSettings is the global settings object)
    settings = Object.assign({}, DEFAULTS, extensionSettings || {});
    settings.inactivityTimeoutMs = Number(settings.inactivityTimeoutMs || DEFAULTS.inactivityTimeoutMs);

    // Bind UI elements (UI injected by manifest)
    bindUIElements();

    // Character mappings
    loadCharacterCostumeMap();

    // Register events
    eventSource.on(event_types.CHAT_CHANGED, () => {
      loadCharacterCostumeMap();
      stopObserving();
    });

    // GENERATION_AFTER_COMMANDS is fired when a generation starts rendering (good place to attach observer)
    if (event_types.GENERATION_AFTER_COMMANDS) {
      eventSource.on(event_types.GENERATION_AFTER_COMMANDS, () => startObserving());
    } else if (event_types.GENERATION_STARTED) {
      eventSource.on(event_types.GENERATION_STARTED, () => startObserving());
    }

    if (event_types.GENERATION_ENDED) {
      eventSource.on(event_types.GENERATION_ENDED, () => {
        stopObserving();
        resetInactivityTimer();
      });
    }

    eventSource.on(event_types.MESSAGE_SENT, () => resetInactivityTimer());

    console.log('[DynamicCostumer] initialized. Settings:', settings);
  } catch (err) {
    console.error('[DynamicCostumer] init error', err);
  }
}); 
