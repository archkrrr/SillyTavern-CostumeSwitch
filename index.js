// index.js
// SillyTavern Costume Switch Extension

(async () => {
  const context = SillyTavern.getContext();
  const { eventSource, event_types, extensionSettings, saveSettingsDebounced } = context;

  // Unique key for our extension settings
  const MODULE_NAME = 'CostumeSwitch';
  const defaultSettings = { enabled: true };

  // Initialize or retrieve persistent settings
  function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
      extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const k of Object.keys(defaultSettings)) {
      if (!(k in extensionSettings[MODULE_NAME])) {
        extensionSettings[MODULE_NAME][k] = defaultSettings[k];
      }
    }
    return extensionSettings[MODULE_NAME];
  }
  const settings = getSettings();

  // Helper to send a slash command, e.g. /costume ... via SillyTavern API
  // We import the executor from the built-in slash-commands module.
  async function sendSlashCommand(cmd) {
    // Note: we await here to ensure command is sent sequentially.
    // Import the executor dynamically.
    const { executeSlashCommandsOnChatInput } = await importFromUrl('/scripts/slash-commands.js', 'executeSlashCommandsOnChatInput');
    await executeSlashCommandsOnChatInput(cmd, { clearChatInput: true });
  }

  // State: accumulated text so far in the current streaming message
  let buffer = '';
  // Timer for resetting to default if needed
  let resetTimer = null;

  // Patterns for character names to watch for (add more as needed)
  const charPatterns = {
    Shido: /^Shido:/i,
    Kotori: /^Kotori:/i
    // Add more names and corresponding regex if desired
  };

  // Default costume command when no specific name is active
  const DEFAULT_COSTUME = "/costume Date a Live/Seraphina";  // fallback default

  // Handle each incoming text token
  async function onTokenReceived(text) {
    if (!settings.enabled) return;
    buffer += text;  // append new text chunk

    // If buffer grows too large, keep only last 200 chars to save memory
    if (buffer.length > 200) buffer = buffer.slice(-200);

    // Check each character pattern; if any matches at the end of buffer, switch costume
    for (const [name, regex] of Object.entries(charPatterns)) {
      if (regex.test(buffer)) {
        // Found e.g. "Kotori:" near end of buffer
        // Cancel any pending reset
        if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
        // Issue the costume switch command for that character
        // (Customize the path as needed for your assets)
        await sendSlashCommand(`/costume Date a Live/${name}1`);
        return;
      }
    }
    // If no name found, set a timer to reset after a short idle (e.g. 2s) if not triggered again
    if (resetTimer == null) {
      resetTimer = setTimeout(async () => {
        await sendSlashCommand(DEFAULT_COSTUME);
        resetTimer = null;
      }, 2000);
    }
  }

  // When a new AI generation starts, clear buffer
  eventSource.on(event_types.GENERATION_STARTED, () => {
    buffer = '';
    if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
  });

  // Listen for each streamed token from the AI
  eventSource.on(event_types.STREAM_TOKEN_RECEIVED, async (token) => {
    await onTokenReceived(token);
  });

  // At end of generation or if interrupted, ensure reset
  eventSource.on(event_types.GENERATION_ENDED, async () => {
    buffer = '';
    if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
    // Optionally reset costume at end
    await sendSlashCommand(DEFAULT_COSTUME);
  });

  // --- Settings UI --- //
  // Create a panel in the Extensions settings with a checkbox and a reset button
  const panelHtml = `
    <div class="setting">
      <label><input type="checkbox" id="cs_enabled"> Enable auto-switching</label>
    </div>
    <div class="setting">
      <button id="cs_reset">Reset Costume</button>
    </div>
  `;
  const container = document.createElement('div');
  container.innerHTML = panelHtml;
  document.addEventListener('DOMContentLoaded', () => {
    const panel = document.getElementById('extensions_panel');
    if (panel) {
      panel.appendChild(container);
      // Initialize UI states
      const chk = container.querySelector('#cs_enabled');
      chk.checked = settings.enabled;
      chk.addEventListener('change', () => {
        settings.enabled = chk.checked;
        saveSettingsDebounced();
      });
      container.querySelector('#cs_reset').addEventListener('click', async () => {
        await sendSlashCommand(DEFAULT_COSTUME);
      });
    }
  });

  console.log("SillyTavern CostumeSwitch extension loaded.");
})();
