// index.js - SillyTavern-CostumeSwitch (patched with aggressive manual-reset diagnostics)
// Drop into: data/default-user/extensions/SillyTavern-CostumeSwitch/index.js

import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const EXT_NAME = "SillyTavern-CostumeSwitch";

const DEFAULTS = {
  enabled: true,
  patterns: ["Shido", "Kotori"], // one per line in UI
  defaultCostume: "Date a Live",  // exact arg used for manual reset
  resetTimeoutMs: 3000
};

let settingsStorage = null;
let saveSettingsFn = null;
let ctx = null;
let nameRegex = null;
let observer = null;
let lastDetectedCharacter = null;
let resetTimer = null;
let queuedCommand = null;
const buffers = { currentText: "" };

// ---------- Helpers ----------
function safeLog(...args) { try { console.log("[CostumeSwitch]", ...args); } catch(e){} }
function safeWarn(...args) { try { console.warn("[CostumeSwitch]", ...args); } catch(e){} }
function safeError(...args) { try { console.error("[CostumeSwitch]", ...args); } catch(e){}; }

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Build a regex from patterns: plain strings or /regex/ literals.
 * Matches anywhere; optional colon/dash after a name.
 */
function buildRegexFromPatterns(patterns) {
  const arr = (patterns || []).map(p => (p||'').trim()).filter(Boolean);
  if (!arr.length) return null;
  const pieces = arr.map(p => {
    const m = p.match(/^\/(.+)\/([gimsuy]*)$/);
    return m ? `(${m[1]})` : `(${escapeRegex(p)})`;
  });
  return new RegExp(`(?:${pieces.join('|')})(?:\\s*[:—-])?`, 'i');
}

function getContextSafe() {
  try { if (typeof getContext === 'function') return getContext(); } catch(e) {}
  try { if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') return SillyTavern.getContext(); } catch(e) {}
  return null;
}

function ensureSettings() {
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

// ---------- Command Execution ----------
async function executeSlashCommand(command) {
  try {
    // 1) newest global helper
    if (typeof window.sendMessage === 'function') {
      safeLog("executeSlashCommand -> using window.sendMessage:", command);
      try { window.sendMessage(command); return true; } catch(e){ safeWarn("window.sendMessage threw", e); }
    }

    // 2) ctx.slashCommands.execute
    if (ctx && ctx.slashCommands && typeof ctx.slashCommands.execute === 'function') {
      safeLog("executeSlashCommand -> using ctx.slashCommands.execute:", command);
      try {
        const res = ctx.slashCommands.execute(command);
        if (res && typeof res.then === 'function') await res;
        return true;
      } catch(e){ safeWarn("ctx.slashCommands.execute threw", e); }
    }

    // 3) legacy global names
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
        try {
          const r = fn(command);
          if (r && typeof r.then === 'function') await r;
          return true;
        } catch(e) { safeWarn("legacy global runner threw", e); }
      }
    }

    // 4) event emit fallback
    if (ctx && ctx.eventSource && ctx.event_types && typeof ctx.eventSource.emit === 'function') {
      safeLog("executeSlashCommand -> emitting MESSAGE_SENT (fallback):", command);
      try {
        await ctx.eventSource.emit(ctx.event_types.MESSAGE_SENT || 'message_sent', { message: command, name: ctx.characters?.[ctx.characterId]?.name || '' });
        return true;
      } catch(e){ safeWarn("eventSource.emit fallback threw", e); }
    }

    safeWarn("executeSlashCommand: no command runner found to execute:", command);
    return false;
  } catch (err) {
    safeError("executeSlashCommand error:", err);
    return false;
  }
}

function inputSendFallback(command) {
  try {
    safeLog("inputSendFallback -> attempting to send via chat input:", command);
    const selectors = [
      '#prompt', '#prompt_input', '#send_textarea', '#send_input', '#chat_input', 'textarea#prompt', 'textarea#chat_input', 'textarea', 'input[type="text"]'
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

async function runCostumeCommand(rawArg) {
  if (!rawArg) return false;
  const command = `/costume ${rawArg}`;
  safeLog("runCostumeCommand -> attempting:", command);

  const didDirect = await executeSlashCommand(command);
  if (didDirect) { safeLog("runCostumeCommand -> executed via direct runner"); return true; }

  const didInput = inputSendFallback(command);
  if (didInput) { safeLog("runCostumeCommand -> executed via input-send fallback"); return true; }

  if (ctx && ctx.eventSource && ctx.event_types) {
    safeLog("runCostumeCommand -> queuing command until generation ends:", command);
    pendingQueueCommand(command);
    return true;
  }

  safeWarn("runCostumeCommand -> could not execute command by any method.");
  return false;
}

function pendingQueueCommand(command) {
  queuedCommand = command;
  try {
    const et = ctx.event_types || {};
    const evName = et.GENERATION_ENDED || 'GENERATION_ENDED';
    if (typeof ctx.eventSource.once === 'function') {
      ctx.eventSource.once(evName, async () => {
        safeLog("pendingQueueCommand -> generation ended, trying queued command:", queuedCommand);
        if (queuedCommand) {
          const ok = await executeSlashCommand(queuedCommand) || inputSendFallback(queuedCommand);
          safeLog("pendingQueueCommand -> attempted queued command, success:", !!ok);
          queuedCommand = null;
        }
      });
    } else if (typeof ctx.eventSource.on === 'function') {
      const handler = async () => {
        safeLog("pendingQueueCommand -> generation ended (on), trying queued command:", queuedCommand);
        if (queuedCommand) {
          const ok = await executeSlashCommand(queuedCommand) || inputSendFallback(queuedCommand);
          safeLog("pendingQueueCommand -> attempted queued command, success:", !!ok);
          queuedCommand = null;
        }
        try { ctx.eventSource.off && ctx.eventSource.off(evName, handler); } catch(e) {}
      };
      ctx.eventSource.on(evName, handler);
    } else {
      safeWarn("pendingQueueCommand: eventSource has no on/once; cannot queue reliably");
    }
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
      let matched = null;
      if (m.length > 1) {
        for (let i = 1; i < m.length; i++) {
          if (m[i]) { matched = m[i].replace(/\s*[:—-]\s*$/,'').trim(); break; }
        }
      }
      if (!matched) matched = (m[0] || "").replace(/\s*[:—-]\s*$/,'').trim();

      if (matched && matched !== lastDetectedCharacter) {
        lastDetectedCharacter = matched;
        safeLog("handleMutations -> detected speaker:", matched);
        const candidateArg = `${matched}/${matched}`;
        runCostumeCommand(candidateArg).then(() => {
          clearTimeout(resetTimer);
          resetTimer = setTimeout(() => {
            const s = getSettings();
            if (s && s.defaultCostume) {
              runCostumeCommand(s.defaultCostume);
            }
            lastDetectedCharacter = null;
          }, (getSettings().resetTimeoutMs || DEFAULTS.resetTimeoutMs));
        }).catch(e => safeWarn("runCostumeCommand promise rejected", e));
      }
    }
  } catch (err) {
    safeError("handleMutations error:", err);
  }
}

function startObservingLastMessage() {
  try {
    if (!getSettings().enabled) { safeLog("startObservingLastMessage -> disabled by settings"); return; }
    const lastMsg = document.querySelector('#chat .mes:last-child .mes_text') || document.querySelector('#chat .mes:last-child');
    if (!lastMsg) { safeWarn("startObservingLastMessage -> no last message node found"); return; }
    buffers.currentText = "";
    lastDetectedCharacter = null;
    if (!observer) {
      observer = new MutationObserver(handleMutations);
    } else {
      observer.disconnect();
    }
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
        <button id="cs-test-direct" style="margin-left:8px;">Test Direct Send</button>
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
      // Provide immediate UI feedback
      const statusEl = document.getElementById('cs-status');
      if (statusEl) statusEl.textContent = "Sending...";
      safeLog("Manual reset clicked - attempting runCostumeCommand for:", s.defaultCostume);

      const ok = await runCostumeCommand(s.defaultCostume);
      safeLog("Manual reset result (runCostumeCommand):", ok);

      if (ok) {
        if (statusEl) statusEl.textContent = "Sent";
        setTimeout(()=>{ if (statusEl) statusEl.textContent = ""; }, 1500);
        return;
      }

      // If runCostumeCommand returned false, try raw window.sendMessage as last effort
      let directOk = false;
      try {
        if (typeof window.sendMessage === 'function') {
          window.sendMessage(`/costume ${s.defaultCostume}`);
          directOk = true;
          safeLog("Manual reset: window.sendMessage direct attempt done");
        }
      } catch(e) { safeWarn("Manual reset: window.sendMessage direct attempt threw", e); }

      if (directOk) {
        if (statusEl) statusEl.textContent = "Sent (direct)";
        setTimeout(()=>{ if (statusEl) statusEl.textContent = ""; }, 1500);
        return;
      }

      // If still not ok but ctx exists, queue the command
      if (ctx && ctx.eventSource && ctx.event_types) {
        pendingQueueCommand(`/costume ${s.defaultCostume}`);
        if (statusEl) statusEl.textContent = "Queued until generation end";
        setTimeout(()=>{ if (statusEl) statusEl.textContent = ""; }, 3000);
        return;
      }

      if (statusEl) statusEl.textContent = "Failed";
      setTimeout(()=>{ if (statusEl) statusEl.textContent = ""; }, 2000);
    });

    // Test direct send button: calls window.sendMessage directly (useful for debugging)
    document.getElementById('cs-test-direct').addEventListener('click', () => {
      const s = getSettings();
      const statusEl = document.getElementById('cs-status');
      try {
        if (typeof window.sendMessage === 'function') {
          window.sendMessage(`/costume ${s.defaultCostume}`);
          safeLog("Test Direct Send: Called window.sendMessage");
          if (statusEl) { statusEl.textContent = "Direct send called"; setTimeout(()=>statusEl.textContent="",1200); }
        } else {
          safeWarn("Test Direct Send: window.sendMessage not found");
          if (statusEl) { statusEl.textContent = "window.sendMessage missing"; setTimeout(()=>statusEl.textContent="",1500); }
        }
      } catch(e) {
        safeError("Test Direct Send threw:", e);
        if (statusEl) { statusEl.textContent = "Direct send error"; setTimeout(()=>statusEl.textContent="",2000); }
      }
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

    try { buildSettingsUI(); } catch(e) { safeWarn("UI build failed:", e); }

    ctx = ctx || getContextSafe();
    if (!ctx) {
      safeWarn("SillyTavern context not found; extension will remain inactive until context available.");
      document.addEventListener('DOMContentLoaded', () => { buildSettingsUI(); ctx = getContextSafe(); });
      return;
    }

    const es = ctx.eventSource;
    const et = ctx.event_types || {};
    const genStart = et.GENERATION_STARTED || et.GENERATION_AFTER_COMMANDS || 'GENERATION_STARTED';
    const genEnd = et.GENERATION_ENDED || 'GENERATION_ENDED';
    const genStop = et.GENERATION_STOPPED || 'GENERATION_STOPPED';

    try {
      es.on(genStart, () => {
        safeLog("Generation started - starting observer");
        setTimeout(startObservingLastMessage, 200);
      });
      es.on(genEnd, () => {
        safeLog("Generation ended - stopping observer");
        stopObserving();
      });
      es.on(genStop, () => {
        safeLog("Generation stopped - stopping observer");
        stopObserving();
      });
    } catch (e) {
      safeWarn("Failed to attach to eventSource generation events:", e);
    }

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
