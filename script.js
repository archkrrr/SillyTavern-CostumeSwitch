// IIFE to encapsulate logic and prevent global scope pollution
(function () {
    // --- State and Configuration ---
    const extensionName = "SillyTavern-CostumeSwitch";
    const extensionFolderPath = `extensions/${extensionName}`;
    let settings = { enabled: false };
    let context;
    let observer;
    let currentSpeaker = null;
    let resetTimer = null;

    // --- User Configuration ---
    // This section defines the characters and paths.
    // In a future version, this could be moved to the UI.
    const costumeConfig = {
        // IMPORTANT: Assumes your character folders are in 'public/characters/Date a Live/'
        basePath: 'characters/Date a Live/',
        // The folder containing the default group portrait.
        defaultFolder: 'Date a Live',
        // List of character names the extension should detect.
        characters: ["Shido", "Kotori", "Tohka", "Origami", "Yoshino", "Kurumi"]
    };

    /**
     * Applies a costume by setting the character's avatar.
     * WARNING: This interacts with an UNDOCUMENTED SillyTavern internal function.
     * It may break with future SillyTavern updates.
     * @param {string | null} speakerName - The name of the speaker. Resets to default if null.
     */
    function applyCostume(speakerName) {
        if (!context) return;

        const character = context.characters[context.characterId];
        if (!character) return;

        let avatarPath;
        if (speakerName && costumeConfig.characters.includes(speakerName)) {
            // A specific speaker was detected
            if (currentSpeaker === speakerName) return; // Already showing this costume
            console.log(`[CostumeSwitch] Switching to ${speakerName}`);
            avatarPath = `${costumeConfig.basePath}${speakerName}/${character.avatar}`;
            currentSpeaker = speakerName;
        } else {
            // Reset to default
            if (currentSpeaker === null) return; // Already showing default
            console.log('[CostumeSwitch] Resetting to default costume.');
            avatarPath = `${costumeConfig.basePath}${costumeConfig.defaultFolder}/${character.avatar}`;
            currentSpeaker = null;
        }

        // The undocumented call to change the avatar for the current character.
        context.characters.setAvatar(context.characterId, avatarPath);
        // Force an immediate UI update for the character persona.
        context.ui.updateCharacterPersona();
    }

    /**
     * Processes text from the streaming response to find speaker cues.
     * @param {string} text - The text content to scan.
     */
    function handleStreamChunk(text) {
        // Regex to find a name like "Shido:" at the start of a string.
        const match = text.match(/^\s*(\w+):/);
        
        if (match && match[1]) {
            const detectedSpeaker = match[1];

            if (costumeConfig.characters.includes(detectedSpeaker)) {
                // A valid character was detected. Cancel any pending reset.
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
     * Sets up the MutationObserver to watch for chat changes.
     */
    function initializeObserver() {
        const observerOptions = {
            childList: true,
            subtree: true,
            characterData: false,
        };

        const callback = (mutationList) => {
            if (!settings.enabled) return;

            for (const mutation of mutationList) {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    mutation.addedNodes.forEach(node => {
                        // Check if the added node is part of the streaming message text.
                        if (node.nodeType === Node.ELEMENT_NODE && node.closest('.mes_text')) {
                            const textContent = node.closest('.mes_text').textContent;
                            handleStreamChunk(textContent);
                        }
                    });
                }
            }
        };

        observer = new MutationObserver(callback);

        // Start observing when a new message bubble is created for generation.
        context.eventSource.on(context.event_types.MESSAGE_SWIPED, () => {
             const streamingMessage = document.querySelector('#chat .mes_text:not([data-observed])');
             if(streamingMessage && observer) {
                 observer.observe(streamingMessage.parentElement, observerOptions);
                 streamingMessage.setAttribute('data-observed', 'true');
             }
        });

        // Stop observing when generation ends to save resources.
        const stopObserver = () => {
            if (observer) {
                observer.disconnect();
            }
        };
        context.eventSource.on(context.event_types.GENERATION_STOPPED, stopObserver);
        context.eventSource.on(context.event_types.GENERATION_ENDED, stopObserver);
    }


    /**
     * Loads settings and binds event listeners to the UI controls.
     */
    function setupUI() {
        const enabledToggle = document.getElementById('costume-switcher-enabled');
        const resetButton = document.getElementById('costume-switcher-reset');

        if (enabledToggle) {
            enabledToggle.checked = settings.enabled;
            enabledToggle.addEventListener('change', () => {
                settings.enabled = enabledToggle.checked;
                context.extensionSettings[extensionName] = settings;
                context.saveSettingsDebounced();
            });
        }

        if (resetButton) {
            resetButton.addEventListener('click', () => {
                if (resetTimer) clearTimeout(resetTimer);
                applyCostume(null); // Force reset to default
            });
        }
    }

    /**
     * Loads the settings panel HTML and injects it into the DOM.
     */
    async function loadSettingsPanel() {
        try {
            const response = await fetch(`${extensionFolderPath}/settings.html`);
            if (!response.ok) throw new Error('Failed to load settings panel HTML');
            
            const html = await response.text();
            const container = document.querySelector('#extensions_settings > .container');
            
            if (container) {
                container.insertAdjacentHTML('beforeend', html);
                setupUI();
            } else {
                console.error('[CostumeSwitch] Settings container not found.');
            }
        } catch (error) {
            console.error(`[CostumeSwitch] Error loading UI: ${error}`);
        }
    }

    // Main entry point for the extension.
    function main() {
        context = SillyTavern.getContext();
        // Load saved settings or use defaults.
        settings = { ...settings, ...context.extensionSettings[extensionName] };

        loadSettingsPanel();
        initializeObserver();
        
        console.log('[CostumeSwitch] Extension loaded successfully.');
    }

    // Wait for SillyTavern's APP_READY event before initializing the extension.
    document.addEventListener('DOMContentLoaded', () => {
        const interval = setInterval(() => {
            if (window.SillyTavern && SillyTavern.getContext) {
                clearInterval(interval);
                SillyTavern.getContext().eventSource.on(SillyTavern.getContext().event_types.APP_READY, main);
            }
        }, 100);
    });
})();
