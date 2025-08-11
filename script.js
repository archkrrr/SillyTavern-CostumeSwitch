// Immediately-invoked function expression (IIFE) to encapsulate the extension's logic and avoid polluting the global scope.
(function () {
    // --- Extension State and Configuration ---
    const extensionName = "SillyTavern-CostumeSwitch";
    const extensionFolderPath = `extensions/${extensionName}`;
    const defaultSettings = {
        enabled: false,
    };
    let settings = {...defaultSettings };
    let context; // To hold the SillyTavern context object
    let observer; // To hold the MutationObserver instance
    let currentSpeaker = null; // Tracks the currently active character costume
    let resetTimer = null; // Timer for resetting to the default costume

    // Configuration for character costumes.
    // In a future version, this could be made configurable in the UI.
    const costumeConfig = {
        basePath: 'characters/Date a Live/',
        defaultFolder: 'Date a Live', // The folder for the default/group sprite
        characters: // List of characters to detect
    };

    // --- Core Functions ---

    /**
     * Applies a costume by setting the character's avatar.
     * This function interacts with an UNDOCUMENTED SillyTavern internal API.
     * It may break with future SillyTavern updates.
     * @param {string} characterName - The name of the character to switch to. If null, resets to default.
     */
    function applyCostume(characterName) {
        if (!context) return;

        const character = context.characters[context.characterId];
        if (!character) return;

        let avatarPath;
        if (characterName && costumeConfig.characters.includes(characterName)) {
            console.log(` Switching to ${characterName}`);
            avatarPath = `${costumeConfig.basePath}${characterName}/avatar.png`;
            currentSpeaker = characterName;
        } else {
            console.log(' Resetting to default costume.');
            avatarPath = `${costumeConfig.basePath}${costumeConfig.defaultFolder}/avatar.png`;
            currentSpeaker = null;
        }

        // The undocumented call to change the avatar.
        context.setAvatar('char', avatarPath);
    }

    /**
     * Processes a chunk of text from the streaming response.
     * @param {string} text - The text content to scan for character names.
     */
    function handleStreamChunk(text) {
        // Regex to find a name like "Shido:" at the start of a line.
        const match = text.match(/^(?:<p>)?(\w+):/);
        if (match && match) {
            const detectedSpeaker = match;

            // Check if this is a configured character and not already the active speaker.
            if (costumeConfig.characters.includes(detectedSpeaker) && detectedSpeaker!== currentSpeaker) {
                // Clear any pending reset timer
                if (resetTimer) {
                    clearTimeout(resetTimer);
                    resetTimer = null;
                }

                applyCostume(detectedSpeaker);

                // Set a new timer to reset the costume after a period of inactivity.
                resetTimer = setTimeout(() => {
                    applyCostume(null); // Reset to default
                }, 15000); // 15-second delay
            }
        }
    }

    /**
     * Initializes the MutationObserver to watch for chat changes.
     */
    function initializeObserver() {
        const targetNode = document.getElementById('chat');
        if (!targetNode) {
            console.error(' Chat container not found.');
            return;
        }

        const observerOptions = {
            childList: true,
            subtree: true,
            characterData: false, // We only care about new nodes being added
        };

        // The callback function to execute when mutations are observed
        const callback = (mutationList, obs) => {
            if (!settings.enabled) return; // Do nothing if the extension is disabled

            for (const mutation of mutationList) {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    mutation.addedNodes.forEach(node => {
                        // We are interested in the text content of the message element.
                        if (node.classList && node.classList.contains('mes')) {
                           const mesText = node.querySelector('.mes_text');
                           if(mesText && mesText.textContent) {
                               handleStreamChunk(mesText.innerHTML); // Use innerHTML to catch the raw text before formatting
                           }
                        }
                    });
                }
            }
        };

        observer = new MutationObserver(callback);

        // Start observing when generation starts
        context.eventSource.on(context.event_types.GENERATION_AFTER_COMMANDS, () => {
            if (settings.enabled && observer) {
                console.log(' Starting observer.');
                const lastMessage = document.querySelector('#chat.last_mes');
                if(lastMessage) {
                    observer.observe(lastMessage, observerOptions);
                }
            }
        });

        // Stop observing when generation ends
        const stopObserver = () => {
            if (observer) {
                console.log(' Stopping observer.');
                observer.disconnect();
            }
        };
        context.eventSource.on(context.event_types.GENERATION_STOPPED, stopObserver);
        context.eventSource.on(context.event_types.GENERATION_ENDED, stopObserver);
    }

    // --- UI and Settings Functions ---

    /**
     * Saves the current settings to SillyTavern's persistent storage.
     */
    function saveSettings() {
        context.extensionSettings[extensionName] = settings;
        context.saveSettingsDebounced();
    }

    /**
     * Binds event listeners to the UI elements in the settings panel.
     */
    function bindUIEvents() {
        const enabledToggle = document.getElementById('costume-switcher-enabled');
        const resetButton = document.getElementById('costume-switcher-reset');

        if (enabledToggle) {
            enabledToggle.checked = settings.enabled;
            enabledToggle.addEventListener('change', () => {
                settings.enabled = enabledToggle.checked;
                saveSettings();
            });
        }

        if (resetButton) {
            resetButton.addEventListener('click', () => {
                // Clear any pending timer and reset immediately.
                if (resetTimer) clearTimeout(resetTimer);
                applyCostume(null);
            });
        }
    }

    /**
     * Asynchronously loads the HTML for the settings panel and injects it into the DOM.
     */
    async function loadSettingsUI() {
        try {
            const response = await fetch(`${extensionFolderPath}/settings.html`);
            if (!response.ok) {
                throw new Error('Failed to load settings HTML');
            }
            const html = await response.text();
            const container = document.querySelector('#extensions_settings >.container');
            if (container) {
                container.insertAdjacentHTML('beforeend', html);
                bindUIEvents();
            } else {
                console.error(' Settings container not found.');
            }
        } catch (error) {
            console.error(` Error loading settings UI: ${error}`);
        }
    }

    /**
     * The main entry point for the extension, called when the app is ready.
     */
    function onAppReady() {
        context = SillyTavern.getContext();
        // Load settings or use defaults
        settings = {...defaultSettings,...context.extensionSettings[extensionName] };
        
        loadSettingsUI();
        initializeObserver();
        
        console.log(' Extension loaded successfully.');
    }

    // Wait for SillyTavern to be fully loaded before running the extension
    document.addEventListener('DOMContentLoaded', () => {
        const interval = setInterval(() => {
            if (window.SillyTavern && SillyTavern.getContext) {
                clearInterval(interval);
                // The APP_READY event ensures all other components are loaded
                SillyTavern.getContext().eventSource.on(SillyTavern.getContext().event_types.APP_READY, onAppReady);
            }
        }, 100);
    });

})();
