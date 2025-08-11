(function () {
    const EXT_NAME = 'SillyTavern-CostumeSwitch';
    let enabled = true;
    let observer = null;
    let lastDetected = null;
    let buffers = { currentText: '' };

    // Map of character name -> costume folder name
    const characterMap = {
        'Shido': 'Shido',
        'Kotori': 'Kotori'
        // Add more names here if needed
    };

    const defaultCostume = 'DateALive';

    /** Logs with extension prefix */
    function log(...args) {
        console.log(`[${EXT_NAME}]`, ...args);
    }

    /** Builds a regex that matches any mapped character name, anywhere in text */
    function buildCharacterRegex() {
        const escaped = Object.keys(characterMap)
            .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        return new RegExp(`\\b(?:${escaped.join('|')})(?:\\s*[:—-])?`, 'i');
    }

    /** Sends a SillyTavern slash command */
    function sendSlashCommand(command) {
        if (typeof window.sendMessage === 'function') {
            window.sendMessage(command);
            log('Sent command:', command);
        } else {
            log('Cannot send command — window.sendMessage() not found!');
        }
    }

    /** Switch costume to a given character or default */
    function switchCostume(name) {
        const folder = characterMap[name] || defaultCostume;
        if (lastDetected === folder) return; // Avoid duplicate spam
        lastDetected = folder;
        sendSlashCommand(`/costume ${folder}`);
    }

    /** Resets costume to default */
    function resetCostume() {
        log('Resetting costume to default.');
        lastDetected = null;
        switchCostume(defaultCostume);
    }

    /** Process any new text chunk from the AI output */
    function processTextChunk(chunk) {
        const regex = buildCharacterRegex();
        const match = chunk.match(regex);
        if (match) {
            const name = match[0].replace(/[:—-]$/, '').trim();
            if (name) {
                switchCostume(name);
            }
        }
    }

    /** Handle streaming text updates from MutationObserver */
    function handleMutations(mutations) {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.TEXT_NODE) {
                    const text = node.textContent || '';
                    buffers.currentText += text;
                    processTextChunk(buffers.currentText);
                }
            }
            if (mutation.type === 'characterData' && mutation.target.nodeType === Node.TEXT_NODE) {
                buffers.currentText += mutation.target.textContent || '';
                processTextChunk(buffers.currentText);
            }
        }
    }

    /** Start observing the last message's text for streaming updates */
    function startObservingLastMessage() {
        stopObserving();
        const lastMsg = document.querySelector('#chat .mes:last-child .mes_text');
        if (!lastMsg) {
            log('No last message found to observe.');
            return;
        }
        buffers.currentText = '';
        observer = new MutationObserver(handleMutations);
        observer.observe(lastMsg, { childList: true, subtree: true, characterData: true });
        log('Now observing last AI message.');
    }

    /** Stop observing message updates */
    function stopObserving() {
        if (observer) {
            observer.disconnect();
            observer = null;
            log('Stopped observing.');
        }
    }

    /** Set up SillyTavern event hooks */
    function initEventHooks() {
        if (!window.ST || !ST.on) {
            log('SillyTavern event API not found, retrying...');
            setTimeout(initEventHooks, 1000);
            return;
        }

        ST.on('GENERATION_STARTED', () => {
            if (!enabled) return;
            setTimeout(startObservingLastMessage, 200); // Wait for DOM render
        });

        ST.on('GENERATION_ENDED', () => {
            stopObserving();
            if (enabled) {
                setTimeout(resetCostume, 2000);
            }
        });

        log('Event hooks registered.');
    }

    /** Add UI to Extensions menu */
    function addUI() {
        const container = document.createElement('div');
        container.className = 'costume-switcher-extension';
        container.innerHTML = `
            <h4>Costume Switcher</h4>
            <label>
                <input type="checkbox" id="costumeSwitchToggle" ${enabled ? 'checked' : ''}>
                Enable real-time costume switching
            </label>
            <button id="costumeSwitchReset">Reset Costume</button>
        `;

        const menu = document.querySelector('#extensionsMenu');
        if (!menu) {
            log('Extensions menu not found, retrying...');
            setTimeout(addUI, 1000);
            return;
        }

        menu.appendChild(container);

        document.getElementById('costumeSwitchToggle').addEventListener('change', e => {
            enabled = e.target.checked;
            log('Enabled:', enabled);
        });

        document.getElementById('costumeSwitchReset').addEventListener('click', () => {
            resetCostume();
        });

        log('UI added to Extensions page.');
    }

    /** Wait until Extensions UI exists, then init */
    const waitUI = setInterval(() => {
        if (document.querySelector('#extensionsMenu')) {
            clearInterval(waitUI);
            addUI();
            initEventHooks();
            log('Extension initialized.');
        }
    }, 500);
})();
