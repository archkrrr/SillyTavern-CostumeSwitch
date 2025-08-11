// index.js - SillyTavern-CostumeSwitch (Final Patched Version)
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
    narrationSwitch: true // Default the narration fallback to ON, as it's now more accurate
};

// --- Regex Builder Utilities ---

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function buildNameRegex(patternList) {
    const escaped = patternList.map(p => {
        const trimmed = (p || '').trim();
        if (!trimmed) return null;
        const m = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
        if (m) return `(${m[1]})`;
        return `(${escapeRegex(trimmed)}(?:-(?:sama|san))?)`;
    }).filter(Boolean);

    if (escaped.length === 0) return null;
    return new RegExp(`(?:^|\\W)(?:${escaped.join('|')})(?:\\W|$)`, 'i');
}

function buildSpeakerRegex(patternList) {
    const escaped = patternList.map(p => {
        const trimmed = (p || '').trim();
        if (!trimmed) return null;
        const m = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
        if (m) return `(${m[1]})`;
        return `(${escapeRegex(trimmed)})`;
    }).filter(Boolean);

    if (escaped.length === 0) return null;
    return new RegExp(`(?:^|\\n)\\s*(${escaped.join('|')})\\s*:`, 'i');
}

function buildAttributionRegex(patternList) {
    const escaped = patternList.map(p => {
        const trimmed = (p || '').trim();
        if (!trimmed) return null;
        const m = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
        if (m) return `(${m[1]})`;
        return `(${escapeRegex(trimmed)})`;
    }).filter(Boolean);
    if (escaped.length === 0) return null;

    const verbs = "(?:said|asked|replied|murmured|whispered|sighed|laughed|exclaimed|noted|added|answered|shouted|cried|muttered|remarked)";
    const patA = `["\u201C\u201D][^"\u201C\u201D]{0,400}["\u201C\u201D]\\s*,?\\s*(?:${escaped.join('|')})\\s+${verbs}`;
    const patB = `(?:^|\\n)\\s*(?:${escaped.join('|')})\\s+${verbs}\\s*[:,]?\\s*["\u201C\u201D]`;
    return new RegExp(`(?:${patA})|(?:${patB})`, 'i');
}

function buildActionRegex(patternList) {
    const escaped = patternList.map(p => {
        const trimmed = (p || '').trim();
        if (!trimmed) return null;
        const m = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
        if (m) return `(${m[1]})`;
        return `(${escapeRegex(trimmed)})`;
    }).filter(Boolean);
    if (escaped.length === 0) return null;

    const actions = "(?:nodded|leaned|smiled|laughed|stood|sat|gestured|sighed|reached|walked|turned|glanced|popped|moved|stepped|entered|approached)";
    return new RegExp(`(?:^|\\n)\\s*(?:${escaped.join('|')})\\b\\s+${actions}\\b`, 'i');
}

// --- Helper Utilities ---

function getSettingsObj() {
    const ctx = getContext ? getContext() : (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null);
    if (ctx && ctx.extensionSettings) {
        ctx.extensionSettings[extensionName] = ctx.extensionSettings[extensionName] || structuredClone(DEFAULTS);
        for (const k of Object.keys(DEFAULTS)) {
            if (!Object.hasOwn(ctx.extensionSettings[extensionName], k)) ctx.extensionSettings[extensionName][k] = DEFAULTS[k];
        }
        return { store: ctx.extensionSettings, save: ctx.saveSettingsDebounced || saveSettingsDebounced, ctx };
    }
    if (typeof extension_settings !== 'undefined') {
        extension_settings[extensionName] = extension_settings[extensionName] || structuredClone(DEFAULTS);
        for (const k of Object.keys(DEFAULTS)) {
            if (!Object.hasOwn(extension_settings[extensionName], k)) extension_settings[extensionName][k] = DEFAULTS[k];
        }
        return { store: extension_settings, save: saveSettingsDebounced, ctx: null };
    }
    throw new Error("Can't find SillyTavern extension settings storage.");
}

function isInsideQuotes(text, pos) {
    if (!text || pos <= 0) return false;
    const before = text.slice(0, pos);
    const quoteCount = (before.match(/["\u201C\u201D]/g) || []).length;
    return (quoteCount % 2) === 1;
}

function waitForSelector(selector, timeout = 3000, interval = 120) {
    return new Promise((resolve) => {
        const start = Date.now();
        const iv = setInterval(() => {
            const el = document.querySelector(selector);
            if (el) {
                clearInterval(iv);
                resolve(true);
                return;
            }
            if (Date.now() - start > timeout) {
                clearInterval(iv);
                resolve(false);
            }
        }, interval);
    });
}

// --- Runtime State ---

const perMessageBuffers = new Map();
let lastIssuedCostume = null;
let resetTimer = null;
let lastSwitchTimestamp = 0;

const lastTriggerTimes = new Map();
const TRIGGER_COOLDOWN_MS = 250;
const GLOBAL_SWITCH_COOLDOWN_MS = 1200;

// --- Main Extension Logic ---

jQuery(async () => {
    // Regex to detect scene changes like **Location:** or [Location]:
    const SCENE_BREAK_REGEX = new RegExp(
        '(?:^|\\n)\\s*(?:' +
        '\\*\\*(.+?)\\*\\*|' +
        '\\[(.+?)\\]|' +
        '---\\s*(.+?)\\s*---|' +
        '\\/\\/\\s*(.+?)\\s*\\/\\/' +
        ')\\s*:\\s*(?=\\n|$)',
        'g'
    );

    const { store, save, ctx } = getSettingsObj();
    const settings = store[extensionName];

    // Load HTML and robustly wire up the UI
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);
    } catch (e) {
        console.warn("Failed to load settings.html:", e);
    }

    if (!(await waitForSelector("#cs-save", 3000))) {
        console.warn("CostumeSwitch: settings UI did not appear within timeout.");
    }

    if ($("#cs-enable").length) $("#cs-enable").prop("checked", !!settings.enabled);
    if ($("#cs-patterns").length) $("#cs-patterns").val((settings.patterns || []).join("\n"));
    if ($("#cs-default").length) $("#cs-default").val(settings.defaultCostume || "");
    if ($("#cs-timeout").length) $("#cs-timeout").val(settings.resetTimeoutMs || DEFAULTS.resetTimeoutMs);
    if ($("#cs-narration").length) $("#cs-narration").prop("checked", !!settings.narrationSwitch);
    $("#cs-status").text("Ready");

    function persistSettings() {
        if (save) save();
        $("#cs-status").text(`Saved ${new Date().toLocaleTimeString()}`);
        setTimeout(() => $("#cs-status").text(""), 1500);
    }

    const realCtx = ctx || (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null);
    if (!realCtx) {
        console.error("SillyTavern context not found. Extension won't run.");
        return;
    }
    const { eventSource, event_types } = realCtx;

    // Build initial regexes
    let nameRegex = buildNameRegex(settings.patterns || DEFAULTS.patterns);
    let speakerRegex = buildSpeakerRegex(settings.patterns || DEFAULTS.patterns);
    let attributionRegex = buildAttributionRegex(settings.patterns || DEFAULTS.patterns);
    let actionRegex = buildActionRegex(settings.patterns || DEFAULTS.patterns);

    function tryWireUI() {
        if ($("#cs-save").length) {
            $("#cs-save").off('click.cs').on("click.cs", () => {
                settings.enabled = !!$("#cs-enable").prop("checked");
                settings.patterns = $("#cs-patterns").val().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                settings.defaultCostume = $("#cs-default").val().trim();
                settings.resetTimeoutMs = parseInt($("#cs-timeout").val() || DEFAULTS.resetTimeoutMs, 10);
                if ($("#cs-narration").length) settings.narrationSwitch = !!$("#cs-narration").prop("checked");

                nameRegex = buildNameRegex(settings.patterns || DEFAULTS.patterns);
                speakerRegex = buildSpeakerRegex(settings.patterns || DEFAULTS.patterns);
                attributionRegex = buildAttributionRegex(settings.patterns || DEFAULTS.patterns);
                actionRegex = buildActionRegex(settings.patterns || DEFAULTS.patterns);
                persistSettings();
            });
        }
        if ($("#cs-reset").length) {
            $("#cs-reset").off('click.cs').on("click.cs", () => manualReset());
        }
    }
    tryWireUI(); // Initial attempt
    setTimeout(tryWireUI, 1500); // Retry for slow-loading UIs

    function triggerQuickReply(labelOrMsg) {
        try {
            for (const btn of document.querySelectorAll('.qr--button')) {
                const labelEl = btn.querySelector('.qr--button-label');
                if ((labelEl && labelEl.innerText.trim() === labelOrMsg) || (btn.title === labelOrMsg)) {
                    btn.click();
                    return true;
                }
            }
        } catch (err) { console.warn("triggerQuickReply error:", err); }
        return false;
    }

    function triggerQuickReplyVariants(costumeArg) {
        if (!costumeArg) return false;
        const name = costumeArg.split('/')[0];
        const candidates = [costumeArg, name, `/costume ${costumeArg}`, `/costume ${name}`];
        if (!costumeArg.includes('/')) {
            candidates.push(`${name}/${name}`, `/costume ${name}/${name}`);
        }
        for (const c of candidates) {
            if (triggerQuickReply(c)) return true;
        }
        return false;
    }

    async function issueCostumeForName(name) {
        if (!name) return;
        const now = Date.now();

        if (now - lastSwitchTimestamp < GLOBAL_SWITCH_COOLDOWN_MS) return;

        const argFolder = `${name}/${name}`;
        const last = lastTriggerTimes.get(argFolder) || 0;
        if (now - last < TRIGGER_COOLDOWN_MS) return;

        if (triggerQuickReplyVariants(argFolder) || triggerQuickReplyVariants(name)) {
            lastTriggerTimes.set(argFolder, now);
            lastIssuedCostume = argFolder;
            lastSwitchTimestamp = now;
            $("#cs-status").text(`Switched -> ${argFolder}`);
            setTimeout(() => $("#cs-status").text(""), 1000);
        } else {
            $("#cs-status").text(`QR not found for ${name}`);
            setTimeout(() => $("#cs-status").text(""), 1000);
        }
    }

    const streamEventName = event_types?.STREAM_TOKEN_RECEIVED || 'stream_token_received';

    eventSource.on(streamEventName, (...args) => {
        try {
            if (args[0] && typeof args[0] === 'object' && args[0].is_generating) return;
            if (!settings.enabled) return;

            let tokenText = "", messageId = null;
            if (typeof args[0] === 'number') { messageId = args[0]; tokenText = String(args[1] ?? ""); }
            else if (args[0] && typeof args[0] === 'object') { tokenText = String(args[0].token ?? args[0].text ?? ""); messageId = args[0].messageId ?? args[1] ?? null; }
            else { tokenText = String(args.join(' ') || ""); }
            if (!tokenText) return;

            const bufKey = messageId != null ? `m${messageId}` : 'live';
            const combined = (perMessageBuffers.get(bufKey) || "") + tokenText;
            perMessageBuffers.set(bufKey, combined);

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
                let last = null;
                re.lastIndex = 0;
                while ((m = re.exec(searchWindow)) !== null) last = m;
                return last;
            };

            // P1: Speaker
            if (speakerRegex) {
                lastMatch = findLast(new RegExp(speakerRegex.source, 'gi'));
                if (lastMatch) matchedName = lastMatch[1]?.trim();
            }
            // P2: Attribution
            if (!matchedName && attributionRegex) {
                lastMatch = findLast(new RegExp(attributionRegex.source, 'gi'));
                if (lastMatch) for (let i = 1; i < lastMatch.length; i++) if (lastMatch[i]) { matchedName = lastMatch[i].trim(); break; }
            }
            // P3: Action
            if (!matchedName && actionRegex) {
                lastMatch = findLast(new RegExp(actionRegex.source, 'gi'));
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

            if (matchedName) {
                issueCostumeForName(matchedName);
            }
        } catch (err) {
            console.error("CostumeSwitch stream handler error:", err);
        }
    });

    eventSource.on(event_types.GENERATION_ENDED, (messageId) => {
        if (messageId != null) perMessageBuffers.delete(`m${messageId}`);
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
        if (messageId != null) perMessageBuffers.delete(`m${messageId}`);
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        perMessageBuffers.clear();
        lastIssuedCostume = null;
    });

    console.log("SillyTavern-CostumeSwitch (Scene-Aware) loaded.");
});
