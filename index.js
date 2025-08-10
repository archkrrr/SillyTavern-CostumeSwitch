(function () {
  // prevent double-load
  if (window.__dynamic_costumer_loaded) return;
  window.__dynamic_costumer_loaded = true;

  const EXT_NAME = 'dynamic_costumer';

  // default settings
  const DEFAULT_SETTINGS = {
    enabled: false,
    inactivityTimeoutMs: 300000 // 5 minutes
  };

  // runtime state
  let settings = { ...DEFAULT_SETTINGS };
  let inactivityTimer = null;
  let costumeLock = false;
  let currentCostume = null;
  let costumeMap = []; // array of {name, regex, target}
  let defaultCostume = 'default';
  let processedTextLength = 0;
  let observer = null;
  let targetNode = null;
  let ctx = null;

  function safeLog(...args) { console.log('[DynamicCostumer]', ...args); }
  function safeWarn(...args) { console.warn('[DynamicCostumer]', ...args); }
  function safeErr(...args) { console.error('[DynamicCostumer]', ...args); }

  // Try to execute a costume command using STscript if available; otherwise fallback.
  function executeCostumeCommand(costumeName) {
    if (!costumeName) return;
    const command = `/costume ${costumeName}`;

    try {
      // Preferred: direct STscript runner (common pattern)
      if (window.SillyTavern && window.SillyTavern.STscript && typeof window.SillyTavern.STscript.run === 'function') {
        window.SillyTavern.STscript.run(command);
        return true;
      }

      // Alternative hooks (try a couple of likely names defensively)
      if (window.SillyTavern && typeof window.SillyTavern.runSTscript === 'function') {
        window.SillyTavern.runSTscript(command);
        return true;
      }

      // As a last fallback — simulate a small script-run via any exposed command parser
      const ctx = SillyTavern.getContext && SillyTavern.getContext();
      if (ctx && ctx.STscript && typeof ctx.STscript.run === 'function') {
        ctx.STscript.run(command);
        return true;
      }
    } catch (err) {
      safeWarn('STscript-run attempt failed:', err);
    }

    // Final fallback: DOM-based send (fragile but last resort)
    try {
      const input = document.querySelector('textarea, input[type="text"]');
      if (!input) throw new Error('chat input not found');
      const orig = input.value;
      input.value = command;
      // trigger input events if needed
      input.dispatchEvent(new Event('input', { bubbles: true }));
      // find send button
      const sendBtn = document.querySelector('button[type="submit"], .SillyTavern--send-btn');
      if (sendBtn) {
        sendBtn.click();
        input.value = orig; // restore
        input.dispatchEvent(new Event('input', { bubbles: true }));
        safeWarn('Used DOM fallback to send command. This is fragile — prefer STscript runner.');
        return true;
      } else {
        input.value = orig;
      }
    } catch (err) {
      safeWarn('DOM fallback failed:', err);
    }

    safeErr('Could not execute costume command programmatically. STscript runner not found.');
    return false;
  }

  // Reset to default costume (respects costumeLock)
  function resetToDefault() {
    if (costumeLock) {
      safeLog('Reset prevented by costumeLock.');
      return;
    }
    if (currentCostume === defaultCostume) return;
    executeCostumeCommand(defaultCostume);
    currentCostume = defaultCostume;
  }

  // manage inactivity timer
  function resetInactivityTimer() {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (!settings.inactivityTimeoutMs || settings.inactivityTimeoutMs <= 0) return;
    inactivityTimer = setTimeout(() => {
      if (!costumeLock) resetToDefault();
    }, settings.inactivityTimeoutMs);
  }

  // load costume map from current character's extension field
  function loadCharacterCostumeMap() {
    try {
      const { characters, characterId, writeExtensionField } = ctx;
      if (typeof characterId === 'undefined' || characterId === null) {
        costumeMap = [];
        defaultCostume = 'default';
        return;
      }
      const char = characters[characterId];
      const ext = char && char.data && char.data.extensions && char.data.extensions[EXT_NAME];
      if (ext) {
        defaultCostume = ext.defaultCostume || defaultCostume;
        costumeMap = Array.isArray(ext.costumeMap) ? ext.costumeMap.map(m => {
          try {
            return { ...m, re: new RegExp(m.regex, 'i') };
          } catch (e) {
            safeWarn('Invalid regex in costumeMap entry:', m, e);
            return null;
          }
        }).filter(Boolean) : [];
      } else {
        costumeMap = [];
      }
      processedTextLength = 0;
      safeLog('Loaded costume map:', costumeMap, 'default:', defaultCostume);
    } catch (err) {
      safeErr('Error loading character costume map:', err);
    }
  }

  // attempt to locate the DOM node where text streams. We try multiple selectors defensively.
  function findStreamingElement() {
    const candidates = [
      '.streaming-message-content',
      '.SillyTavern--message .SillyTavern--message-text',
      '.character-message .message-text',
      '.message .content',
      '.message[data-streaming="true"]',
      '[data-message-streaming="true"]'
    ];
    for (const s of candidates) {
      const el = document.querySelector(s);
      if (el) {
        safeLog('Found streaming target via selector:', s);
        return el;
      }
    }

    // fallback: find the most recently added message content (heuristic)
    const messages = Array.from(document.querySelectorAll('.SillyTavern--message, .message, .character-message'));
    if (messages.length) {
      const last = messages[messages.length - 1];
      const content = last.querySelector('p, div, .SillyTavern--message-text, .message-text, .content');
      if (content) {
        safeLog('Using last message content as streaming target (heuristic).');
        return content;
      }
    }

    safeWarn('Streaming target not found. MutationObserver will not attach.');
    return null;
  }

  // MutationObserver callback: scan newly appended text and match regexes
  function onMutation(mutations) {
    try {
      if (!targetNode) return;
      const text = targetNode.textContent || '';
      if (text.length <= processedTextLength) return;
      const newText = text.substring(processedTextLength);
      // iterate costumes, test against newText
      for (const mapping of costumeMap) {
        if (!mapping || !mapping.re) continue;
        if (mapping.re.test(newText)) {
          const target = mapping.targetCostume || mapping.target || mapping.fileName;
          if (target && target !== currentCostume) {
            safeLog('Regex matched:', mapping.name || mapping.regex, '->', target);
            costumeLock = true;
            executeCostumeCommand(target);
            currentCostume = target;
            // release lock after short delay
            setTimeout(() => { costumeLock = false; }, 500);
            // update processed length to avoid retriggering on same text
            processedTextLength = text.length;
            // start/reset inactivity timer
            resetInactivityTimer();
            break; // one match per mutation is enough
          }
        }
      }
      processedTextLength = text.length;
    } catch (err) {
      safeErr('Error in MutationObserver callback:', err);
    }
  }

  function startObserving() {
    if (!settings.enabled) return;
    // ensure we don't attach twice
    stopObserving();

    targetNode = findStreamingElement();
    if (!targetNode) return;

    processedTextLength = (targetNode.textContent || '').length;
    observer = new MutationObserver(onMutation);
    observer.observe(targetNode, { childList: true, characterData: true, subtree: true });
    safeLog('MutationObserver started.');
  }

  function stopObserving() {
    if (observer) {
      try { observer.disconnect(); } catch (e) { /* ignore */ }
      observer = null;
      safeLog('MutationObserver stopped.');
    }
  }

  // UI bindings
  function bindUI() {
    try {
      const enabledToggle = document.querySelector('#dc-enabled-toggle');
      const resetBtn = document.querySelector('#dc-reset-button');
      const timeoutInput = document.querySelector('#dc-timeout-input');
      const openJsonBtn = document.querySelector('#dc-open-json');

      if (enabledToggle) {
        enabledToggle.checked = !!settings.enabled;
        enabledToggle.addEventListener('change', () => {
          settings.enabled = !!enabledToggle.checked;
          ctx.extensionSettings[EXT_NAME] = settings;
          ctx.saveSettingsDebounced && ctx.saveSettingsDebounced();
          if (settings.enabled) startObserving(); else stopObserving();
        });
      }
      if (timeoutInput) {
        timeoutInput.value = Math.round(settings.inactivityTimeoutMs / 1000);
        timeoutInput.addEventListener('change', () => {
          const val = Number(timeoutInput.value) || 0;
          settings.inactivityTimeoutMs = Math.max(0, Math.round(val * 1000));
          ctx.extensionSettings[EXT_NAME] = settings;
          ctx.saveSettingsDebounced && ctx.saveSettingsDebounced();
          resetInactivityTimer();
        });
      }
      if (resetBtn) {
        resetBtn.addEventListener('click', () => {
          resetToDefault();
        });
      }
      if (openJsonBtn) {
        openJsonBtn.addEventListener('click', () => {
          // attempt to open the current character's extensions JSON in console for editing
          try {
            const { characters, characterId } = ctx;
            if (typeof characterId === 'undefined' || characterId === null) {
              alert('No character selected.');
              return;
            }
            const char = characters[characterId];
            const ext = (char && char.data && char.data.extensions && char.data.extensions[EXT_NAME]) || {};
            // pretty print to console so user can copy/paste into their card
            console.log('[DynamicCostumer] current extension JSON (copy/paste into character -> extensions):', JSON.stringify(ext, null, 2));
            alert('Extension JSON printed to browser console (copy/paste into character card -> extensions).');
          } catch (e) {
            safeErr('Open JSON failed:', e);
            alert('Failed to open JSON. See console for details.');
          }
        });
      }
    } catch (err) {
      safeErr('UI bind error:', err);
    }
  }

  // Called once APP_READY fired
  function onAppReady() {
    try {
      ctx = SillyTavern.getContext();
      if (!ctx) {
        safeErr('getContext() returned falsey value.');
        return;
      }
      // load settings from extensionSettings
      const extSettings = ctx.extensionSettings && ctx.extensionSettings[EXT_NAME];
      settings = Object.assign({}, DEFAULT_SETTINGS, extSettings || {});
      // ensure numeric timeout
      settings.inactivityTimeoutMs = Number(settings.inactivityTimeoutMs || DEFAULT_SETTINGS.inactivityTimeoutMs);

      // bind UI
      bindUI();

      // events
      ctx.eventSource && ctx.eventSource.on && ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, () => {
        loadCharacterCostumeMap();
        // stop, will re-start on next generation
        stopObserving();
      });

      // start/stop observing around generation lifecycle
      if (ctx.event_types.GENERATION_AFTER_COMMANDS) {
        ctx.eventSource.on(ctx.event_types.GENERATION_AFTER_COMMANDS, () => {
          startObserving();
        });
      } else {
        // fallback: try GENERATION_STARTED if present
        if (ctx.event_types.GENERATION_STARTED) {
          ctx.eventSource.on(ctx.event_types.GENERATION_STARTED, () => startObserving());
        }
      }

      if (ctx.event_types.GENERATION_ENDED) {
        ctx.eventSource.on(ctx.event_types.GENERATION_ENDED, () => {
          stopObserving();
          resetInactivityTimer();
        });
      }

      // activity resets inactivity timer
      ctx.eventSource.on(ctx.event_types.MESSAGE_SENT, () => resetInactivityTimer());
      ctx.eventSource.on(ctx.event_types.GENERATION_ENDED, () => resetInactivityTimer());

      // initial load
      loadCharacterCostumeMap();
      safeLog('Dynamic Costumer ready. Settings:', settings);
    } catch (err) {
      safeErr('onAppReady error:', err);
    }
  }

  // register for APP_READY (auto-fires if already ready)
  try {
    const c = SillyTavern.getContext();
    if (c && c.eventSource && c.event_types && c.eventSource.on) {
      c.eventSource.on(c.event_types.APP_READY, onAppReady);
      // If app is already ready, call immediately
      if (c.appReady) onAppReady();
    } else {
      // worst case: try later
      document.addEventListener('DOMContentLoaded', () => {
        try { SillyTavern.getContext().eventSource.on(SillyTavern.getContext().event_types.APP_READY, onAppReady); } catch (e) { onAppReady(); }
      });
    }
  } catch (err) {
    safeErr('Failed to register APP_READY listener:', err);
    // try direct call as fallback
    setTimeout(onAppReady, 1500);
  }
})();
