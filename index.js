// index.js - Main logic for the Costume Switcher extension

import {
    getContext,
    getApiUrl,
    extension_settings,
    saveSettingsDebounced,
} from '../../../../script/context.js';
import { eventSource, event_types } from '../../../../script/event-bus.js';
import { executeSlashCommand } from '../../../../script/slash-commands.js';

// A unique identifier for our settings
const EXTENSION_NAME = 'SillyTavern-CostumeSwitch';

// Default settings
const defaultSettings = {
    enabled: false,
    // Example characters and their corresponding costume folder names
    characterMap: {
        'Shido': 'Shido',
        'Kotori': 'Kotori_Itsuka',
    },
    defaultCostume: 'Date_a_Live', // The costume to reset to
    resetDelay: 5000, // 5 seconds
};

// Internal state variables
let lastDetectedCharacter = null;
let resetTimerId = null;
let mutationObserver = null;

/**
 * Loads the extension's settings, merging defaults with saved data.
 */
function loadSettings() {
    // Ensure our settings object exists
    if (!extension_settings) {
        extension_settings = {};
    }
    // Merge defaults with saved settings
    Object.assign(extension_settings, {
       ...defaultSettings,
       ...extension_settings,
    });
}

/**
 * Executes the /costume slash command.
 * @param {string} costumeName The name of the costume folder to switch to.
 */
async function switchCostume(costumeName) {
    if (!costumeName) {
        console.warn(`${EXTENSION_NAME}: Attempted to switch to an invalid costume name.`);
        return;
    }
    console.log(`${EXTENSION_NAME}: Switching costume to "${costumeName}"`);
    await executeSlashCommand(`/costume ${costumeName}`);
    lastDetectedCharacter = costumeName;
}

/**
 * The callback function for the MutationObserver.
 * Parses new text and triggers costume switches.
 * @param {MutationRecord} mutationsList List of mutations that occurred.
 */
function handleMessageStream(mutationsList) {
    const settings = extension_settings;
    if (!settings.enabled) return;

    let fullText = '';
    for (const mutation of mutationsList) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            mutation.addedNodes.forEach(node => {
                fullText += node.textContent;
            });
        } else if (mutation.type === 'characterData') {
            fullText += mutation.target.textContent;
        }
    }

    if (fullText) {
        // Build a dynamic regex from the character map in settings
        const characterNames = Object.keys(settings.characterMap).join('|');
        const regex = new RegExp(`(${characterNames}):`, 'g');
        let match;
        let foundCharacter = null;

        // Find the last match in the new text chunk
        while ((match = regex.exec(fullText))!== null) {
            foundCharacter = match;
        }

        if (foundCharacter) {
            const targetCostume = settings.characterMap[foundCharacter];
            if (targetCostume && targetCostume!== lastDetectedCharacter) {
                // A new character is speaking, cancel any pending reset
                if (resetTimerId) {
                    clearTimeout(resetTimerId);
                    resetTimerId = null;
                }
                switchCostume(targetCostume);

                // Set a new timer to reset to default
                resetTimerId = setTimeout(() => {
                    console.log(`${EXTENSION_NAME}: Inactivity timer expired. Resetting to default.`);
                    switchCostume(settings.defaultCostume);
                }, settings.resetDelay);
            }
        }
    }
}

/**
 * Starts observing the latest character message for new text.
 */
function startObserver() {
    const settings = extension_settings;
    if (!settings.enabled |

| mutationObserver) return;

    const targetNode = document.querySelector('#chat.mes.character-message:last-of-type.mes_text');
    if (targetNode) {
        mutationObserver = new MutationObserver(handleMessageStream);
        const config = { childList: true, subtree: true, characterData: true };
        mutationObserver.observe(targetNode, config);
        console.log(`${EXTENSION_NAME}: Observer started.`);
    }
}

/**
 * Stops the MutationObserver.
 */
function stopObserver() {
    if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
        console.log(`${EXTENSION_NAME}: Observer stopped.`);
    }
    // Also clear any pending reset timer
    if (resetTimerId) {
        clearTimeout(resetTimerId);
        resetTimerId = null;
    }
    lastDetectedCharacter = null; // Reset state
}

/**
 * Wires up the UI elements from settings.html to the extension's logic.
 */
function connectUi() {
    const settings = extension_settings;
    const toggle = document.getElementById('costume-switcher-toggle');
    const resetButton = document.getElementById('costume-switcher-reset');

    if (toggle) {
        toggle.checked = settings.enabled;
        toggle.addEventListener('change', () => {
            settings.enabled = toggle.checked;
            saveSettingsDebounced();
            if (!settings.enabled) {
                stopObserver(); // Immediately stop if disabled
            }
        });
    }

    if (resetButton) {
        resetButton.addEventListener('click', () => {
            console.log(`${EXTENSION_NAME}: Manual reset triggered.`);
            switchCostume(settings.defaultCostume);
        });
    }
}

// Main execution block
(function () {
    loadSettings();
    connectUi();

    // Start observing when a generation begins
    eventSource.on(event_types.GENERATION_STARTED, startObserver);
    // Stop observing when generation ends or is stopped
    eventSource.on(event_types.GENERATION_ENDED, stopObserver);
    eventSource.on(event_types.GENERATION_STOPPED, stopObserver);

    console.log(`${EXTENSION_NAME} loaded.`);
})();
