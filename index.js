/* Auto Costume Switcher for SillyTavern
   - Listens for streamed AI text (tries eventSource hook, falls back to MutationObserver)
   - Detects character names anywhere in text (regex)
   - Sends /costume commands immediately when name changes
   - Resets to default after idleTimeout ms if no name seen
   - Provides settings UI in Extensions panel
*/

(function () {
  const MODULE = 'auto-costume-switcher';
  const DEFAULTS = {
    enabled: true,
    // mapping: name -> costume command (string after slash)
    mappings: {
      Shido: '/costume Date a Live',
      Kotori: '/costume Date a Live/Kotori1'
    },
    defaultCommand: '/costume Date a Live',
    idleTimeout: 3000  // ms to wait with no match before resetting
  };

  // Utility: safe get SillyTavern context if available
  function getSTContext() {
    try {
      if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
        return window.SillyTavern.getContext();
      }
    } catch (e) { /* ignore */ }
    // If not available, try common global names (fallback, might be undefined)
    return window.__sillytavern_context || null;
  }

  // Load or init settings (persisted through extensionSettings if possible)
  function loadSettings() {
    const ctx = getSTContext();
    if (ctx && ctx.extensionSettings) {
      ctx.extensionSettings[MODULE] = ctx.extensionSettings[MODULE] || {};
      const store = ctx.extensionSettings[MODULE];
      // Merge defaults with store
      return Object.assign({}, DEFAULTS, store);
    } else {
      // fallback: use localStorage for persistence if ST API not present
      const raw = localStorage.getItem(MODULE + ':settings');
      if (raw) {
        try { return Object.assign({}, DEFAULTS, JSON.parse(raw)); }
        catch (e) { return Object.assign({}, {}, DEFAULTS); }
      } else {
        return Object.assign({}, {}, DEFAULTS);
      }
    }
  }

  function saveSettings(settings) {
    const ctx = getSTContext();
    if (ctx && ctx.extensionSettings) {
      ctx.extensionSettings[MODULE] = {
        enabled: settings.enabled,
        mappings: settings.mappings,
        defaultCommand: settings.defaultCommand,
        idleTimeout: settings.idleTimeout
      };
      if (typeof ctx.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
      } else if (typeof ctx.saveSettings === 'function') {
        ctx.saveSettings();
      }
    } else {
      localStorage.setItem(MODULE + ':settings', JSON.stringify({
        enabled: settings.enabled,
        mappings: settings.mappings,
        defaultCommand: settings.defaultCommand,
        idleTimeout: settings.idleTimeout
      }));
    }
  }

  // Build regex from mapping names (escape names safely)
  function buildNameRegex(mappings) {
    const names = Object.keys(mappings).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (names.length === 0) return null;
    // match anywhere, word boundaries, capture name
    return new RegExp('\\b(' + names.join('|') + ')\\b', 'i');
  }

  // Try a few ways to send a slash command into SillyTavern
  function sendSlashCommand(command) {
    const ctx = getSTContext();
    // 1) If there's an eventSource and MESSAGE_SENT event type, emit it
    try {
      if (ctx && ctx.eventSource && ctx.event_types && ctx.event_types.MESSAGE_SENT) {
        // push into chat array so ST will process it as if user sent it
        if (Array.isArray(ctx.chat)) {
          ctx.chat.push({
            is_user: true,
            mes: command,
            send_date: Date.now()
          });
        }
        try { ctx.eventSource.emit(ctx.event_types.MESSAGE_SENT, { message: command }); } catch (e) { /* ignore */ }
        return true;
      }
    } catch (e) { /* ignore */ }

    // 2) If an exposed action is available (best-effort)
    try {
      if (ctx && ctx.actions && typeof ctx.actions.sendMessage === 'function') {
        ctx.actions.sendMessage(command);
        return true;
      }
    } catch (e) {}

    // 3) Fallback: find an input box and simulate a send (DOM-based, fragile)
    try {
      const input = document.querySelector('textarea.chat-input, textarea#chat-input, input.chat-input');
      if (input) {
        input.focus();
        input.value = command;
        // try dispatching input events so ST notices
        input.dispatchEvent(new Event('input', { bubbles: true }));
        // try clicking the send button if present
        const sendBtn = document.querySelector('button.send-button, button#send, button[aria-label="Send"]');
        if (sendBtn) {
          sendBtn.click();
          return true;
        } else {
          // try pressing Enter
          const e = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true });
          input.dispatchEvent(e);
          return true;
        }
      }
    } catch (e) {}

    console.warn('[AutoCostume] Failed to send command programmatically:', command);
    return false;
  }

  // Core controller: listens to streaming text fragments and reacts
  function createController(settings) {
    let nameRegex = buildNameRegex(settings.mappings);
    let lastMatchedName = null;
    let idleTimer = null;

    function clearIdleTimer() {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    }

    function scheduleResetIfIdle() {
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        // no name seen for idleTimeout -> reset to default
        if (settings.enabled) {
          if (lastMatchedName !== null) {
            sendSlashCommand(settings.defaultCommand);
            lastMatchedName = null;
          }
        }
      }, settings.idleTimeout);
    }

    function processFragmentText(text) {
      if (!settings.enabled) return;
      if (!text || text.length === 0) return;
      if (!nameRegex) return;

      const m = text.match(nameRegex);
      if (m && m[1]) {
        // normalize matched name to mapping key (case-insensitive)
        const found = Object.keys(settings.mappings).find(k => k.toLowerCase() === m[1].toLowerCase());
        if (found && found !== lastMatchedName) {
          lastMatchedName = found;
          const cmd = settings.mappings[found];
          if (cmd) {
            sendSlashCommand(cmd);
          }
        }
        // whenever we see a name, reset idle timer
        scheduleResetIfIdle();
      } else {
        // no name in this fragment; schedule reset
        scheduleResetIfIdle();
      }
    }

    // 1) Preferred approach: listen for streaming token events if ST exposes them
    function attachEventSourceHook() {
      const ctx = getSTContext();
      if (!ctx || !ctx.eventSource || !ctx.event_types) return false;

      // try common event types in various ST versions
      const possibleStreamEvents = [
        'STREAM_TOKENS',        // hypothetical
        ctx.event_types.STREAM_TOKENS,
        ctx.event_types.MESSAGE_CHUNK,
        ctx.event_types.MESSAGE_PART,
        'assistant_token',      // fallback names
        'model_stream_chunk'
      ].filter(Boolean);

      let hooked = false;
      possibleStreamEvents.forEach(ev => {
        try {
          if (ctx.eventSource && typeof ctx.eventSource.on === 'function') {
            ctx.eventSource.on(ev, payload => {
              // payload might be { text: '...' } or { chunk: '...' } or a raw string
              try {
                const text = (payload && (payload.text || payload.chunk || payload.content)) || (typeof payload === 'string' ? payload : '');
                if (text) processFragmentText(text);
              } catch (e) { /* ignore fragment parse errors */ }
            });
            hooked = true;
            // no return here so it will try attach multiple; that's okay
          }
        } catch (e) {}
      });
      return hooked;
    }

    // 2) Fallback: use MutationObserver on the latest assistant message DOM node
    function attachMutationObserver() {
      // Heuristic: find the last assistant message container in the chat area
      // This selector may need adjustment if ST DOM differs; we try a few common ones.
      const selectors = [
        '.message.assistant, .message.ai, .assistant-message, .message.character', // plausible
        '.chat-messages .message:last-child', // fallback
        '.messages .message:last-child'
      ];

      // observer will watch for textual changes in the last assistant message element
      let observer = null;

      function tryAttach() {
        // find last assistant-like message container by searching for elements that have "assistant" or "ai" role in class or data attributes
        let container = null;
        // try smarter search: look for element that contains something like role="assistant" or data-author="assistant"
        container = document.querySelector('[data-author="assistant"], [data-role="assistant"]');

        if (!container) {
          // find the last element that contains text and has a child representing assistant
          for (const s of selectors) {
            const el = document.querySelector(s);
            if (el && el.innerText && el.innerText.length > 0) {
              container = el;
              break;
            }
          }
        }

        if (!container) {
          // Try to find last message that visually looks like assistant
          const msgs = Array.from(document.querySelectorAll('.message'));
          if (msgs.length) {
            container = msgs[msgs.length - 1];
          }
        }

        if (!container) return false;

        // observe characterData and childList changes deep so as tokens get appended we see them
        observer = new MutationObserver(mutations => {
          for (const mut of mutations) {
            // for characterData changes (text nodes)
            if (mut.type === 'characterData' || mut.type === 'childList') {
              // get full text of container and process fragment
              const text = container.innerText || container.textContent || '';
              if (text) processFragmentText(text);
            }
          }
        });

        observer.observe(container, { subtree: true, childList: true, characterData: true });
        // Keep reference to disconnect later if needed
        window.__autoCostumeObserver = observer;
        return true;
      }

      // attempt now and also try retrying a few times if DOM not ready yet
      let attached = tryAttach();
      if (!attached) {
        // try a few times over the next 3 seconds
        let tries = 0;
        const id = setInterval(() => {
          tries++;
          if (tryAttach() || tries > 12) {
            clearInterval(id);
          }
        }, 250);
      }
      return true;
    }

    // Attempt to attach hooks
    const hookedEvents = attachEventSourceHook();
    if (!hookedEvents) {
      // fallback strategy
      attachMutationObserver();
    }

    // public API for UI to manually reset and change settings
    return {
      processFragmentText,
      manualReset: function () {
        lastMatchedName = null;
        clearIdleTimer();
        if (settings.enabled) sendSlashCommand(settings.defaultCommand);
      },
      updateSettings: function (newSettings) {
        Object.assign(settings, newSettings);
        nameRegex = buildNameRegex(settings.mappings);
      }
    };
  }

  // Build simple settings UI and inject into Extensions panel
  function createSettingsUI(settings, controller) {
    // find somewhere to attach in ST extensions UI; try a few selectors
    const panelRootSelectors = [
      '#extensions-panel',            // hypothetical
      '.extensions-panel',
      '.extensions-list',
      '.sidebar-extensions',
      'body' // fallback to body if none found (will still be visible)
    ];

    let root = null;
    for (const s of panelRootSelectors) {
      const el = document.querySelector(s);
      if (el) { root = el; break; }
    }
    // If not found, create a fixed position widget in the bottom-right as fallback
    const fallback = !root;
    if (fallback) {
      root = document.body;
    }

    // create wrapper
    const wrapper = document.createElement('div');
    wrapper.id = 'auto-costume-switcher-ui';
    wrapper.style.cssText = `
      box-shadow: 0 6px 18px rgba(0,0,0,0.18);
      border-radius: 8px;
      padding: 12px;
      margin: 8px;
      background: rgba(255,255,255,0.95);
      color: #111;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial;
      width: 320px;
      max-width: calc(100% - 24px);
      z-index: 99999;
    `;
    if (fallback) {
      wrapper.style.position = 'fixed';
      wrapper.style.bottom = '18px';
      wrapper.style.right = '18px';
    }

    // Header
    const h = document.createElement('div');
    h.innerHTML = `<strong>Auto Costume Switcher</strong>`;
    wrapper.appendChild(h);

    // Enabled toggle
    const rowEnable = document.createElement('div');
    rowEnable.style.marginTop = '8px';
    rowEnable.innerHTML = `
      <label style="display:flex; align-items:center; gap:8px;">
        <input type="checkbox" id="acs-enabled">
        <span>Enable real-time switching</span>
      </label>
    `;
    wrapper.appendChild(rowEnable);

    // Mappings editor (simple textarea JSON)
    const mappingsLabel = document.createElement('div');
    mappingsLabel.style.marginTop = '8px';
    mappingsLabel.innerHTML = `<div style="font-size: 12px; color: #444; margin-bottom:6px;">Name → Command mappings (JSON):</div>`;
    wrapper.appendChild(mappingsLabel);

    const mappingsTA = document.createElement('textarea');
    mappingsTA.id = 'acs-mappings';
    mappingsTA.style.width = '100%';
    mappingsTA.style.height = '110px';
    mappingsTA.style.boxSizing = 'border-box';
    mappingsTA.value = JSON.stringify(settings.mappings, null, 2);
    wrapper.appendChild(mappingsTA);

    // default command input
    const defaultLabel = document.createElement('div');
    defaultLabel.style.marginTop = '8px';
    defaultLabel.innerHTML = `<div style="font-size:12px;color:#444">Default command (reset):</div>`;
    wrapper.appendChild(defaultLabel);
    const defaultInput = document.createElement('input');
    defaultInput.style.width = '100%';
    defaultInput.value = settings.defaultCommand;
    wrapper.appendChild(defaultInput);

    // idle timeout slider
    const timeoutRow = document.createElement('div');
    timeoutRow.style.marginTop = '8px';
    timeoutRow.innerHTML = `<div style="font-size:12px;color:#444">Idle reset (ms): <span id="acs-timeout-val">${settings.idleTimeout}</span></div>`;
    wrapper.appendChild(timeoutRow);
    const timeoutInput = document.createElement('input');
    timeoutInput.type = 'range';
    timeoutInput.min = 500;
    timeoutInput.max = 10000;
    timeoutInput.step = 100;
    timeoutInput.value = settings.idleTimeout;
    timeoutInput.style.width = '100%';
    wrapper.appendChild(timeoutInput);

    // Buttons: Save / Reset Costume
    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap = '8px';
    btnRow.style.marginTop = '10px';
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.style.flex = '1';
    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset Costume';
    resetBtn.style.flex = '1';
    btnRow.appendChild(saveBtn);
    btnRow.appendChild(resetBtn);
    wrapper.appendChild(btnRow);

    // Insert wrapper into root
    if (root) {
      root.appendChild(wrapper);
    } else {
      document.body.appendChild(wrapper);
    }

    // Populate initial enabled state
    const enabledCheckbox = wrapper.querySelector('#acs-enabled');
    enabledCheckbox.checked = !!settings.enabled;

    // Wire interactions
    timeoutInput.addEventListener('input', () => {
      wrapper.querySelector('#acs-timeout-val').textContent = timeoutInput.value;
    });

    saveBtn.addEventListener('click', () => {
      // validate mappings JSON
      let parsed;
      try {
        parsed = JSON.parse(mappingsTA.value);
        if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Mappings must be an object of name: command pairs.');
      } catch (e) {
        alert('Invalid mappings JSON: ' + (e.message || e));
        return;
      }
      // update settings and persist
      settings.enabled = enabledCheckbox.checked;
      settings.mappings = parsed;
      settings.defaultCommand = defaultInput.value || DEFAULTS.defaultCommand;
      settings.idleTimeout = parseInt(timeoutInput.value, 10) || DEFAULTS.idleTimeout;
      saveSettings(settings);
      // inform controller
      controller.updateSettings(settings);
      alert('Auto Costume settings saved.');
    });

    resetBtn.addEventListener('click', () => {
      controller.manualReset();
      alert('Reset command sent.');
    });

    // allow small drag behavior for fallback floating panel
    if (fallback) {
      let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
      wrapper.style.cursor = 'move';
      wrapper.addEventListener('mousedown', (ev) => {
        dragging = true;
        sx = ev.clientX; sy = ev.clientY;
        const rect = wrapper.getBoundingClientRect();
        ox = rect.left; oy = rect.top;
        wrapper.style.transition = 'none';
      });
      window.addEventListener('mousemove', (ev) => {
        if (!dragging) return;
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        wrapper.style.left = (ox + dx) + 'px';
        wrapper.style.top = (oy + dy) + 'px';
      });
      window.addEventListener('mouseup', () => {
        dragging = false;
        wrapper.style.transition = '';
      });
    }
  }

  // Initialization
  const settings = loadSettings();
  const controller = createController(settings);
  // Save any defaults into persistent store if missing
  saveSettings(settings);
  // Create UI
  createSettingsUI(settings, controller);

  console.log('[AutoCostume] initialized', settings);
})();
