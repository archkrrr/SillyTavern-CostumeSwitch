// index.js - SillyTavern-CostumeSwitch (full patched)
// Keep relative imports like the official examples
import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "SillyTavern-CostumeSwitch";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// default settings
const DEFAULTS = {
    enabled: true,
    resetTimeoutMs: 3000,
    patterns: ["Shido", "Kotori"], // default simple names (one per line in UI)
    defaultCostume: "" // empty => use current character's own folder
};

// simple safe regex-building util (escape plain text)
function escapeRegex(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// helper - read or init settings
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

// small utility to build a combined regex from pattern list for narration
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

// NEW: Helper function to build the stricter speaker regex (e.g., "Name:")
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

// runtime state
const perMessageBuffers = new Map();
let lastIssuedCostume = null;
let resetTimer = null;
let lastSwitchTimestamp = 0; // PATCH: For global cooldown

// throttling map and cooldown
const lastTriggerTimes = new Map();
const TRIGGER_COOLDOWN_MS = 250;
const GLOBAL_SWITCH_COOLDOWN_MS = 1200; // PATCH: ms between ANY switch (tunable)

jQuery(async () => {
    const { store, save, ctx } = getSettingsObj();
    const settings = store[extensionName];

    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);
    } catch (e) {
        console.warn("Failed to load settings.html:", e);
        $("#extensions_settings").append(`<div><h3>Costume Switch</h3><div>Failed to load UI (see console)</div></div>`);
    }

    $("#cs-enable").prop("checked", !!settings.enabled);
    $("#cs-patterns").val((settings.patterns || []).join("\n"));
    $("#cs-default").val(settings.defaultCostume || "");
    $("#cs-timeout").val(settings.resetTimeoutMs || DEFAULTS.resetTimeoutMs);
    $("#cs-status").text("Ready");

    function persistSettings() {
        if (save) save();
        $("#cs-status").text(`Saved ${new Date().toLocaleTimeString()}`);
        setTimeout(()=>$("#cs-status").text(""), 1500);
    }

    const realCtx = ctx || (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null);
    if (!realCtx) {
        console.error("SillyTavern context not found. Extension won't run.");
        return;
    }
    const { eventSource, event_types, characters } = realCtx;

    // Build initial regexes
    let nameRegex = buildNameRegex(settings.patterns || DEFAULTS.patterns);
    let speakerRegex = buildSpeakerRegex(settings.patterns || DEFAULTS.patterns); // PATCH: Build speaker regex

    $("#cs-save").on("click", () => {
        settings.enabled = !!$("#cs-enable").prop("checked");
        settings.patterns = $("#cs-patterns").val().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        settings.defaultCostume = $("#cs-default").val().trim();
        settings.resetTimeoutMs = parseInt($("#cs-timeout").val()||DEFAULTS.resetTimeoutMs, 10);
        // PATCH: rebuild both regexes after saving patterns
        nameRegex = buildNameRegex(settings.patterns || DEFAULTS.patterns);
        speakerRegex = buildSpeakerRegex(settings.patterns || DEFAULTS.patterns);
        persistSettings();
    });

    $("#cs-reset").on("click", async () => {
        await manualReset();
    });

    function triggerQuickReply(labelOrMsg) {
        try {
            const qrButtons = document.querySelectorAll('.qr--button');
            for (const btn of qrButtons) {
                const labelEl = btn.querySelector('.qr--button-label');
                if (labelEl && labelEl.innerText && labelEl.innerText.trim() === labelOrMsg) {
                    btn.click();
                    return true;
                }
                if (btn.title && btn.title === labelOrMsg) {
                    btn.click();
                    return true;
                }
            }
        } catch (err) {
            console.warn("triggerQuickReply error:", err);
        }
        return false;
    }

    function triggerQuickReplyVariants(costumeArg) {
        if (!costumeArg) return false;
        const candidates = [];
        if (costumeArg.includes('/')) {
            const parts = costumeArg.split('/');
            const name = parts[0];
            candidates.push(costumeArg, name, `/costume ${costumeArg}`, `/costume ${name}`);
        } else {
            const name = costumeArg;
            candidates.push(name, `${name}/${name}`, `/costume ${name}`, `/costume ${name}/${name}`);
        }
        for (const c of candidates) {
            if (triggerQuickReply(c)) return true;
        }
        return false;
    }

    async function manualReset() {
        let costumeArg = settings.defaultCostume || "";
        if (!costumeArg) {
            const ch = realCtx.characters?.[realCtx.characterId];
            if (ch && ch.name) costumeArg = `${ch.name}/${ch.name}`;
        }
        if (!costumeArg) {
            $("#cs-status").text("No default costume defined.");
            return;
        }
        const ok = triggerQuickReplyVariants(costumeArg);
        if (ok) {
            lastIssuedCostume = costumeArg;
            $("#cs-status").text(`Reset -> ${costumeArg}`);
            setTimeout(()=>$("#cs-status").text(""), 1500);
        } else {
            $("#cs-status").text(`Quick Reply not found for ${costumeArg}`);
            setTimeout(()=>$("#cs-status").text(""), 1500);
        }
    }

    // PATCH: issueCostumeForName function updated with global cooldown
    async function issueCostumeForName(name) {
        if (!name) return;
        const now = Date.now();

        // Check the GLOBAL cooldown first
        if (now - lastSwitchTimestamp < GLOBAL_SWITCH_COOLDOWN_MS) {
            return; // Too soon since the last switch, exit.
        }
        
        const argFolder = `${name}/${name}`;
        const last = lastTriggerTimes.get(argFolder) || 0;
        if (now - last < TRIGGER_COOLDOWN_MS) {
            return; // too soon to re-trigger the same costume; skip
        }

        const ok = triggerQuickReplyVariants(argFolder) || triggerQuickReplyVariants(name);
        if (ok) {
            lastTriggerTimes.set(argFolder, now);
            lastIssuedCostume = argFolder;
            lastSwitchTimestamp = now; // UPDATE the global timestamp on success
            $("#cs-status").text(`Switched -> ${argFolder}`);
            setTimeout(()=>$("#cs-status").text(""), 1000);
        } else {
            $("#cs-status").text(`Quick Reply not found for ${name}`);
            setTimeout(()=>$("#cs-status").text(""), 1000);
        }
    }

    function scheduleResetIfIdle() {
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
            (async () => {
                let costumeArg = settings.defaultCostume || "";
                if (!costumeArg) {
                    const ch = realCtx.characters?.[realCtx.characterId];
                    if (ch && ch.name) costumeArg = `${ch.name}/${ch.name}`;
                }
                if (costumeArg && triggerQuickReplyVariants(costumeArg)) {
                    lastIssuedCostume = costumeArg;
                    $("#cs-status").text(`Auto-reset -> ${costumeArg}`);
                    setTimeout(()=>$("#cs-status").text(""), 1200);
                }
            })();
        }, settings.resetTimeoutMs || DEFAULTS.resetTimeoutMs);
    }

    const streamEventName = event_types?.STREAM_TOKEN_RECEIVED || event_types?.SMOOTH_STREAM_TOKEN_RECEIVED || 'stream_token_received';

    // PATCH: The main stream handler with the new two-tiered logic
    eventSource.on(streamEventName, (...args) => {
        try {
            if (!settings.enabled) return;

            let tokenText = "";
            let messageId = null;
            if (typeof args[0] === 'number') {
                messageId = args[0];
                tokenText = String(args[1] ?? "");
            } else if (typeof args[0] === 'string' && args.length === 1) {
                tokenText = args[0];
            } else if (args[0] && typeof args[0] === 'object') {
                tokenText = String(args[0].token ?? args[0].text ?? "");
                messageId = args[0].messageId ?? args[1] ?? null;
            } else {
                tokenText = String(args.join(' ') || "");
            }

            if (!tokenText) return;

            const bufKey = messageId != null ? `m${messageId}` : 'live';
            const prev = perMessageBuffers.get(bufKey) || "";
            const combined = prev + tokenText;
            perMessageBuffers.set(bufKey, combined);

            let matchedName = null;

            // --- Start of New Tiered Logic ---

            // Priority 1: Check for a "Speaker:" match first
            if (speakerRegex) {
                const speakerSearchRe = new RegExp(speakerRegex.source, 'gi');
                let lastSpeakerMatch = null;
                let m;
                while ((m = speakerSearchRe.exec(combined)) !== null) {
                    lastSpeakerMatch = m;
                }

                if (lastSpeakerMatch) {
                    // A speaker was found (e.g., "Kotori:"). The first capture group is the name.
                    matchedName = lastSpeakerMatch[1]?.trim();
                }
            }

            // Priority 2: If no speaker was found, fall back to finding the last mentioned name (narration)
            if (!matchedName && nameRegex) {
                const searchRe = new RegExp(nameRegex.source, 'gi');
                let lastMatch = null;
                let m;
                while ((m = searchRe.exec(combined)) !== null) {
                    // Find the actual capture group that matched, skipping the full match (m[0])
                    for (let i = 1; i < m.length; i++) {
                        if (m[i]) {
                            lastMatch = { name: m[i] };
                            break;
                        }
                    }
                }
                
                if (lastMatch) {
                    matchedName = String(lastMatch.name).replace(/-(?:sama|san)$/i, '').trim();
                }
            }

            // --- End of New Tiered Logic ---

            if (matchedName) {
                issueCostumeForName(matchedName);
                scheduleResetIfIdle();
                // Clear the buffer after a successful match to prevent re-triggering on the same text
                perMessageBuffers.set(bufKey, "");
            }
        } catch (err) {
            console.error("CostumeSwitch stream handler error:", err);
        }
    });

    eventSource.on(event_types.GENERATION_ENDED, (messageId) => {
        if (messageId != null) perMessageBuffers.delete(`m${messageId}`);
        scheduleResetIfIdle();
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
        if (messageId != null) perMessageBuffers.delete(`m${messageId}`);
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        perMessageBuffers.clear();
        lastIssuedCostume = null;
    });

    console.log("SillyTavern-CostumeSwitch (fully patched) loaded.");
});
