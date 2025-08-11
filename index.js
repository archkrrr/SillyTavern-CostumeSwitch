// index.js - SillyTavern-CostumeSwitch (patched: stronger pronoun-resolution, index-aware,
// longer sliding window, slightly shorter cooldowns, optional debug logging)

import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "SillyTavern-CostumeSwitch";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// default settings
const DEFAULTS = {
    enabled: true,
    resetTimeoutMs: 3000,
    patterns: ["Shido", "Kotori", "Tohka"], // add Tohka by default since you mentioned it
    defaultCostume: "", // empty => use current character's own folder
    narrationSwitch: false, // opt-in loose narration fallback (matches outside quotes only)
    debug: false // set true to enable console logging for tuning
};

// safe regex escape
function escapeRegex(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// settings helper
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

// regex builders (unchanged behavior)
function buildNameRegex(patternList) {
    const escaped = patternList.map(p => {
        const trimmed = (p || '').trim();
        if (!trimmed) return null;
        const m = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
        if (m) return `(${m[1]})`;
        return `(${escapeRegex(trimmed)}(?:-(?:sama|san))?)`;
    }).filter(Boolean);
    if (escaped.length === 0) return null;
    return new RegExp(`(?:^|\\n|[\\(\\[\\-—–])(?:${escaped.join('|')})(?:\\W|$)`, 'i');
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
    const verbs = "(?:said|asked|replied|murmured|whispered|sighed|laughed|exclaimed|noted|added|answered|shouted|cried|muttered|remarked|insisted|murmured|observed)";
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
    const actions = "(?:took|nodded|leaned|smiled|laughed|stood|sat|gestured|sighed|reached|walked|turned|glanced|moved|stepped|entered|approached|adjusted|tilted)";
    return new RegExp(`(?:^|\\n)\\s*(?:${escaped.join('|')})\\b\\s+${actions}\\b`, 'i');
}

// quick check if position inside open quotes
function isInsideQuotes(text, pos) {
    if (!text || pos <= 0) return false;
    const before = text.slice(0, pos);
    const quoteCount = (before.match(/["\u201C\u201D]/g) || []).length;
    return (quoteCount % 2) === 1;
}

// runtime state
const perMessageBuffers = new Map();
// store last explicit as { name, idx } per buffer so we can ensure it occurs before pronoun matches
const lastExplicitPerBuf = new Map();
let lastIssuedCostume = null;
let resetTimer = null;
let lastSwitchTimestamp = 0;

// throttling
const lastTriggerTimes = new Map();
const TRIGGER_COOLDOWN_MS = 200; // slightly faster re-trigger
const GLOBAL_SWITCH_COOLDOWN_MS = 800; // shorter global cooldown so switches aren't too delayed

// sliding buffer
const BUFFER_KEEP = 1200; // keep more chars to preserve explicit mentions for pronoun resolution

// waitForSelector helper
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

// simple markdown/formatting strip
function stripFormatting(s) {
    if (!s) return s;
    return s.replace(/[*_~`]+/g, '').replace(/\s+/g,' ').trim();
}

// find last explicit name before a given pos; returns {name, idx} or null
function findLastExplicitBefore(text, pos, lookbackChars = 800) {
    const start = Math.max(0, pos - lookbackChars);
    const slice = text.slice(start, pos);
    const tryRegexes = [speakerRegex, actionRegex, nameRegex].filter(Boolean);
    for (const r of tryRegexes) {
        try {
            const re = new RegExp(r.source, 'gi');
            let m, last = null;
            while ((m = re.exec(slice)) !== null) last = { match: m, index: m.index + start };
            if (last) {
                for (let i = 1; i < last.match.length; i++) {
                    if (last.match[i]) return { name: String(last.match[i]).replace(/-(?:sama|san)$/i,'').trim(), idx: last.index };
                }
            }
        } catch (err) {
            // ignore regex errors
        }
    }
    return null;
}

// derived patterns: include characters found in context (first name + full name)
function buildDerivedPatterns(settings, realCtx) {
    const base = (settings.patterns || DEFAULTS.patterns).map(s => (s||'').trim()).filter(Boolean);
    const extra = [];
    try {
        if (realCtx && realCtx.characters) {
            for (const id of Object.keys(realCtx.characters)) {
                const ch = realCtx.characters[id];
                if (!ch || !ch.name) continue;
                const full = ch.name.trim();
                const parts = full.split(/\s+/).filter(Boolean);
                extra.push(full);
                if (parts.length) extra.push(parts[0]);
            }
        }
    } catch (e) {}
    return Array.from(new Set([...base, ...extra]));
}


// main
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

    const ok = await waitForSelector("#cs-save", 3000, 100);
    if (!ok) console.warn("CostumeSwitch: settings UI did not appear within timeout. Continuing...");

    if ($("#cs-enable").length) $("#cs-enable").prop("checked", !!settings.enabled);
    if ($("#cs-patterns").length) $("#cs-patterns").val((settings.patterns || []).join("\n"));
    if ($("#cs-default").length) $("#cs-default").val(settings.defaultCostume || "");
    if ($("#cs-timeout").length) $("#cs-timeout").val(settings.resetTimeoutMs || DEFAULTS.resetTimeoutMs);
    if ($("#cs-narration").length) $("#cs-narration").prop("checked", !!settings.narrationSwitch);
    if ($("#cs-debug").length) $("#cs-debug").prop("checked", !!settings.debug);
    if ($("#cs-status").length) $("#cs-status").text("Ready");

    function persistSettings() {
        if (save) save();
        if ($("#cs-status").length) {
            $("#cs-status").text(`Saved ${new Date().toLocaleTimeString()}`);
            setTimeout(()=>$("#cs-status").text(""), 1500);
        }
    }

    const realCtx = ctx || (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null);
    if (!realCtx) {
        console.error("SillyTavern context not found. Extension won't run.");
        return;
    }
    const { eventSource, event_types } = realCtx;

    // initial derived patterns and regexes
    let derivedPatterns = buildDerivedPatterns(settings, realCtx);
    let nameRegex = buildNameRegex(derivedPatterns);
    let speakerRegex = buildSpeakerRegex(derivedPatterns);
    let attributionRegex = buildAttributionRegex(derivedPatterns);
    let actionRegex = buildActionRegex(derivedPatterns);

    function tryWireUI() {
        if ($("#cs-save").length) {
            $("#cs-save").off('click.cs').on("click.cs", () => {
                settings.enabled = !!$("#cs-enable").prop("checked");
                settings.patterns = $("#cs-patterns").val().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                settings.defaultCostume = $("#cs-default").val().trim();
                settings.resetTimeoutMs = parseInt($("#cs-timeout").val()||DEFAULTS.resetTimeoutMs, 10);
                if ($("#cs-narration").length) settings.narrationSwitch = !!$("#cs-narration").prop("checked");
                if ($("#cs-debug").length) settings.debug = !!$("#cs-debug").prop("checked");

                derivedPatterns = buildDerivedPatterns(settings, realCtx);
                nameRegex = buildNameRegex(derivedPatterns);
                speakerRegex = buildSpeakerRegex(derivedPatterns);
                attributionRegex = buildAttributionRegex(derivedPatterns);
                actionRegex = buildActionRegex(derivedPatterns);

                persistSettings();
            });
        }
        if ($("#cs-reset").length) {
            $("#cs-reset").off('click.cs').on("click.cs", async () => {
                await manualReset();
            });
        }
    }

    tryWireUI();
    setTimeout(tryWireUI, 500);
    setTimeout(tryWireUI, 1500);

    function triggerQuickReply(labelOrMsg) {
        try {
            const qrButtons = document.querySelectorAll('.qr--button');
            for (const btn of qrButtons) {
                const labelEl = btn.querySelector('.qr--button-label');
                if (labelEl && labelEl.innerText && labelEl.innerText.trim() === labelOrMsg) { btn.click(); return true; }
                if (btn.title && btn.title === labelOrMsg) { btn.click(); return true; }
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
        for (const c of candidates) { if (triggerQuickReply(c)) return true; }
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
        if (now - lastSwitchTimestamp < GLOBAL_SWITCH_COOLDOWN_MS) return;
        const argFolder = `${name}/${name}`;
        const last = lastTriggerTimes.get(argFolder) || 0;
        if (now - last < TRIGGER_COOLDOWN_MS) return;
        const ok = triggerQuickReplyVariants(argFolder) || triggerQuickReplyVariants(name);
        if (ok) {
            lastTriggerTimes.set(argFolder, now);
            lastIssuedCostume = argFolder;
            lastSwitchTimestamp = now;
            if ($("#cs-status").length) $("#cs-status").text(`Switched -> ${argFolder}`);
            setTimeout(()=>$("#cs-status").text(""), 1000);
            if (settings.debug) console.log(`CostumeSwitch: issued ${argFolder}`);
        } else {
            if ($("#cs-status").length) $("#cs-status").text(`Quick Reply not found for ${name}`);
            setTimeout(()=>$("#cs-status").text(""), 1000);
            if (settings.debug) console.log(`CostumeSwitch: quick reply missing for ${name}`);
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

    // main streaming handler
    eventSource.on(streamEventName, (...args) => {
        try {
            if (!settings.enabled) return;

            let tokenText = "";
            let messageId = null;
            if (typeof args[0] === 'number') { messageId = args[0]; tokenText = String(args[1] ?? ""); }
            else if (typeof args[0] === 'string' && args.length === 1) tokenText = args[0];
            else if (args[0] && typeof args[0] === 'object') {
                tokenText = String(args[0].token ?? args[0].text ?? "");
                messageId = args[0].messageId ?? args[1] ?? null;
            } else tokenText = String(args.join(' ') || "");

            if (!tokenText) return;

            const bufKey = messageId != null ? `m${messageId}` : 'live';
            const prev = perMessageBuffers.get(bufKey) || "";
            const combined = prev + tokenText;
            perMessageBuffers.set(bufKey, combined);

            const combinedPlain = stripFormatting(combined);

            let matchedName = null;
            let matchedIndex = null;
            // helper to store explicit with index
            function recordExplicitIfFound(name, idx) {
                if (name && typeof idx === 'number') {
                    lastExplicitPerBuf.set(bufKey, { name: String(name).replace(/-(?:sama|san)$/i,'').trim(), idx });
                    if (settings.debug) console.log(`CostumeSwitch: recorded explicit ${name} @${idx} (buf=${bufKey})`);
                } else if (name) {
                    lastExplicitPerBuf.set(bufKey, { name: String(name).replace(/-(?:sama|san)$/i,'').trim(), idx: combinedPlain.length });
                }
            }

            // --- Tiered logic ---

            // 1) Speaker "Name:"
            if (speakerRegex) {
                try {
                    const re = new RegExp(speakerRegex.source, 'gi');
                    let m, last = null;
                    while ((m = re.exec(combinedPlain)) !== null) last = { match: m, index: m.index };
                    if (last) {
                        matchedName = last.match[1]?.trim();
                        matchedIndex = last.index;
                        recordExplicitIfFound(matchedName, matchedIndex);
                        if (settings.debug) console.log(`CostumeSwitch: speakerRegex matched ${matchedName} @${matchedIndex}`);
                    }
                } catch (e) {}
            }

            // 2) Attribution (closing quote ... Name said  OR Name said, "...")
            if (!matchedName && attributionRegex) {
                try {
                    const re = new RegExp(attributionRegex.source, 'gi');
                    let m, last = null;
                    while ((m = re.exec(combinedPlain)) !== null) last = { match: m, index: m.index };
                    if (last) {
                        // pick first non-empty capture
                        for (let i = 1; i < last.match.length; i++) {
                            if (last.match[i]) {
                                matchedName = last.match[i].trim();
                                matchedIndex = last.index;
                                break;
                            }
                        }

                        // pronoun resolution if match is pronoun
                        if (matchedName && /^(she|he|they|it)$/i.test(matchedName)) {
                            // try more local explicit before this index
                            const resolved = findLastExplicitBefore(combinedPlain, matchedIndex, 800);
                            if (resolved && resolved.idx < matchedIndex) {
                                matchedName = resolved.name;
                                matchedIndex = resolved.idx;
                                if (settings.debug) console.log(`CostumeSwitch: resolved pronoun -> ${matchedName} via local search @${matchedIndex}`);
                            } else {
                                // fallback to lastExplicitPerBuf only if that explicit occurs BEFORE the attribution index
                                const le = lastExplicitPerBuf.get(bufKey);
                                if (le && le.idx < matchedIndex) {
                                    matchedName = le.name;
                                    matchedIndex = le.idx;
                                    if (settings.debug) console.log(`CostumeSwitch: resolved pronoun -> ${matchedName} via lastExplicitPerBuf @${matchedIndex}`);
                                } else {
                                    // give up on ambiguous pronoun
                                    if (settings.debug) console.log(`CostumeSwitch: ambiguous pronoun at ${matchedIndex}, no earlier explicit found`);
                                    matchedName = null;
                                    matchedIndex = null;
                                }
                            }
                        } else if (matchedName) {
                            recordExplicitIfFound(matchedName, matchedIndex);
                            if (settings.debug) console.log(`CostumeSwitch: attributionRegex matched ${matchedName} @${matchedIndex}`);
                        }
                    }
                } catch (e) {}
            }

            // 3) Action/narration "Tohka took a step..."
            if (!matchedName && actionRegex) {
                try {
                    const re = new RegExp(actionRegex.source, 'gi');
                    let m, last = null;
                    while ((m = re.exec(combinedPlain)) !== null) last = { match: m, index: m.index };
                    if (last) {
                        for (let i = 1; i < last.match.length; i++) {
                            if (last.match[i]) {
                                matchedName = last.match[i].trim();
                                matchedIndex = last.index;
                                break;
                            }
                        }
                        if (matchedName) {
                            recordExplicitIfFound(matchedName, matchedIndex);
                            if (settings.debug) console.log(`CostumeSwitch: actionRegex matched ${matchedName} @${matchedIndex}`);
                        }
                    }
                } catch (e) {}
            }

            // 4) Narration fallback (optional)
            if (!matchedName && nameRegex && settings.narrationSwitch) {
                try {
                    const actionsOrPossessive = "(?:'s|held|shifted|stood|sat|nodded|smiled|laughed|leaned|stepped|walked|turned|looked|moved|approached|said|asked|replied|observed|gazed|watched|beamed|frowned|sighed|gestured|patted|pointed|winked|cried|shouted|called|whispered|muttered|murmured|exclaimed)";
                    const re = new RegExp(`${nameRegex.source}\\b\\s+${actionsOrPossessive}\\b`, 'gi');
                    let mm, last = null;
                    while ((mm = re.exec(combinedPlain)) !== null) {
                        if (isInsideQuotes(combinedPlain, mm.index)) continue;
                        last = { match: mm, index: mm.index };
                    }
                    if (last) {
                        for (let i = 1; i < last.match.length; i++) {
                            if (last.match[i]) {
                                matchedName = String(last.match[i]).replace(/-(?:sama|san)$/i, '').trim();
                                matchedIndex = last.index;
                                break;
                            }
                        }
                        if (matchedName) {
                            recordExplicitIfFound(matchedName, matchedIndex);
                            if (settings.debug) console.log(`CostumeSwitch: narration fallback matched ${matchedName} @${matchedIndex}`);
                        }
                    }
                } catch (e) {}
            }

            // --- end tiered logic ---

            if (matchedName) {
                // Avoid switching if the detected name has no corresponding quick-reply but another quicker name exists:
                // we still attempt issueCostumeForName which tries several variants.
                issueCostumeForName(matchedName);
                scheduleResetIfIdle();

                // keep a sliding tail of buffer so future pronoun resolutions still have context
                const keep = combined.slice(-BUFFER_KEEP);
                perMessageBuffers.set(bufKey, keep);
                // also trim lastExplicit if it's outside our tail window (avoid stale indexes)
                const le = lastExplicitPerBuf.get(bufKey);
                if (le && le.idx < Math.max(0, combinedPlain.length - BUFFER_KEEP)) {
                    // adjust idx relative to new tail by discarding it (we'll rebuild as new explicit mentions come in)
                    lastExplicitPerBuf.delete(bufKey);
                }
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
        lastExplicitPerBuf.clear();
        lastIssuedCostume = null;
    });

    console.log("SillyTavern-CostumeSwitch (patched index-aware pronoun resolver) loaded.");
});
