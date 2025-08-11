// index.js - SillyTavern-CostumeSwitch (Final Patched Version w/ Performance Fix)
import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "SillyTavern-CostumeSwitch";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// Default settings
const DEFAULTS = {
    enabled: true,
    resetTimeoutMs: 3000,
    patterns: ["Shido", "Kotori"],
    defaultCostume: "",
    narrationSwitch: true
};

// --- Regex Builder Utilities ---
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function buildNameRegex(patternList) {
    const escaped = patternList.map(p => (p || '').trim()).filter(Boolean).map(p => {
        const m = p.match(/^\/(.+)\/([gimsuy]*)$/);
        return m ? `(${m[1]})` : `(${escapeRegex(p)}(?:-(?:sama|san))?)`;
    });
    return escaped.length ? new RegExp(`(?:^|\\W)(?:${escaped.join('|')})(?:\\W|$)`, 'i') : null;
}
function buildSpeakerRegex(patternList) {
    const escaped = patternList.map(p => (p || '').trim()).filter(Boolean).map(p => {
        const m = p.match(/^\/(.+)\/([gimsuy]*)$/);
        return m ? `(${m[1]})` : `(${escapeRegex(p)})`;
    });
    return escaped.length ? new RegExp(`(?:^|\\n)\\s*(${escaped.join('|')})\\s*:`, 'i') : null;
}
function buildAttributionRegex(patternList) {
    const escaped = patternList.map(p => (p || '').trim()).filter(Boolean).map(p => {
        const m = p.match(/^\/(.+)\/([gimsuy]*)$/);
        return m ? `(${m[1]})` : `(${escapeRegex(p)})`;
    });
    if (!escaped.length) return null;
    const verbs = "(?:said|asked|replied|murmured|whispered|sighed|laughed|exclaimed|noted|added|answered|shouted|cried|muttered|remarked)";
    const patA = `["\u201C\u201D][^"\u201C\u201D]{0,400}["\u201C\u201D]\\s*,?\\s*(?:${escaped.join('|')})\\s+${verbs}`;
    const patB = `(?:^|\\n)\\s*(?:${escaped.join('|')})\\s+${verbs}\\s*[:,]?\\s*["\u201C\u201D]`;
    return new RegExp(`(?:${patA})|(?:${patB})`, 'i');
}
function buildActionRegex(patternList) {
    const escaped = patternList.map(p => (p || '').trim()).filter(Boolean).map(p => {
        const m = p.match(/^\/(.+)\/([gimsuy]*)$/);
        return m ? `(${m[1]})` : `(${escapeRegex(p)})`;
    });
    if (!escaped.length) return null;
    const actions = "(?:nodded|leaned|smiled|laughed|stood|sat|gestured|sighed|reached|walked|turned|glanced|popped|moved|stepped|entered|approached)";
    return new RegExp(`(?:^|\\n)\\s*(?:${escaped.join('|')})\\b\\s+${actions}\\b`, 'i');
}

// --- Helper Utilities ---
function getSettingsObj() {
    const ctx = getContext ? getContext() : (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null);
    const settingsSource = ctx?.extensionSettings ?? extension_settings;
    if (settingsSource) {
        settingsSource[extensionName] = settingsSource[extensionName] || structuredClone(DEFAULTS);
        Object.assign(settingsSource[extensionName], { ...DEFAULTS, ...settingsSource[extensionName] });
        return { store: settingsSource, save: ctx?.saveSettingsDebounced ?? saveSettingsDebounced, ctx };
    }
    throw new Error("Can't find SillyTavern extension settings storage.");
}
function isInsideQuotes(text, pos) {
    if (!text || pos < 0) return false;
    return ((text.slice(0, pos).match(/["\u201C\u201D]/g) || []).length % 2) === 1;
}
function waitForSelector(selector, timeout = 3000) {
    return new Promise(resolve => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        const observer = new MutationObserver(() => {
            const el = document.querySelector(selector);
            if (el) {
                observer.disconnect();
                resolve(el);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { observer.disconnect(); resolve(document.querySelector(selector)); }, timeout);
    });
}

// --- Runtime State ---
const perMessageBuffers = new Map();
let lastIssuedCostume = null;
let resetTimer = null;
let lastSwitchTimestamp = 0;
let processBufferDebounce = null; // Debounce timer for performance

const lastTriggerTimes = new Map();
const TRIGGER_COOLDOWN_MS = 250;
const GLOBAL_SWITCH_COOLDOWN_MS = 1200;
const DEBOUNCE_DELAY_MS = 200; // Delay for processing buffer to prevent freezing

// --- Main Extension Logic ---
jQuery(async () => {
    const SCENE_BREAK_REGEX = /^(?:\s*)?(?:\*\*|\[|---|==|\/\/).+?(?:\*\*|\]|---|==|\/\/)\s*:\s*$/gm;

    const { store, save, ctx } = getSettingsObj();
    const settings = store[extensionName];

    await waitForSelector('#extensions_settings');
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);
    } catch (e) { console.warn("Failed to load settings.html:", e); }

    await waitForSelector("#cs-save");
    $("#cs-enable").prop("checked", !!settings.enabled);
    $("#cs-patterns").val((settings.patterns || []).join("\n"));
    $("#cs-default").val(settings.defaultCostume || "");
    $("#cs-timeout").val(settings.resetTimeoutMs);
    $("#cs-narration").prop("checked", !!settings.narrationSwitch);
    $("#cs-status").text("Ready");

    const realCtx = ctx || (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null);
    if (!realCtx) return console.error("SillyTavern context not found.");
    const { eventSource, event_types } = realCtx;

    let nameRegex, speakerRegex, attributionRegex, actionRegex;
    function buildAllRegex() {
        nameRegex = buildNameRegex(settings.patterns);
        speakerRegex = buildSpeakerRegex(settings.patterns);
        attributionRegex = buildAttributionRegex(settings.patterns);
        actionRegex = buildActionRegex(settings.patterns);
    }
    buildAllRegex();

    $("#cs-save").on("click", () => {
        settings.enabled = $("#cs-enable").is(":checked");
        settings.patterns = $("#cs-patterns").val().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        settings.defaultCostume = $("#cs-default").val().trim();
        settings.resetTimeoutMs = parseInt($("#cs-timeout").val(), 10) || DEFAULTS.resetTimeoutMs;
        settings.narrationSwitch = $("#cs-narration").is(":checked");
        buildAllRegex();
        save();
        $("#cs-status").text(`Saved ${new Date().toLocaleTimeString()}`).fadeOut(2000, () => $("#cs-status").text("").show());
    });
    $("#cs-reset").on("click", () => manualReset());

    // --- Core Functions ---
    function triggerQuickReply(labelOrMsg) {
        for (const btn of document.querySelectorAll('.qr--button')) {
            if ((btn.querySelector('.qr--button-label')?.innerText.trim() === labelOrMsg) || (btn.title === labelOrMsg)) {
                btn.click();
                return true;
            }
        }
        return false;
    }

    function triggerQuickReplyVariants(costumeArg) {
        if (!costumeArg) return false;
        const name = costumeArg.split('/')[0];
        const candidates = [costumeArg, name, `/costume ${costumeArg}`, `/costume ${name}`];
        if (!costumeArg.includes('/')) candidates.push(`${name}/${name}`, `/costume ${name}/${name}`);
        return candidates.some(triggerQuickReply);
    }

    async function issueCostumeForName(name) {
        if (!name) return;
        const now = Date.now();
        if (now - lastSwitchTimestamp < GLOBAL_SWITCH_COOLDOWN_MS) return;
        const argFolder = `${name}/${name}`;
        if (now - (lastTriggerTimes.get(argFolder) || 0) < TRIGGER_COOLDOWN_MS) return;

        if (triggerQuickReplyVariants(argFolder) || triggerQuickReplyVariants(name)) {
            lastTriggerTimes.set(argFolder, now);
            lastIssuedCostume = argFolder;
            lastSwitchTimestamp = now;
            $("#cs-status").text(`Switched -> ${argFolder}`).fadeOut(2000, () => $("#cs-status").text("").show());
        }
    }

    // This is the master function that analyzes the text buffer. It only runs after a pause.
    function processMessageBuffer(combined) {
        try {
            let lastSceneBreakIndex = -1;
            SCENE_BREAK_REGEX.lastIndex = 0;
            let sceneMatch;
            while ((sceneMatch = SCENE_BREAK_REGEX.exec(combined)) !== null) {
                lastSceneBreakIndex = sceneMatch.index + sceneMatch[0].length;
            }
            const searchWindow = combined.substring(lastSceneBreakIndex);
            
            let matchedName = null;
            let m, lastMatch;
            const findLast = (re) => {
                if (!re) return null;
                re.lastIndex = 0;
                let last = null;
                while ((m = re.exec(searchWindow)) !== null) last = m;
                return last;
            };

            // P1: Speaker
            lastMatch = findLast(speakerRegex);
            if (lastMatch) matchedName = lastMatch[1]?.trim();
            // P2: Attribution
            if (!matchedName) {
                lastMatch = findLast(attributionRegex);
                if (lastMatch) for (let i = 1; i < lastMatch.length; i++) if (lastMatch[i]) { matchedName = lastMatch[i].trim(); break; }
            }
            // P3: Action
            if (!matchedName) {
                lastMatch = findLast(actionRegex);
                if (lastMatch) for (let i = 1; i < lastMatch.length; i++) if (lastMatch[i]) { matchedName = lastMatch[i].trim(); break; }
            }
            // P4: Narration Fallback
            if (!matchedName && nameRegex && settings.narrationSwitch) {
                let lastNarrationMatch = null;
                const re = new RegExp(nameRegex.source, 'gi');
                while ((m = re.exec(searchWindow)) !== null) {
                    if (isInsideQuotes(searchWindow, m.index)) continue;
                    for (let i = 1; i < m.length; i++) if (m[i]) { lastNarrationMatch = { name: m[i] }; break; }
                }
                if (lastNarrationMatch) matchedName = String(lastNarrationMatch.name).replace(/-(?:sama|san)$/i, '').trim();
            }

            if (matchedName) issueCostumeForName(matchedName);

        } catch (err) { console.error("CostumeSwitch analysis error:", err); }
    }

    const streamEventName = event_types?.STREAM_TOKEN_RECEIVED || 'stream_token_received';
    eventSource.on(streamEventName, (...args) => {
        if (args[0]?.is_generating || !settings.enabled) return;

        let tokenText = "", messageId = null;
        if (typeof args[0] === 'number') { messageId = args[0]; tokenText = String(args[1] ?? ""); }
        else if (args[0] && typeof args[0] === 'object') { tokenText = String(args[0].token ?? args[0].text ?? ""); messageId = args[0].messageId ?? args[1] ?? null; }
        else { tokenText = String(args.join(' ') || ""); }
        if (!tokenText) return;

        const bufKey = messageId != null ? `m${messageId}` : 'live';
        const combined = (perMessageBuffers.get(bufKey) || "") + tokenText;
        perMessageBuffers.set(bufKey, combined);

        // Debounce the expensive processing to prevent freezing
        clearTimeout(processBufferDebounce);
        processBufferDebounce = setTimeout(() => processMessageBuffer(combined), DEBOUNCE_DELAY_MS);
    });

    eventSource.on(event_types.GENERATION_ENDED, (messageId) => {
        const bufKey = messageId != null ? `m${messageId}` : 'live';
        const finalBuffer = perMessageBuffers.get(bufKey);
        if (finalBuffer) {
            clearTimeout(processBufferDebounce);
            processMessageBuffer(finalBuffer); // Final run on the complete text
        }
        perMessageBuffers.delete(bufKey);
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        perMessageBuffers.clear();
        lastIssuedCostume = null;
    });

    console.log("SillyTavern-CostumeSwitch (Performance-Fixed) loaded.");
});
