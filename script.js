// [CostumeSwitch] DEBUG: Checkpoint 1 - Script file has been loaded and is being parsed.
console.log('[CostumeSwitch] DEBUG: Checkpoint 1 - Script file has been loaded and is being parsed.');

// IIFE to encapsulate logic and prevent global scope pollution
(function () {
    // [CostumeSwitch] DEBUG: Checkpoint 2 - IIFE has started.
    console.log('[CostumeSwitch] DEBUG: Checkpoint 2 - IIFE has started.');

    // --- State and Configuration ---
    const extensionName = "SillyTavern-CostumeSwitch";
    const extensionFolderPath = `extensions/${extensionName}`;
    let settings = { enabled: false };
    let context;
    let observer;
    let currentSpeaker = null;
    let resetTimer = null;

    const costumeConfig = {
        basePath: 'characters/Date a Live/',
        defaultFolder: 'Date a Live',
        characters: ["Shido", "Kotori", "Tohka", "Origami", "Yoshino", "Kurumi"]
    };

    function applyCostume(speakerName) {
        if (!context) return;
        const character = context.characters[context.characterId];
        if (!character) return;
        let avatarPath;
        if (speakerName && costumeConfig.characters.includes(speakerName)) {
            if (currentSpeaker === speakerName) return;
            console.log(`[CostumeSwitch] Switching to ${speakerName}`);
            avatarPath = `${costumeConfig.basePath}${speakerName}/${character.avatar}`;
            currentSpeaker = speakerName;
        } else {
            if (currentSpeaker === null) return;
            console.log('[CostumeSwitch] Resetting to default costume.');
            avatarPath = `${costumeConfig.basePath}${costumeConfig.defaultFolder}/${character.avatar}`;
            currentSpeaker = null;
        }
        context.characters.setAvatar(context.characterId, avatarPath);
        context.ui.updateCharacterPersona();
    }

    function handleStreamChunk(text) {
        const match = text.match(/^\s*(\w+):/);
        if (match && match[1]) {
            const detectedSpeaker = match[1];
            if (costumeConfig.characters.includes(detectedSpeaker)) {
                if (resetTimer) {
                    clearTimeout(resetTimer);
                    resetTimer = null;
                }
                applyCostume(detectedSpeaker);
                resetTimer = setTimeout(() => {
                    applyCostume(null);
                }, 15000);
            }
        }
    }

    function initializeObserver() {
        console.log('[CostumeSwitch] DEBUG: Checkpoint 6 - initializeObserver() called.');
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
                        if (node.nodeType === Node.ELEMENT_NODE && node.closest('.mes_text')) {
                            const textContent = node.closest('.mes_text').textContent;
                            handleStreamChunk(textContent);
                        }
                    });
                }
            }
        };
        observer = new MutationObserver(callback);
        context.eventSource.on(context.event_types.MESSAGE_SWIPED, () => {
             const streamingMessage = document.querySelector('#chat .mes_text:not([data-observed])');
             if(streamingMessage && observer) {
                 observer.observe(streamingMessage.parentElement, observerOptions);
                 streamingMessage.setAttribute('data-observed', 'true');
             }
        });
        const stopObserver = () => {
            if (observer) { observer.disconnect(); }
        };
        context.eventSource.on(context.event_types.GENERATION_STOPPED, stopObserver);
        context.eventSource.on(context.event_types.GENERATION_ENDED, stopObserver);
        console.log('[CostumeSwitch] DEBUG: Checkpoint 7 - Observer initialized and events bound.');
    }

    function setupUI() {
        console.log('[CostumeSwitch] DEBUG: Checkpoint 8 - setupUI() called.');
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
                applyCostume(null);
            });
        }
    }

    async function loadSettingsPanel() {
    const htmlPath = `/data/default-user/extensions/SillyTavern-CostumeSwitch/settings.html`;
    const cssPath = `/data/default-user/extensions/SillyTavern-CostumeSwitch/style.css`;

    try {
        const htmlResp = await fetch(htmlPath);
        if (!htmlResp.ok) throw new Error(`Failed to fetch settings.html. Status: ${htmlResp.status}`);
        const html = await htmlResp.text();

        const container = document.createElement('div');
        container.innerHTML = html;
        document.getElementById('extensions_settings').appendChild(container);

        // Load the CSS
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = cssPath;
        document.head.appendChild(link);

        console.log('[CostumeSwitch] UI loaded successfully');
    } catch (err) {
        console.error('[CostumeSwitch] CRITICAL: Error loading UI:', err);
    }
}


    function main() {
        console.log('[CostumeSwitch] DEBUG: Checkpoint 4 - main() function executed.');
        context = SillyTavern.getContext();
        settings = { ...settings, ...context.extensionSettings[extensionName] };
        loadSettingsPanel();
        initializeObserver();
    }

    // [CostumeSwitch] DEBUG: Checkpoint 3 - Adding APP_READY event listener.
    console.log('[CostumeSwitch] DEBUG: Checkpoint 3 - Adding APP_READY event listener.');
    if (window.SillyTavern && SillyTavern.getContext) {
        SillyTavern.getContext().eventSource.on(SillyTavern.getContext().event_types.APP_READY, main);
    } else {
        // Fallback for older SillyTavern versions or unusual load orders.
        document.addEventListener('DOMContentLoaded', () => {
            const interval = setInterval(() => {
                if (window.SillyTavern && SillyTavern.getContext) {
                    clearInterval(interval);
                    SillyTavern.getContext().eventSource.on(SillyTavern.getContext().event_types.APP_READY, main);
                }
            }, 100);
        });
    }
})();
