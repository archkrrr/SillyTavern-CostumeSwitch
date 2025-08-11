// index.js - SillyTavern-CostumeSwitch (patched: robust UI init / waits for settings DOM)
import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "SillyTavern-CostumeSwitch";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// default settings
const DEFAULTS = {
    enabled: true,
    resetTimeoutMs: 3000,
    patterns: ["Shido", "Kotori"], // default simple names (one per line in UI)
    defaultCostume: "", // empty => use current character's own folder
    narrationSwitch: false // opt-in loose narration fallback (matches outside quotes only)
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

// small utility to build a combined regex from pattern list for narration (stricter)
function buildNameRegex(patternList) {
    const escaped = patternList.map(p => {
        const trimmed = (p || '').trim();
        if (!trimmed) return null;
        const m = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
        if (m) return `(${m[1]})`;
        return `(${escapeRegex(trimmed)}(?:-(?:sama|san))?)`;
    }).filter(Boolean);

    if (escaped.length === 0) return null;
    // require start-of-line OR newline OR opening bracket/dash before the name (less permissive)
    return new RegExp(`(?:^|\\n|[\\(\\[\\-—–])(?:${escaped.join('|')})(?:\\W|$)`, 'i');
}

// Helper - build the stricter speaker regex (e.g., "Name:")
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

// build regex that finds dialogue attribution patterns:
// e.g. "....", Tohka said   OR   Tohka said, "..."
function buildAttributionRegex(patternList) {
    const escaped = patternList.map(p => {
        const trimmed = (p || '').trim();
        if (!trimmed) return null;
        const m = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
        if (m) return `(${m[1]})`;
        return `(${escapeRegex(trimmed)})`;
    }).filter(Boolean);
    if (escaped.length === 0) return null;

    // verbs that typically mark speech attribution
    const verbs = "(?:said|asked|replied|murmured|whispered|sighed|laughed|exclaimed|noted|added|answered|shouted|cried|muttered|remarked)";
    // Pattern A: closing quote then optional comma then Name + verb
    const patA = `["\u201C\u201D][^"\u201C\u201D]{0,400}["\u201C\u201D]\\s*,?\\s*(?:${escaped.join('|')})\\s+${verbs}`;
    // Pattern B: start-of-line Name + verb + optional colon/comma + opening quote
    const patB = `(?:^|\\n)\\s*(?:${escaped.join('|')})\\s+${verbs}\\s*[:,]?\\s*["\u201C\u201D]`;
    return new RegExp(`(?:${patA})|(?:${patB})`, 'i');
}

// build an action/narration regex to catch lines like "Kotori nodded sharply."
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

// quick helper: detect whether a position in the text is inside an open quote region
function isInsideQuotes(text, pos) {
    if (!text || pos <= 0) return false;
    const before = text.slice(0, pos);
    const quoteCount = (before.match(/["\u201C\u201D]/g) || []).length;
    return (quoteCount % 2) === 1;
}

// runtime state
const perMessageBuffers = new Map();
let lastIssuedCostume = null;
let resetTimer = null;
let lastSwitchTimestamp = 0; // global cooldown

// throttling map and cooldown
const lastTriggerTimes = new Map();
const TRIGGER_COOLDOWN_MS = 250;
const GLOBAL_SWITCH_COOLDOWN_MS = 1200; // ms between ANY switch (tunable)

// small helper to wait for a DOM selector to appear (polling)
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

    // Wait for the settings elements to actually exist in the DOM (the settings.html script may
    // clone/move nodes asynchronously). If they appear slowly, we'll wait up to 3s.
    const ok = await waitForSelector("#cs-save", 3000, 100);
    if (!ok) {
        console.warn("CostumeSwitch: settings UI did not appear within timeout. Attempting to continue (UI may be unresponsive).");
    }

    // Now safe to query and wire UI — jQuery calls on missing elements will be no-ops, so protect by checking presence
    if ($("#cs-enable").length) $("#cs-enable").prop("checked", !!settings.enabled);
    if ($("#cs-patterns").length) $("#cs-patterns").val((settings.patterns || []).join("\n"));
    if ($("#cs-default").length) $("#cs-default").val(settings.defaultCostume || "");
    if ($("#cs-timeout").length) $("#cs-timeout").val(settings.resetTimeoutMs || DEFAULTS.resetTimeoutMs);
    if ($("#cs-narration").length) $("#cs-narration").prop("checked", !!settings.narrationSwitch);
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
    let speakerRegex = buildSpeakerRegex(settings.patterns || DEFAULTS.patterns);
    let attributionRegex = buildAttributionRegex(settings.patterns || DEFAULTS.patterns);
    let actionRegex = buildActionRegex(settings.patterns || DEFAULTS.patterns);

    // Wiring: only attach handlers if the elements exist — if they later appear, we re-run binding once
    function tryWireUI() {
        if ($("#cs-save").length) {
            $("#cs-save").off('click.cs').on("click.cs", () => {
                settings.enabled = !!$("#cs-enable").prop("checked");
                settings.patterns = $("#cs-patterns").val().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                settings.defaultCostume = $("#cs-default").val().trim();
                settings.resetTimeoutMs = parseInt($("#cs-timeout").val()||DEFAULTS.resetTimeoutMs, 10);
                if ($("#cs-narration").length) settings.narrationSwitch = !!$("#cs-narration").prop("checked");

                // rebuild regexes after saving patterns
                nameRegex = buildNameRegex(settings.patterns || DEFAULTS.patterns);
                speakerRegex = buildSpeakerRegex(settings.patterns || DEFAULTS.patterns);
                attributionRegex = buildAttributionRegex(settings.patterns || DEFAULTS.patterns);
                actionRegex = buildActionRegex(settings.patterns || DEFAULTS.patterns);

                persistSettings();
            });
        }

        if ($("#cs-reset").length) {
            $("#cs-reset").off('click.cs').on("click.cs", async () => {
                await manualReset();
            });
        }
    }

    // initial wire attempt (may be no-op if elements aren't present)
    tryWireUI();
    // if the elements were missing, attempt again after a short delay (in case settings.html's cloning script is still running)
    setTimeout(tryWireUI, 500);
    setTimeout(tryWireUI, 1500);

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
            if ($("#cs-status").length) $("#cs-status").text("No default costume defined.");
            return;
        }
        const ok = triggerQuickReplyVariants(costumeArg);
        if (ok) {
            lastIssuedCostume = costumeArg;
            if ($("#cs-status").length) $("#cs-status").text(`Reset -> ${costumeArg}`);
            setTimeout(()=>$("#cs-status").text(""), 1500);
        } else {
            if ($("#cs-status").length) $("#cs-status").text(`Quick Reply not found for ${costumeArg}`);
            setTimeout(()=>$("#cs-status").text(""), 1500);
        }
    }

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
            lastSwitchTimestamp = now; // update the global timestamp on success
            if ($("#cs-status").length) $("#cs-status").text(`Switched -> ${argFolder}`);
            setTimeout(()=>$("#cs-status").text(""), 1000);
        } else {
            if ($("#cs-status").length) $("#cs-status").text(`Quick Reply not found for ${name}`);
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
                    if ($("#cs-status").length) $("#cs-status").text(`Auto-reset -> ${costumeArg}`);
                    setTimeout(()=>$("#cs-status").text(""), 1200);
                }
            })();
        }, settings.resetTimeoutMs || DEFAULTS.resetTimeoutMs);
    }

    const streamEventName = event_types?.STREAM_TOKEN_RECEIVED || event_types?.SMOOTH_STREAM_TOKEN_RECEIVED || 'stream_token_received';

    // Main stream handler with context-aware matching
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

            // --- Start of Tiered Logic ---

            // Priority 1: Check for a "Speaker:" match first (explicit)
            if (speakerRegex) {
                const speakerSearchRe = new RegExp(speakerRegex.source, 'gi');
                let lastSpeakerMatch = null;
                let m;
                while ((m = speakerSearchRe.exec(combined)) !== null) {
                    lastSpeakerMatch = m;
                }

                if (lastSpeakerMatch) {
                    matchedName = lastSpeakerMatch[1]?.trim();
                }
            }

            // Priority 2: Dialogue attribution (e.g., "..." , Name said  OR  Name said, "...")
            if (!matchedName && attributionRegex) {
                const aRe = new RegExp(attributionRegex.source, 'gi');
                let lastA = null;
                let am;
                while ((am = aRe.exec(combined)) !== null) lastA = am;
                if (lastA) {
                    for (let i = 1; i < lastA.length; i++) {
                        if (lastA[i]) {
                            matchedName = lastA[i].trim();
                            break;
                        }
                    }
                }
            }

            // Priority 3: Action/narration lines that start with the name (Kotori nodded...)
            if (!matchedName && actionRegex) {
                const acRe = new RegExp(actionRegex.source, 'gi');
                let lastAct = null;
                let am;
                while ((am = acRe.exec(combined)) !== null) lastAct = am;
                if (lastAct) {
                    for (let i = 1; i < lastAct.length; i++) {
                        if (lastAct[i]) {
                            matchedName = lastAct[i].trim();
                            break;
                        }
                    }
                }
            }

                // Priority 4: Optional fallback - match Name + verb/possessive anywhere in narration
if (!matchedName && nameRegex && settings.narrationSwitch) {
    // Large set of common narration verbs/adjectives/possessives
    const actionsOrPossessive = "(?:'s|held|shifted|stood|sat|nodded|smiled|laughed|leaned|stepped|walked|turned|looked|moved|approached|said|asked|replied|observed|gazed|watched|beamed|frowned|grimaced|sighed|grinned|shrugged|gestured|patted|pointed|winked|cried|shouted|called|whispered|muttered|murmured|exclaimed|yelled|hissed|growled|tilted|lowered|raised|offered|placed|rested|crossed|uncrossed|adjusted|brushed|tapped|drummed|pulled|pushed|hugged|embraced|kissed|blushed|flinched|winced|smirked|glared|narrowed|widened|opened|closed|folded|unfolded|readjusted|touched|stroked|caressed|examined|inspected|studied|surveyed|scanned|noted|remarked|added|continued|explained|clarified|responded|countered|retorted|offered)";
    
    // Allow the name anywhere in narration, followed by our markers
    const narrationRe = new RegExp(`${nameRegex.source}\\b\\s+${actionsOrPossessive}\\b`, 'gi');

    let lastMatch = null;
    let mm;
    while ((mm = narrationRe.exec(combined)) !== null) {
        if (isInsideQuotes(combined, mm.index)) continue; // skip if inside dialogue
        for (let i = 1; i < mm.length; i++) {
            if (mm[i]) {
                lastMatch = { name: mm[i], idx: mm.index };
                break;
            }
        }
    }
    if (lastMatch) {
        matchedName = String(lastMatch.name).replace(/-(?:sama|san)$/i, '').trim();
    }
}




            // --- End of Tiered Logic ---

            if (matchedName) {
                issueCostumeForName(matchedName);
                scheduleResetIfIdle();
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

    console.log("SillyTavern-CostumeSwitch (context-aware) loaded.");
});
