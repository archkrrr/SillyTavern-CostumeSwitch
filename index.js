// index.js - SillyTavern-CostumeSwitch (MutationObserver + direct slash-command execution)
// Drop into: data/default-user/extensions/SillyTavern-CostumeSwitch/index.js

import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const EXT_NAME = "SillyTavern-CostumeSwitch";
const EXT_FOLDER = `scripts/extensions/third-party/${EXT_NAME}`;

const DEFAULTS = {
  enabled: true,
  patterns: ["Shido", "Kotori"], // one per line in UI
  defaultCostume: "Date a Live",  // exact arg used for manual reset (works for you)
  resetTimeoutMs: 3000
};

let settingsStorage = null;
let saveSettingsFn = null;
let ctx = null;
let nameRegex = null;
let observer = null;
let lastDetectedCharacter = null;
let resetTimer = null;
const buffers = { currentText: "" };

// ---------- Helpers ----------
function safeLog(...args) { try { console.log("[CostumeSwitch]", ...args); } catch(e){} }
function safeWarn(...args) { try { console.warn("[CostumeSwitch]", ...args); } catch(e){} }
function safeError(...args) { try { console.error("[CostumeSwitch]", ...args); } catch(e){}; }

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function buildRegexFromPatterns(patterns) {
  const arr = (patterns || []).map(p => (p||'').trim()).filter(Boolean);
  if (!arr.length) return null;
  const pieces = arr.map(p => {
    const m = p.match(/^\/(.+)\/([gimsuy]*)$/);
    return m ? `(${m[1]})` : `(${escapeRegex(p)})`;
  });
  return new RegExp(`\\b(?:${pieces.join('|')})\\s*:`, 'i');
}

function getContextSafe() {
  try { if (typeof getContext === 'function') return getContext(); } catch(e) {}
  try { if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') return SillyTavern.getContext(); } catch(e) {}
  return null;
}

function ensureSettings() {
  // prefer live context storage, fallback to extension_settings import
  ctx = getContextSafe();
  if (ctx && ctx.extensionSettings) {
    ctx.extensionSettings[EXT_NAME] = ctx.extensionSettings[EXT_NAME] || structuredClone(DEFAULTS);
    settingsStorage = ctx.extensionSettings;
    saveSettingsFn = ctx.saveSettingsDebounced || saveSettingsDebounced;
    return;
  }
  if (typeof extension_settings !== 'undefined') {
    extension_settings[EXT_NAME] = extension_settings[EXT_NAME] || structuredClone(DEFAULTS);
    settingsStorage = extension_settings;
    saveSettingsFn = saveSettingsDebounced;
    ctx = null;
    return;
  }
  throw new Error("CostumeSwitch: cannot find extension settings storage.");
}

function getSettings() {
  return (settingsStorage && settingsStorage[EXT_NAME]) || DEFAULTS;
}

// Execute slash command using the most-direct available API so it works mid-stream
async function executeSlashCommand(command) {
  try {
    // 1) ctx.slashCommands.execute (preferred)
    if (ctx && ctx.slashCommands && typeof ctx.slashCommands.execute === 'function') {
      safeLog("executeSlashCommand -> using ctx.slashCommands.execute:", command);
      const res = ctx.slashCommands.execute(command);
      if (res && typeof res.then === 'function') await res;
      return true;
    }
    // 2) common global fn names
    const globalCandidates = [
      window.processSlashCommand,
      window.processCommand,
      window.handleSlashCommand,
      window.process_input_command,
      (window.SillyTavern && window.SillyTavern.processCommand) ? window.SillyTavern.processCommand : null,
      (window.SillyTavern && window.SillyTavern.handleCommand) ? window.SillyTavern.handleCommand : null,
    ];
    for (const fn of globalCandidates) {
      if (typeof fn === 'function') {
        safeLog("executeSlashCommand -> using global function:", fn.name || fn);
        const r = fn(command);
        if (r && typeof r.then === 'function') await r;
        return true;
      }
    }
    // 3) best-effort: emit MESSAGE_SENT (some ST setups may process this)
    if (ctx && ctx.eventSource && ctx.event_types && typeof ctx.eventSource.emit === 'function') {
      safeLog("executeSlashCommand -> emitting MESSAGE_SENT (fallback):", command);
      await ctx.eventSource.emit(ctx.event_types.MESSAGE_SENT || 'message_sent', { message: command, name: ctx.characters?.[ctx.characterId]?.name || '' });
      return true;
    }
    safeWarn("executeSlashCommand: no command runner found to execute:", command);
    return false;
  } catch (err) {
    safeError("executeSlashCommand error:", err);
    return false;
  }
}

// Fallback: try to type in the chat input and click send (only used if direct execution fails)
function inputSendFallback(command) {
  try {
    safeLog("inputSendFallback -> attempting to send via chat input:", command);
    const selectors = [
      '#prompt', '#prompt_input', '#send_textarea', '#send_input', '#chat_input', 'textarea#prompt', 'textarea#chat_input', 'textarea'
    ];
    let inputEl = null;
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) { inputEl = el; break; }
    }
    if (!inputEl) { safeWarn("inputSendFallback: input element not found"); return false; }

    const sendBtnSelectors = ['button[data-action="send"]', 'button.send', 'button#send', 'button[type="submit"]', 'button[title="Send"]'];
    let sendBtn = null;
    for (const s of sendBtnSelectors) {
      const b = document.querySelector(s);
      if (b) { sendBtn = b; break; }
    }

    // fill input
    if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') {
      inputEl.focus();
      inputEl.value = command;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (inputEl.isContentEditable) {
      inputEl.focus();
      inputEl.innerText = command;
      inputEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
    } else {
      safeWarn("inputSendFallback: unsupported input element");
      return false;
    }

    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
      safeLog("inputSendFallback: clicked send button");
      return true;
    } else if (sendBtn && sendBtn.disabled) {
      safeWarn("inputSendFallback: send button is disabled (likely streaming in progress)");
      return false;
    } else {
      // try to submit enclosing form
      const form = inputEl.closest('form');
      if (form) {
        try { form.requestSubmit ? form.requestSubmit() : form.submit(); safeLog("inputSendFallback: submitted enclosing form"); return true; } catch(e){ safeWarn("inputSendFallback form submit failed", e); return false; }
      }
    }
    return false;
  } catch (e) {
    safeError("inputSendFallback error:", e);
    return false;
  }
}

// Unified function to run a /costume command; tries direct execution first, falls back to input-send.
async function runCostumeCommand(rawArg) {
  if (!rawArg) return false;
  const command = `/costume ${rawArg}`;
  safeLog("runCostumeCommand -> attempting:", command);

  // 1) try direct runner
  const didDirect = await executeSlashCommand(command);
  if (didDirect) { safeLog("runCostumeCommand -> executed via direct runner"); return true; }

  // 2) fallback to input-send (may be blocked during streaming)
  const didInput = inputSendFallback(command);
  if (didInput) { safeLog("runCostumeCommand -> executed via input-send fallback"); return true; }

  // 3) queue until generation ends (if ctx available) and try then
  if (ctx && ctx.eventSource && ctx.event_types) {
    safeLog("runCostumeCommand -> queuing command until generation ends:", command);
    pendingQueueCommand(command);
    return true;
  }

  safeWarn("runCostumeCommand -> could not execute command by any method.");
  return false;
}

// If direct methods are unavailable, queue a command and send when generation ends.
let queuedCommand = null;
function pendingQueueCommand(command) {
  queuedCommand = command;
  // listen once for generation end events
  try {
    const et = ctx.event_types;
    ctx.eventSource.once(et.GENERATION_ENDED || 'GENERATION_ENDED', async () => {
      safeLog("pendingQueueCommand -> generation ended, trying queued command:", queuedCommand);
      if (queuedCommand) {
        // try direct runner then input fallback
        const ok = await executeSlashCommand(queuedCommand) || inputSendFallback(queuedCommand);
        safeLog("pendingQueueCommand -> attempted queued command, success:", !!ok);
        queuedCommand = null;
      }
    });
  } catch (e) {
    safeError("pendingQueueCommand error:", e);
  }
}

// ---------- MutationObserver logic ----------
function handleMutations(mutationsList) {
  try {
    let newText = "";
    for (const mut of mutationsList) {
      if (mut.type === "characterData") {
        // some MutationRecords have oldValue; guard
        const added = (mut.target && mut.target.textContent) || "";
        newText += added;
      } else if (mut.type === "childList") {
        for (const node of mut.addedNodes) {
          if (node && node.textContent) newText += node.textContent;
        }
      }
    }
    if (!newText) return;

    buffers.currentText += newText;

    if (!nameRegex) return;
    const m = buffers.currentText.match(nameRegex);
    if (m) {
      // find the first non-empty capture (pattern groups)
      let matched = null;
      for (let i = 1; i < m.length; i++) {
        if (m[i]) { matched = m[i].replace(/\s*:/,'').trim(); break; }
      }
      if (matched && matched !== lastDetectedCharacter) {
        lastDetectedCharacter = matched;
        safeLog("handleMutations -> detected speaker:", matched);
        // default behavior: try costume using name/name (you can change mapping later)
        const candidateArg = `${matched}/${matched}`;
        runCostumeCommand(candidateArg).then(() => {
          // reset timer
          clearTimeout(resetTimer);
          resetTimer = setTimeout(() => {
            // revert to default
            const s = getSettings();
            if (s && s.defaultCostume) {
              runCostumeCommand(s.defaultCostume);
            }
            lastDetectedCharacter = null;
          }, (getSettings().resetTimeoutMs || DEFAULTS.resetTimeoutMs));
        });
      }
    }
  } catch (err) {
    safeError("handleMutations error:", err);
  }
}

function startObservingLastMessage() {
  try {
    if (!getSettings().enabled) { safeLog("startObservingLastMessage -> disabled by settings"); return; }
    // selector from community guide; adapt if ST updates markup
    const lastMsg = document.querySelector('#chat > .mes:last-child.mes_text') || document.querySelector('#chat .mes:last-child');
    if (!lastMsg) { safeWarn("startObservingLastMessage -> no last message node found"); return; }
    buffers.currentText = lastMsg.textContent || "";
    lastDetectedCharacter = null;
    if (!observer) {
      observer = new MutationObserver(handleMutations);
    } else {
      observer.disconnect();
    }
    // Observe for characterData, childList and subtree changes
    observer.observe(lastMsg, { childList: true, subtree: true, characterData: true });
    safeLog("startObservingLastMessage -> observing node:", lastMsg);
  } catch (e) {
    safeError("startObservingLastMessage error:", e);
  }
}

function stopObserving() {
  try {
    if (observer) observer.disconnect();
    if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
    // final reset if desired
    const s = getSettings();
    if (s && s.defaultCostume && lastDetectedCharacter !== null) {
      runCostumeCommand(s.defaultCostume);
    }
    lastDetectedCharacter = null;
    buffers.currentText = "";
    safeLog("stopObserving -> observer stopped and cleaned up");
  } catch (e) {
    safeError("stopObserving error:", e);
  }
}

// ---------- UI injection ----------
function buildSettingsUI() {
  try {
    const settingsDiv = document.querySelector('#extensions_settings > .container') || document.querySelector('#extensions_settings');
    if (!settingsDiv) {
      safeWarn("buildSettingsUI -> extension settings container not found");
      return;
    }

    // Avoid multiple inserts
    if (document.querySelector('.st-costume-switcher-card')) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'st-costume-switcher-card';
    wrapper.style.padding = '8px';
    wrapper.style.marginTop = '10px';
    wrapper.style.border = '1px solid var(--border-color,#444)';
    wrapper.style.borderRadius = '6px';
    wrapper.innerHTML = `
      <h3 style="margin:0 0 8px 0;">Costume Switcher</h3>
      <label><input id="cs-enable" type="checkbox"> Enable real-time switching</label>
      <div style="margin-top:8px;">
        <label style="display:block;font-size:0.9em">Character name patterns (one per line)</label>
        <textarea id="cs-patterns" rows="4" style="width:100%;"></textarea>
      </div>
      <div style="margin-top:8px;">
        <label style="display:block;font-size:0.9em">Default costume (exact arg for /costume)</label>
        <input id="cs-default" type="text" style="width:100%;" placeholder="e.g. Date a Live">
      </div>
      <div style="margin-top:8px;">
        <label>Reset timeout (ms): <input id="cs-timeout" type="number" min="500" style="width:120px"></label>
      </div>
      <div style="margin-top:10px;">
        <button id="cs-save">Save</button>
        <button id="cs-reset" style="margin-left:8px;">Manual Reset Costume</button>
        <span id="cs-status" style="margin-left:10px;color:#aaa"></span>
      </div>
    `;
    settingsDiv.appendChild(wrapper);

    const s = getSettings();
    document.getElementById('cs-enable').checked = !!s.enabled;
    document.getElementById('cs-patterns').value = (s.patterns || []).join("\n");
    document.getElementById('cs-default').value = s.defaultCostume || "";
    document.getElementById('cs-timeout').value = s.resetTimeoutMs || DEFAULTS.resetTimeoutMs;

    document.getElementById('cs-save').addEventListener('click', () => {
      s.enabled = !!document.getElementById('cs-enable').checked;
      s.patterns = document.getElementById('cs-patterns').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
      s.defaultCostume = document.getElementById('cs-default').value.trim();
      s.resetTimeoutMs = parseInt(document.getElementById('cs-timeout').value || DEFAULTS.resetTimeoutMs, 10);
      if (saveSettingsFn) saveSettingsFn();
      nameRegex = buildRegexFromPatterns(s.patterns || DEFAULTS.patterns);
      document.getElementById('cs-status').textContent = "Saved";
      setTimeout(()=>document.getElementById('cs-status').textContent = "", 1200);
      safeLog("Settings saved:", s);
    });

    document.getElementById('cs-reset').addEventListener('click', async () => {
      const s = getSettings();
      if (!s.defaultCostume) {
        safeWarn("Manual reset: no default costume configured");
        return;
      }
      // execute immediately via direct runner
      const ok = await runCostumeCommand(s.defaultCostume);
      safeLog("Manual reset attempted, ok:", ok);
    });
  } catch (e) {
    safeError("buildSettingsUI error:", e);
  }
}

// ---------- Startup: wire into ST events ----------
jQuery(async () => {
  try {
    safeLog("Initializing CostumeSwitch extension...");
    ensureSettings();
    const s = getSettings();
    nameRegex = buildRegexFromPatterns(s.patterns || DEFAULTS.patterns);

    // Build settings UI when DOM ready
    try { buildSettingsUI(); } catch(e) { safeWarn("UI build failed:", e); }

    // Acquire context (again) and hook generation events
    ctx = ctx || getContextSafe();
    if (!ctx) {
      safeWarn("SillyTavern context not found; extension will remain inactive until context available.");
      // Try one more time later (after app_ready)
      document.addEventListener('DOMContentLoaded', () => { buildSettingsUI(); ctx = getContextSafe(); });
      return;
    }

    // Listen to generation lifecycle events to start/stop observer
    const es = ctx.eventSource;
    const et = ctx.event_types || {};
    const genStart = et.GENERATION_AFTER_COMMANDS || et.GENERATION_STARTED || 'GENERATION_AFTER_COMMANDS';
    const genEnd = et.GENERATION_ENDED || 'GENERATION_ENDED';
    const genStop = et.GENERATION_STOPPED || 'GENERATION_STOPPED';

    try {
      es.on(genStart, () => {
        safeLog("Generation started - starting observer");
        // small delay to let the DOM create the last message node
        setTimeout(startObservingLastMessage, 40);
      });
      es.on(genEnd, () => {
        safeLog("Generation ended - stopping observer");
        stopObserving();
        // if a queued command exists, pendingQueueCommand will handle it when generation ends
      });
      es.on(genStop, () => {
        safeLog("Generation stopped - stopping observer");
        stopObserving();
      });
    } catch (e) {
      safeWarn("Failed to attach to eventSource generation events:", e);
    }

    // Also watch for manual toggles to reload the regex
    // Not strictly necessary but helpful: re-build regex when settings change externally
    if (ctx && ctx.eventSource && ctx.event_types) {
      try {
        ctx.eventSource.on(ctx.event_types.SETTINGS_UPDATED || 'settings_updated', () => {
          const s2 = getSettings();
          nameRegex = buildRegexFromPatterns(s2.patterns || DEFAULTS.patterns);
        });
      } catch(e){ /* ignore */ }
    }

    safeLog("CostumeSwitch initialized. Patterns regex:", nameRegex);
  } catch (err) {
    safeError("CostumeSwitch init error:", err);
  }
});
