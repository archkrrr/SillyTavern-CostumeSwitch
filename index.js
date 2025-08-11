// index.js - SillyTavern-CostumeSwitch (aggressive command runner + diagnostics)
// Drop into: data/default-user/extensions/SillyTavern-CostumeSwitch/index.js

import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

// --- START: sendMessage shim (add right after imports) ---
(function defineSendMessageShim(){
  // don't overwrite if already present
  if (typeof window !== 'undefined' && typeof window.sendMessage === 'function') {
    console.info('[CostumeSwitch] sendMessage already defined');
    return;
  }

  const POLL_INTERVAL = 200; // ms
  const MAX_TRIES = 300; // ~60s timeout
  let tries = 0;
  let poll = null;

  // small helper that turns a found context into a sendMessage impl
  function attachForContext(c){
    if (!c) return false;
    const hasExec = !!(c.slashCommands && typeof c.slashCommands.execute === 'function');
    const hasProc = typeof c.processCommand === 'function';
    if (!hasExec && !hasProc) return false;

    const impl = async function(cmd){
      try {
        if (hasExec) {
          const r = c.slashCommands.execute(cmd);
          if (r && typeof r.then === 'function') return await r;
          return r;
        }
        if (hasProc) {
          const r = c.processCommand(cmd);
          if (r && typeof r.then === 'function') return await r;
          return r;
        }
      } catch (err) {
        console.error('[CostumeSwitch] sendMessage impl threw:', err);
        throw err;
      }
    };

    try {
      // define non-enumerable to be polite
      Object.defineProperty(window, 'sendMessage', {
        value: impl,
        writable: false,
        configurable: false,
        enumerable: false
      });
      console.info('[CostumeSwitch] sendMessage shim defined (attached to context).');
      return true;
    } catch(e){
      console.warn('[CostumeSwitch] failed to define sendMessage on window:', e);
      return false;
    }
  }

  function tryFindAndAttach(){
    tries++;
    // 1) use your extension's getContext if available (this fn exists in your file)
    try {
      const maybeCtx = (typeof getContext === 'function') ? getContext() : null;
      if (maybeCtx && attachForContext(maybeCtx)) { clearInterval(poll); return; }
    } catch(e){ /* ignore */ }

    // 2) common global context holders
    const candPaths = [
      window.ctx,
      window.app,
      (window.SillyTavern && typeof window.SillyTavern.getContext === 'function' ? window.SillyTavern.getContext() : null),
      window.__APP_CONTEXT__,
      window.__SILLY_TAVERN__
    ];
    for (const c of candPaths){
      if (c && attachForContext(c)) { clearInterval(poll); return; }
    }

    // 3) brute-force scan window for an object exposing the handler (safe try/catch)
    try {
      for (const k of Object.keys(window)){
        if (tries % 5 !== 0 && k.length > 40) continue; // a small perf hack
        try {
          const v = window[k];
          if (!v || typeof v !== 'object') continue;
          if ((v.slashCommands && typeof v.slashCommands.execute === 'function') || typeof v.processCommand === 'function'){
            if (attachForContext(v)) { clearInterval(poll); return; }
          }
        } catch(e){}
      }
    } catch(e){ /* ignore */ }

    if (tries >= MAX_TRIES){
      clearInterval(poll);
      console.warn('[CostumeSwitch] sendMessage shim: timed out waiting for app context.');
    }
  }

  try {
    // first immediate attempt (no wait)
    tryFindAndAttach();
    // then poll
    poll = setInterval(tryFindAndAttach, POLL_INTERVAL);
  } catch(e){
    console.error('[CostumeSwitch] sendMessage shim outer error', e);
    if (poll) clearInterval(poll);
  }
})();
// --- END: sendMessage shim ---


const EXT_NAME = "SillyTavern-CostumeSwitch";

const DEFAULTS = {
  enabled: true,
  patterns: ["Shido", "Kotori"],
  defaultCostume: "Date a Live",
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

function safeLog(...a){ try{ console.log("[CostumeSwitch]", ...a); }catch{} }
function safeWarn(...a){ try{ console.warn("[CostumeSwitch]", ...a); }catch{} }
function safeError(...a){ try{ console.error("[CostumeSwitch]", ...a); }catch{} }

function escapeRegex(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
function buildRegexFromPatterns(patterns){
  const arr = (patterns||[]).map(p=> (p||'').trim()).filter(Boolean);
  if(!arr.length) return null;
  const pieces = arr.map(p=>{
    const m = p.match(/^\/(.+)\/([gimsuy]*)$/);
    return m ? `(${m[1]})` : `(${escapeRegex(p)})`;
  });
  return new RegExp(`(?:${pieces.join('|')})(?:\\s*[:—-])?`,'i');
}

function getContextSafe(){
  try{ if(typeof getContext==='function') return getContext(); }catch(e){}
  try{ if(typeof SillyTavern!=='undefined' && typeof SillyTavern.getContext==='function') return SillyTavern.getContext(); }catch(e){}
  return null;
}

function ensureSettings(){
  ctx = getContextSafe();
  if (ctx && ctx.extensionSettings){
    ctx.extensionSettings[EXT_NAME] = ctx.extensionSettings[EXT_NAME] || structuredClone(DEFAULTS);
    settingsStorage = ctx.extensionSettings;
    saveSettingsFn = ctx.saveSettingsDebounced || saveSettingsDebounced;
    return;
  }
  if (typeof extension_settings !== 'undefined'){
    extension_settings[EXT_NAME] = extension_settings[EXT_NAME] || structuredClone(DEFAULTS);
    settingsStorage = extension_settings;
    saveSettingsFn = saveSettingsDebounced;
    ctx = null;
    return;
  }
  throw new Error("CostumeSwitch: cannot find extension settings storage.");
}

function getSettings(){ return (settingsStorage && settingsStorage[EXT_NAME]) || DEFAULTS; }

/* ========== AGGRESSIVE COMMAND RUNNER ========== */

/**
 * discoverPotentialRunners - returns array of {name, fn} found on window, window.SillyTavern, ctx
 * but does NOT call them.
 */
function discoverPotentialRunners(){
  const results = [];
  try {
    const scanObj = (obj, label) => {
      if (!obj || typeof obj !== 'object') return;
      Object.keys(obj).forEach(k=>{
        try {
          const v = obj[k];
          if (typeof v === 'function' && /send|message|process|command|slash/i.test(k)){
            results.push({ name: `${label}.${k}`, fn: v });
          }
        } catch(e){}
      });
    };
    scanObj(window, 'window');
    scanObj(window.SillyTavern, 'window.SillyTavern');
    scanObj(ctx, 'ctx');
  } catch(e){
    safeWarn("discoverPotentialRunners error", e);
  }
  return results;
}

/**
 * tryFunctionSafely - call fn(command) with try/catch, await if Promise, return true/false
 */
async function tryFunctionSafely(fn, command){
  try {
    const r = fn(command);
    if (r && typeof r.then === 'function') await r;
    return true;
  } catch(e){
    safeWarn("runner threw:", e);
    return false;
  }
}

/**
 * sendViaKeyboardEnter - fallback that focuses the input, sets value, and fires Enter keydown/keyup.
 * Returns true if input element was found and events dispatched.
 */
function sendViaKeyboardEnter(command){
  try {
    const selectors = ['#prompt', '#prompt_input', '#send_textarea', '#send_input', '#chat_input', 'textarea#prompt', 'textarea#chat_input', 'textarea', 'input[type="text"]'];
    let inputEl = null;
    for (const s of selectors){
      const el = document.querySelector(s);
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)){
        inputEl = el; break;
      }
    }
    if (!inputEl) return false;

    // set value
    if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT'){
      inputEl.focus();
      inputEl.value = command;
      inputEl.dispatchEvent(new Event('input', {bubbles:true}));
    } else if (inputEl.isContentEditable){
      inputEl.focus();
      inputEl.innerText = command;
      inputEl.dispatchEvent(new InputEvent('input', {bubbles:true}));
    }

    // attempt Enter key simulation
    const down = new KeyboardEvent('keydown', {key:'Enter', code:'Enter', bubbles:true, cancelable:true});
    const up = new KeyboardEvent('keyup', {key:'Enter', code:'Enter', bubbles:true, cancelable:true});
    inputEl.dispatchEvent(down);
    inputEl.dispatchEvent(up);

    return true;
  } catch(e){
    safeWarn("sendViaKeyboardEnter failed", e);
    return false;
  }
}

/**
 * executeSlashCommand - tries multiple avenues and logs which path worked.
 * returns true if any path executed successfully, false otherwise.
 */
async function executeSlashCommand(command){
  try {
    safeLog("executeSlashCommand -> trying command:", command);

    // 1) window.sendMessage (fast path)
    if (typeof window.sendMessage === 'function'){
      safeLog("attempting window.sendMessage");
      try { window.sendMessage(command); safeLog("window.sendMessage invoked"); return true; } catch(e){ safeWarn("window.sendMessage threw", e); }
    }

    // 2) ctx.slashCommands.execute
    if (ctx && ctx.slashCommands && typeof ctx.slashCommands.execute === 'function'){
      safeLog("attempting ctx.slashCommands.execute");
      try { const res = ctx.slashCommands.execute(command); if (res && typeof res.then === 'function') await res; safeLog("ctx.slashCommands.execute succeeded"); return true; } catch(e){ safeWarn("ctx.slashCommands.execute threw", e); }
    }

    // 3) scan discovered plausible functions and attempt them (in order)
    const candidates = discoverPotentialRunners();
    safeLog("discovered runner candidates:", candidates.map(c=>c.name));
    for (const c of candidates){
      try {
        safeLog("attempting", c.name);
        const ok = await tryFunctionSafely(c.fn, command);
        if (ok) { safeLog(`${c.name} succeeded`); return true; }
      } catch(e){ safeWarn("candidate attempt error", e); }
    }

    // 4) attempt to emit an event (legacy fallback)
    if (ctx && ctx.eventSource && ctx.event_types && typeof ctx.eventSource.emit === 'function'){
      const ev = ctx.event_types.MESSAGE_SENT || ctx.event_types.MESSAGE || 'message_sent';
      safeLog("attempting eventSource.emit fallback ->", ev);
      try {
        await ctx.eventSource.emit(ev, { message: command, name: ctx.characters?.[ctx.characterId]?.name || '' });
        safeLog("eventSource.emit returned");
        // don't assume success, but return true to indicate we tried
        return true;
      } catch(e){ safeWarn("eventSource.emit threw", e); }
    }

    // 5) try keyboard/input fallback
    safeLog("attempting keyboard/input fallback");
    const inputOk = sendViaKeyboardEnter(command);
    if (inputOk){ safeLog("keyboard/input fallback dispatched"); return true; }

    safeWarn("executeSlashCommand -> no viable send method found");
    return false;
  } catch(e){
    safeError("executeSlashCommand outer error", e);
    return false;
  }
}

/* ========== remaining code largely unchanged (observer, ui, etc.) ========== */

function inputSendFallback(command){ return sendViaKeyboardEnter(command); }

async function runCostumeCommand(rawArg){
  if (!rawArg) return false;
  const command = `/costume ${rawArg}`;
  safeLog("runCostumeCommand -> attempting:", command);

  // try direct runner
  const did = await executeSlashCommand(command);
  if (did) { safeLog("runCostumeCommand -> executeSlashCommand returned true"); return true; }

  // fallback: queue if possible
  if (ctx && ctx.eventSource && ctx.event_types) {
    safeLog("runCostumeCommand -> queuing command until generation ends:", command);
    pendingQueueCommand(command);
    return true;
  }

  safeWarn("runCostumeCommand -> could not dispatch command");
  return false;
}

function pendingQueueCommand(command){
  queuedCommand = command;
  try {
    const et = ctx.event_types || {};
    const ev = et.GENERATION_ENDED || 'GENERATION_ENDED';
    if (typeof ctx.eventSource.once === 'function'){
      ctx.eventSource.once(ev, async () => {
        safeLog("pendingQueueCommand -> generation ended, trying queued command:", queuedCommand);
        if (queuedCommand) {
          await executeSlashCommand(queuedCommand) || inputSendFallback(queuedCommand);
          queuedCommand = null;
        }
      });
    } else if (typeof ctx.eventSource.on === 'function'){
      const handler = async () => {
        safeLog("pendingQueueCommand (on) -> generation ended, trying queued command:", queuedCommand);
        if (queuedCommand) {
          await executeSlashCommand(queuedCommand) || inputSendFallback(queuedCommand);
          queuedCommand = null;
        }
        try { ctx.eventSource.off && ctx.eventSource.off(ev, handler); } catch(e){}
      };
      ctx.eventSource.on(ev, handler);
    } else {
      safeWarn("pendingQueueCommand: cannot attach listener");
    }
  } catch(e) { safeError("pendingQueueCommand error", e); }
}

/* MutationObserver logic (unchanged except using nameRegex variable) */
function handleMutations(mutationsList){
  try {
    let newText = "";
    for (const mut of mutationsList){
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
    if (m){
      let matched = null;
      if (m.length > 1){
        for (let i=1;i<m.length;i++){
          if (m[i]) { matched = m[i].replace(/\s*[:—-]\s*$/,'').trim(); break; }
        }
      }
      if (!matched) matched = (m[0]||'').replace(/\s*[:—-]\s*$/,'').trim();
      if (matched && matched !== lastDetectedCharacter){
        lastDetectedCharacter = matched;
        safeLog("handleMutations -> detected speaker:", matched);
        const candidateArg = `${matched}/${matched}`;
        runCostumeCommand(candidateArg).then(()=> {
          clearTimeout(resetTimer);
          resetTimer = setTimeout(()=> {
            const s = getSettings();
            if (s && s.defaultCostume) runCostumeCommand(s.defaultCostume);
            lastDetectedCharacter = null;
          }, (getSettings().resetTimeoutMs || DEFAULTS.resetTimeoutMs));
        });
      }
    }
  } catch(e){ safeError("handleMutations error", e); }
}

function startObservingLastMessage(){
  try {
    if (!getSettings().enabled) { safeLog("startObservingLastMessage -> disabled by settings"); return; }
    const lastMsg = document.querySelector('#chat .mes:last-child .mes_text') || document.querySelector('#chat .mes:last-child');
    if (!lastMsg) { safeWarn("startObservingLastMessage -> no last message node found"); return; }
    buffers.currentText = "";
    lastDetectedCharacter = null;
    if (!observer) observer = new MutationObserver(handleMutations);
    else observer.disconnect();
    observer.observe(lastMsg, { childList: true, subtree: true, characterData: true });
    safeLog("startObservingLastMessage -> observing node:", lastMsg);
  } catch(e){ safeError("startObservingLastMessage error", e); }
}

function stopObserving(){
  try {
    if (observer) observer.disconnect();
    if (resetTimer){ clearTimeout(resetTimer); resetTimer = null; }
    const s = getSettings();
    if (s && s.defaultCostume && lastDetectedCharacter !== null) runCostumeCommand(s.defaultCostume);
    lastDetectedCharacter = null;
    buffers.currentText = "";
    safeLog("stopObserving -> stopped");
  } catch(e){ safeError("stopObserving error", e); }
}

/* UI */
function buildSettingsUI(){
  try {
    const settingsDiv = document.querySelector('#extensions_settings > .container') || document.querySelector('#extensions_settings');
    if (!settingsDiv) { safeWarn("buildSettingsUI -> container not found"); return; }
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
      if (!s.defaultCostume) { safeWarn("Manual reset: no default costume configured"); return; }
      const statusEl = document.getElementById('cs-status');
      if (statusEl) statusEl.textContent = "Sending...";
      safeLog("Manual reset clicked - attempting runCostumeCommand for:", s.defaultCostume);
      const ok = await runCostumeCommand(s.defaultCostume);
      safeLog("Manual reset result:", ok);
      if (ok) { if (statusEl) { statusEl.textContent = "Sent"; setTimeout(()=>statusEl.textContent='',1200); } return; }
      // Try direct call if available
      let directOk = false;
      try {
        if (typeof window.sendMessage === 'function') {
          window.sendMessage(`/costume ${s.defaultCostume}`);
          directOk = true;
          safeLog("Manual reset: window.sendMessage direct attempt done");
        }
      } catch(e){ safeWarn("Manual reset direct send threw", e); }
      if (directOk) { if (statusEl) { statusEl.textContent = "Sent (direct)"; setTimeout(()=>statusEl.textContent='',1200); } return; }
      if (ctx && ctx.eventSource && ctx.event_types) {
        pendingQueueCommand(`/costume ${s.defaultCostume}`);
        if (statusEl) { statusEl.textContent = "Queued until generation end"; setTimeout(()=>statusEl.textContent='',3000); }
        return;
      }
      if (statusEl) { statusEl.textContent = "Failed"; setTimeout(()=>statusEl.textContent='',1500); }
    });

    document.getElementById('cs-test-direct').addEventListener('click', () => {
      const s = getSettings();
      const statusEl = document.getElementById('cs-status');
      try {
        if (typeof window.sendMessage === 'function') {
          window.sendMessage(`/costume ${s.defaultCostume}`);
          safeLog("Test Direct Send: Called window.sendMessage");
          if (statusEl) { statusEl.textContent = "Direct send called"; setTimeout(()=>statusEl.textContent='',1200); }
        } else {
          safeWarn("Test Direct Send: window.sendMessage not found");
          if (statusEl) { statusEl.textContent = "window.sendMessage missing"; setTimeout(()=>statusEl.textContent='',1500); }
        }
      } catch(e) {
        safeError("Test Direct Send threw:", e);
        if (statusEl) { statusEl.textContent = "Direct send error"; setTimeout(()=>statusEl.textContent='',2000); }
      }
    });

  } catch(e){ safeError("buildSettingsUI error", e); }
}

/* Startup */
jQuery(async () => {
  try {
    safeLog("Initializing CostumeSwitch...");
    ensureSettings();
    const s = getSettings();
    nameRegex = buildRegexFromPatterns(s.patterns || DEFAULTS.patterns);
    try { buildSettingsUI(); } catch(e) { safeWarn("UI build failed", e); }
    ctx = ctx || getContextSafe();
    if (!ctx) {
      safeWarn("Context not found; extension will idle until available.");
      document.addEventListener('DOMContentLoaded', () => { buildSettingsUI(); ctx = getContextSafe(); });
      return;
    }
    const es = ctx.eventSource;
    const et = ctx.event_types || {};
    const genStart = et.GENERATION_STARTED || et.GENERATION_AFTER_COMMANDS || 'GENERATION_STARTED';
    const genEnd = et.GENERATION_ENDED || 'GENERATION_ENDED';
    const genStop = et.GENERATION_STOPPED || 'GENERATION_STOPPED';
    try {
      es.on(genStart, () => { safeLog("Generation started"); setTimeout(startObservingLastMessage, 200); });
      es.on(genEnd, () => { safeLog("Generation ended"); stopObserving(); });
      es.on(genStop, () => { safeLog("Generation stopped"); stopObserving(); });
    } catch(e){ safeWarn("Failed to attach generation events", e); }
    if (ctx && ctx.eventSource && ctx.event_types) {
      try {
        ctx.eventSource.on(ctx.event_types.SETTINGS_UPDATED || 'settings_updated', () => {
          const s2 = getSettings();
          nameRegex = buildRegexFromPatterns(s2.patterns || DEFAULTS.patterns);
        });
      } catch(e){}
    }
    safeLog("CostumeSwitch initialized. Patterns regex:", nameRegex);
  } catch(e){ safeError("init error", e); }
});
