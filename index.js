// index.js - SillyTavern-CostumeSwitch with quick-reply hijack + debouncing

import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "SillyTavern-CostumeSwitch";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const DEFAULTS = {
    enabled: true,
    resetTimeoutMs: 3000,
    patterns: ["Shido", "Kotori"], // default
    defaultCostume: ""
};

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

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

function buildNameRegex(patternList) {
    const escaped = patternList.map(p => {
        const trimmed = (p || '').trim();
        if (!trimmed) return null;
        const m = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
        if (m) return `(${m[1]})`;
        return `(${escapeRegex(trimmed)})`;
    }).filter(Boolean);

    if (escaped.length === 0) return null;
    // Match name anywhere, optional honorific, case-insensitive
    return new RegExp(`(?:${escaped.join('|')})(?:-(?:sama|san))?`, 'i');
}

const perMessageBuffers = new Map();
let lastIssuedCostume = null;
let resetTimer = null;

// Quick reply hijack helper
function triggerQuickReplyVariants(targetLabel) {
    try {
        const buttons = document.querySelectorAll('#quick_reply_panel .qr-button');
        for (const btn of buttons) {
            const label = btn.textContent.trim();
            if (label.toLowerCase() === targetLabel.toLowerCase()) {
                btn.click();
                return true;
            }
        }
    } catch (err) {
        console.error("Error triggering quick reply:", err);
    }
    return false;
}

// Debounce system
const pendingSwitches = new Map();
const DEBOUNCE_MS = 800;

async function issueCostumeForName(name) {
    if (!name) return;
    const argFolder = `${name}/${name}`;

    if (pendingSwitches.has(argFolder)) {
        clearTimeout(pendingSwitches.get(argFolder).timer);
    }

    const timer = setTimeout(() => {
        const ok = triggerQuickReplyVariants(argFolder) || triggerQuickReplyVariants(name);
        if (ok) {
            lastIssuedCostume = argFolder;
            $("#cs-status").text(`Switched -> ${argFolder}`);
            setTimeout(() => $("#cs-status").text(""), 1000);
        } else {
            $("#cs-status").text(`Quick Reply not found for ${name}`);
            setTimeout(() => $("#cs-status").text(""), 1000);
        }
        pendingSwitches.delete(argFolder);
    }, DEBOUNCE_MS);

    pendingSwitches.set(argFolder, { timer, ts: Date.now() });
}

function scheduleResetIfIdle(settings, realCtx) {
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
        (async () => {
            let costumeArg = settings.defaultCostume || "";
            if (!costumeArg) {
                const ch = realCtx.characters?.[realCtx.characterId];
                if (ch && ch.name) costumeArg = `${ch.name}/${ch.name}`;
            }
            if (costumeArg) {
                triggerQuickReplyVariants(costumeArg) || triggerQuickReplyVariants(costumeArg.split('/')[0]);
                lastIssuedCostume = costumeArg;
                $("#cs-status").text(`Auto-reset -> ${costumeArg}`);
                setTimeout(() => $("#cs-status").text(""), 1200);
            }
        })();
    }, settings.resetTimeoutMs || DEFAULTS.resetTimeoutMs);
}

jQuery(async () => {
    const { store, save, ctx } = getSettingsObj();
    const settings = store[extensionName];

    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);
    } catch (e) {
        console.warn("Failed to load settings.html:", e);
        $("#extensions_settings").append(`<div><h3>Costume Switch</h3><div>Failed to load UI</div></div>`);
    }

    $("#cs-enable").prop("checked", !!settings.enabled);
    $("#cs-patterns").val((settings.patterns || []).join("\n"));
    $("#cs-default").val(settings.defaultCostume || "");
    $("#cs-timeout").val(settings.resetTimeoutMs || DEFAULTS.resetTimeoutMs);
    $("#cs-status").text("Ready");

    function persistSettings() {
        if (save) save();
        $("#cs-status").text(`Saved ${new Date().toLocaleTimeString()}`);
        setTimeout(() => $("#cs-status").text(""), 1500);
    }

    $("#cs-save").on("click", () => {
        settings.enabled = !!$("#cs-enable").prop("checked");
        settings.patterns = $("#cs-patterns").val().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        settings.defaultCostume = $("#cs-default").val().trim();
        settings.resetTimeoutMs = parseInt($("#cs-timeout").val() || DEFAULTS.resetTimeoutMs, 10);
        nameRegex = buildNameRegex(settings.patterns || DEFAULTS.patterns);
        persistSettings();
    });

    $("#cs-reset").on("click", async () => {
        let costumeArg = settings.defaultCostume || "";
        if (!costumeArg) {
            const ch = ctx.characters?.[ctx.characterId];
            if (ch && ch.name) costumeArg = `${ch.name}/${ch.name}`;
        }
        if (!costumeArg) {
            $("#cs-status").text("No default costume defined.");
            return;
        }
        triggerQuickReplyVariants(costumeArg) || triggerQuickReplyVariants(costumeArg.split('/')[0]);
        lastIssuedCostume = costumeArg;
        $("#cs-status").text(`Reset -> ${costumeArg}`);
        setTimeout(() => $("#cs-status").text(""), 1500);
    });

    const realCtx = ctx || (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null);
    if (!realCtx) {
        console.error("SillyTavern context not found. Extension won't run.");
        return;
    }
    const { eventSource, event_types } = realCtx;

    let nameRegex = buildNameRegex(settings.patterns || DEFAULTS.patterns);
    const streamEventName = event_types?.STREAM_TOKEN_RECEIVED || event_types?.SMOOTH_STREAM_TOKEN_RECEIVED || 'stream_token_received';

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

            if (!nameRegex) return;

            const searchRe = new RegExp(nameRegex.source, 'gi');
            let lastMatch = null;
            let m;
            while ((m = searchRe.exec(combined)) !== null) {
                lastMatch = { m: m.slice(), index: m.index, len: m[0].length };
            }

            if (lastMatch) {
                let matchedName = null;
                for (let i = 1; i < lastMatch.m.length; i++) {
                    if (lastMatch.m[i]) {
                        matchedName = String(lastMatch.m[i]).replace(/-(?:sama|san)$/i, '').trim();
                        break;
                    }
                }
                if (matchedName) {
                    issueCostumeForName(matchedName);
                    scheduleResetIfIdle(settings, realCtx);
                    const cutPos = lastMatch.index + lastMatch.len;
                    perMessageBuffers.set(bufKey, combined.slice(cutPos));
                }
            }
        } catch (err) {
            console.error("CostumeSwitch stream handler error:", err);
        }
    });

    eventSource.on(event_types.GENERATION_ENDED, (messageId) => {
        if (messageId != null) perMessageBuffers.delete(`m${messageId}`);
        scheduleResetIfIdle(settings, realCtx);
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
        if (messageId != null) perMessageBuffers.delete(`m${messageId}`);
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        perMessageBuffers.clear();
        lastIssuedCostume = null;
    });

    console.log("SillyTavern-CostumeSwitch (quick-reply mode, debounced) loaded.");
});
