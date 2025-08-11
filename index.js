window.SillyTavern.registerExtension({
  name: 'AutoCostumeSwitch',
  init: function() {
    // Load saved settings or use defaults
    let settings = window.SillyTavern.loadSettings('AutoCostumeSwitch') || {};
    settings.enabled = settings.enabled ?? true;
    settings.mappings = settings.mappings || [
      {name: 'Shido', command: '/costume Date a Live'},
      {name: 'Kotori', command: '/costume Date a Live/Kotori1'}
    ];
    settings.defaultCommand = settings.defaultCommand || '/costume Date a Live';
    
    // UI elements: ensure panel is in DOM before adding handlers
    const applySettings = () => {
      // Save current settings (values taken from DOM inputs)
      settings.enabled = document.getElementById('switchEnabled').checked;
      settings.defaultCommand = document.getElementById('defaultCommand').value.trim() || settings.defaultCommand;
      // Parse mappings: one mapping per line "Name|Command"
      const mapText = document.getElementById('mappingList').value.trim();
      settings.mappings = mapText.split('\\n').map(line => {
        const [name, cmd] = line.split('|');
        return {name: name.trim(), command: cmd.trim()};
      }).filter(m => m.name && m.command);
      window.SillyTavern.saveSettings('AutoCostumeSwitch', settings);
    };
    // Setup initial values in the UI (after panel is created)
    const initUI = () => {
      document.getElementById('switchEnabled').checked = settings.enabled;
      document.getElementById('defaultCommand').value = settings.defaultCommand;
      document.getElementById('mappingList').value =
        settings.mappings.map(m => `${m.name}|${m.command}`).join('\\n');
      document.getElementById('mappingList').onchange = applySettings;
      document.getElementById('defaultCommand').onchange = applySettings;
      document.getElementById('switchEnabled').onchange = applySettings;
      document.getElementById('resetBtn').onclick = () => {
        // Reset to initial defaults
        settings = {
          enabled: true,
          mappings: [
            {name: 'Shido', command: '/costume Date a Live'},
            {name: 'Kotori', command: '/costume Date a Live/Kotori1'}
          ],
          defaultCommand: '/costume Date a Live'
        };
        applySettings();
        initUI();
      };
    };
    // Delay UI init until panel is rendered
    setTimeout(initUI, 100);

    // Monitor AI messages and trigger costume switches
    let defaultTimer = null;
    window.SillyTavern.on('messageReceived', function(msg) {
      if (!settings.enabled) return;
      if (msg.role !== 'assistant') return;  // only AI responses

      const text = msg.content || msg.text || '';
      // Check for any trigger name
      let triggered = false;
      for (const map of settings.mappings) {
        const re = new RegExp(`\\b${map.name}\\b`, 'i');
        if (re.test(text)) {
          // Name found: send corresponding /costume command
          window.SillyTavern.sendMessage(map.command);
          triggered = true;
          // Reset default timer
          if (defaultTimer) clearTimeout(defaultTimer);
          defaultTimer = setTimeout(() => {
            window.SillyTavern.sendMessage(settings.defaultCommand);
          }, 10000); // 10 seconds after last trigger
          break;
        }
      }
      // If no trigger found, do nothing here; the default timer will fire if needed
    });
  },

  // Build the settings panel
  settings: function() {
    return `
      <div class="extension-settings">
        <label><input type="checkbox" id="switchEnabled"> Enable Costume Switcher</label><br>
        <label>Default /costume command:</label><br>
        <input type="text" id="defaultCommand" style="width:100%" /><br>
        <label>Mappings (Name|/costume command) one per line:</label><br>
        <textarea id="mappingList" style="width:100%; height:6em;"></textarea><br>
        <button id="resetBtn">Reset to Defaults</button>
      </div>`;
  }
});
