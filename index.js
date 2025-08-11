// index.js - SillyTavern-CostumeSwitch (patched: limited-search window, reused regexes,
// allow immediate different-name switches, index-aware explicit tracking, debug traces)

import { extension_settings, getContext, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "SillyTavern-CostumeSwitch";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const DEFAULTS = {
    enabled: true,
    resetTimeoutMs: 3000,
    patterns: ["Shido", "Kotori", "Tohka"],
    defaultCostume: "",
    narrationSwitch: false,
    debug: false
};

function escapeRegex(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function getSettingsObj() {
    const ctx = getContext ? getContext() : (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null);
    if (ctx && ctx.extensionSettings) {
        ctx.extensionSettings[extensionName] = ctx.extensionSettings[extensionName] || structuredClone(DEFAULTS);
        for (const k of Object.keys(DEFAULTS)) if (!Object.hasOwn(ctx.extensionSettings[extensionName], k)) ctx.extensionSettings[extensionName][k] = DEFAULTS[k];
        return { store: ctx.extensionSettings, save: ctx.saveSettingsDebounced || saveSettingsDebounced, ctx };
    }
    if (typeof extension_settings !== 'undefined') {
        extension_settings[extensionName] = extension_settings[extensionName] || structuredClone(DEFAULTS);
        for (const k of Object.keys(DEFAULTS)) if (!Object.hasOwn(extension_settings[extensionName], k)) extension_settings[extensionName][k] = DEFAULTS[k];
        return { store: extension_settings, save: saveSettingsDebounced, ctx: null };
    }
    throw new Error("Can't find SillyTavern extension settings storage.");
}

// Build regex sources (same idea as before)
function buildNameRegex(patternList) {
    const escaped = patternList.map(p => { const t=(p||'').trim(); if(!t) return null; const m=t.match(/^\/(.+)\/([gimsuy]*)$/); if(m) return `(${m[1]})`; return `(${escapeRegex(t)}(?:-(?:sama|san))?)`; }).filter(Boolean);
    if (!escaped.length) return null;
    return new RegExp(`(?:^|\\n|[\\(\\[\\-—–])(?:${escaped.join('|')})(?:\\W|$)`, 'i');
}
function buildSpeakerRegex(patternList) {
    const escaped = patternList.map(p => { const t=(p||'').trim(); if(!t) return null; const m=t.match(/^\/(.+)\/([gimsuy]*)$/); if(m) return `(${m[1]})`; return `(${escapeRegex(t)})`; }).filter(Boolean);
    if (!escaped.length) return null;
    return new RegExp(`(?:^|\\n)\\s*(${escaped.join('|')})\\s*:`, 'i');
}
function buildAttributionRegex(patternList) {
    const escaped = patternList.map(p => { const t=(p||'').trim(); if(!t) return null; const m=t.match(/^\/(.+)\/([gimsuy]*)$/); if(m) return `(${m[1]})`; return `(${escapeRegex(t)})`; }).filter(Boolean);
    if (!escaped.length) return null;
    const verbs = "(?:said|asked|replied|murmured|whispered|sighed|laughed|exclaimed|noted|added|answered|shouted|cried|muttered|remarked|insisted|observed)";
    const patA = `["\u201C\u201D][^"\u201C\u201D]{0,400}["\u201C\u201D]\\s*,?\\s*(?:${escaped.join('|')})\\s+${verbs}`;
    const patB = `(?:^|\\n)\\s*(?:${escaped.join('|')})\\s+${verbs}\\s*[:,]?\\s*["\u201C\u201D]`;
    return new RegExp(`(?:${patA})|(?:${patB})`, 'i');
}
function buildActionRegex(patternList) {
    const escaped = patternList.map(p => { const t=(p||'').trim(); if(!t) return null; const m=t.match(/^\/(.+)\/([gimsuy]*)$/); if(m) return `(${m[1]})`; return `(${escapeRegex(t)})`; }).filter(Boolean);
    if (!escaped.length) return null;
    const actions = "(?:took|nodded|leaned|smiled|laughed|stood|sat|gestured|sighed|reached|walked|turned|glanced|moved|stepped|appeared|adjusted|tilted)";
    return new RegExp(`(?:^|\\n)\\s*(?:${escaped.join('|')})\\b\\s+${actions}\\b`, 'i');
}

function isInsideQuotes(text, pos) {
    if (!text || pos <= 0) return false;
    const before = text.slice(0, pos);
    const qcount = (before.match(/["\u201C\u201D]/g) || []).length;
    return (qcount % 2) === 1;
}

// runtime state
const perMessageBuffers = new Map();
const lastExplicitPerBuf = new Map(); // stores { name, idx } (absolute index in plain text)
let lastIssuedCostume = null; // folder like "Tohka/Tohka"
let lastIssuedName = null; // "Tohka"
let resetTimer = null;
let lastSwitchTimestamp = 0;

// throttles
let TRIGGER_COOLDOWN_MS = 200;
let GLOBAL_SWITCH_COOLDOWN_MS = 400;

// tuning: how many chars to keep and how much to search each time
const BUFFER_KEEP = 1200;   // keep tail of buffer for context
const BUFFER_SEARCH = 1400; // only scan this many chars (tunable)

// precompiled regex holders (we'll set them after building patterns)
let nameRegex = null, speakerRegex = null, attributionRegex = null, actionRegex = null;
// also reusable 'gi' versions for searching slices
let nameRegexG = null, speakerRegexG = null, attributionRegexG = null, actionRegexG = null;

function stripFormatting(s) { if(!s) return s; return s.replace(/[*_~`]+/g,'').replace(/\s+/g,' ').trim(); }

function findLastExplicitBefore(text, pos, lookbackChars = 800) {
    const start = Math.max(0, pos - lookbackChars);
    const slice = text.slice(start, pos);
    const tryRegexes = [speakerRegexG, actionRegexG, nameRegexG].filter(Boolean);
    for (const r of tryRegexes) {
        try {
            r.lastIndex = 0;
            let m, last = null;
            while ((m = r.exec(slice)) !== null) {
                last = { match: m, index: start + m.index };
            }
            if (last) {
                for (let i = 1; i < last.match.length; i++) {
                    if (last.match[i]) return { name: String(last.match[i]).replace(/-(?:sama|san)$/i,'').trim(), idx: last.index };
                }
            }
        } catch (e) { /* ignore */ }
    }
    return null;
}

function buildDerivedPatterns(settings, realCtx) {
    const base = (settings.patterns || DEFAULTS.patterns).map(s => (s||'').trim()).filter(Boolean);
    const extra = [];
    try {
        if (realCtx && realCtx.characters) for (const id of Object.keys(realCtx.characters)) {
            const ch = realCtx.characters[id];
            if (!ch || !ch.name) continue;
            const full = ch.name.trim();
            const parts = full.split(/\s+/).filter(Boolean);
            extra.push(full);
            if (parts.length) extra.push(parts[0]);
        }
    } catch (e) {}
    return Array.from(new Set([...base, ...extra]));
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

    function waitForSelector(selector, timeout = 3000, interval = 120) {
        return new Promise((resolve) => {
            const start = Date.now();
            const iv = setInterval(() => {
                if (document.querySelector(selector)) { clearInterval(iv); resolve(true); return; }
                if (Date.now() - start > timeout) { clearInterval(iv); resolve(false); }
            }, interval);
        });
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
    if (!realCtx) { console.error("SillyTavern context not found. Extension won't run."); return; }
    const { eventSource, event_types } = realCtx;

    // build initial patterns & compile gi regexes
    function rebuildRegexes() {
        const derived = buildDerivedPatterns(settings, realCtx);
        nameRegex = buildNameRegex(derived);
        speakerRegex = buildSpeakerRegex(derived);
        attributionRegex = buildAttributionRegex(derived);
        actionRegex = buildActionRegex(derived);

        nameRegexG = nameRegex ? new RegExp(nameRegex.source, 'gi') : null;
        speakerRegexG = speakerRegex ? new RegExp(speakerRegex.source, 'gi') : null;
        attributionRegexG = attributionRegex ? new RegExp(attributionRegex.source, 'gi') : null;
        actionRegexG = actionRegex ? new RegExp(actionRegex.source, 'gi') : null;

        if (settings.debug) console.log("CostumeSwitch: rebuilt regexes:", { derived, nameRegex: !!nameRegex });
    }
    rebuildRegexes();

    function tryWireUI() {
        if ($("#cs-save").length) {
            $("#cs-save").off('click.cs').on("click.cs", () => {
                settings.enabled = !!$("#cs-enable").prop("checked");
                settings.patterns = $("#cs-patterns").val().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                settings.defaultCostume = $("#cs-default").val().trim();
                settings.resetTimeoutMs = parseInt($("#cs-timeout").val()||DEFAULTS.resetTimeoutMs, 10);
                if ($("#cs-narration").length) settings.narrationSwitch = !!$("#cs-narration").prop("checked");
                if ($("#cs-debug").length) settings.debug = !!$("#cs-debug").prop("checked");
                rebuildRegexes();
                persistSettings();
            });
        }
        if ($("#cs-reset").length) {
            $("#cs-reset").off('click.cs').on("click.cs", async () => { await manualReset(); });
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
        } catch (err) { console.warn("triggerQuickReply error:", err); }
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
        for (const c of candidates) if (triggerQuickReply(c)) return true;
        return false;
    }

    async function manualReset() {
        let costumeArg = settings.defaultCostume || "";
        if (!costumeArg) {
            const ch = realCtx.characters?.[realCtx.characterId];
            if (ch && ch.name) costumeArg = `${ch.name}/${ch.name}`;
        }
        if (!costumeArg) { if ($("#cs-status").length) $("#cs-status").text("No default costume defined."); return; }
        const ok = triggerQuickReplyVariants(costumeArg);
        if (ok) { lastIssuedCostume = costumeArg; lastIssuedName = costumeArg.split('/')[0]; if ($("#cs-status").length) $("#cs-status").text(`Reset -> ${costumeArg}`); setTimeout(()=>$("#cs-status").text(""),1500); }
        else { if ($("#cs-status").length) $("#cs-status").text(`Quick Reply not found for ${costumeArg}`); setTimeout(()=>$("#cs-status").text(""),1500); }
    }

    async function issueCostumeForName(name) {
        if (!name) return;
        const now = Date.now();
        // Extract last issued name
        const lastName = lastIssuedName || (lastIssuedCostume ? String(lastIssuedCostume).split('/')[0] : null);

        // If same name as last issued, respect global cooldown
        if (lastName === name && (now - lastSwitchTimestamp) < GLOBAL_SWITCH_COOLDOWN_MS) {
            if (settings.debug) console.log(`CostumeSwitch: skip ${name} due to global cooldown (same name).`);
            return;
        }
        // per-name cooldown
        const argFolder = `${name}/${name}`;
        const last = lastTriggerTimes.get(argFolder) || 0;
        if (now - last < TRIGGER_COOLDOWN_MS) {
            if (settings.debug) console.log(`CostumeSwitch: skip ${name} due to per-name cooldown.`);
            return;
        }

        const ok = triggerQuickReplyVariants(argFolder) || triggerQuickReplyVariants(name);
        if (ok) {
            lastTriggerTimes.set(argFolder, now);
            lastIssuedCostume = argFolder;
            lastIssuedName = name;
            lastSwitchTimestamp = now;
            if ($("#cs-status").length) $("#cs-status").text(`Switched -> ${argFolder}`);
            setTimeout(()=>$("#cs-status").text(""), 1000);
            if (settings.debug) console.log(`CostumeSwitch: switched -> ${argFolder}`);
        } else {
            if ($("#cs-status").length) $("#cs-status").text(`Quick Reply not found for ${name}`);
            setTimeout(()=>$("#cs-status").text(""), 1000);
            if (settings.debug) console.log(`CostumeSwitch: quick-reply not found for ${name}`);
        }
    }

    function scheduleResetIfIdle() {
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = setTimeout(async () => {
            let costumeArg = settings.defaultCostume || "";
            if (!costumeArg) {
                const ch = realCtx.characters?.[realCtx.characterId];
                if (ch && ch.name) costumeArg = `${ch.name}/${ch.name}`;
            }
            if (costumeArg && triggerQuickReplyVariants(costumeArg)) {
                lastIssuedCostume = costumeArg;
                lastIssuedName = costumeArg.split('/')[0];
                if ($("#cs-status").length) $("#cs-status").text(`Auto-reset -> ${costumeArg}`);
                setTimeout(()=>$("#cs-status").text(""), 1200);
            }
        }, settings.resetTimeoutMs || DEFAULTS.resetTimeoutMs);
    }

    const streamEventName = event_types?.STREAM_TOKEN_RECEIVED || event_types?.SMOOTH_STREAM_TOKEN_RECEIVED || 'stream_token_received';

    eventSource.on(streamEventName, (...args) => {
        try {
            if (!settings.enabled) return;

            let tokenText = "";
            let messageId = null;
            if (typeof args[0] === 'number') { messageId = args[0]; tokenText = String(args[1] ?? ""); }
            else if (typeof args[0] === 'string' && args.length === 1) tokenText = args[0];
            else if (args[0] && typeof args[0] === 'object') { tokenText = String(args[0].token ?? args[0].text ?? ""); messageId = args[0].messageId ?? args[1] ?? null; }
            else tokenText = String(args.join(' ') || "");

            if (!tokenText) return;

            const bufKey = messageId != null ? `m${messageId}` : 'live';
            const prev = perMessageBuffers.get(bufKey) || "";
            const combined = prev + tokenText;
            perMessageBuffers.set(bufKey, combined);

            const combinedPlain = stripFormatting(combined);

            // define the slice we will search this token (limits CPU)
            const searchFrom = Math.max(0, combinedPlain.length - BUFFER_SEARCH);
            const searchSlice = combinedPlain.slice(searchFrom);

            let matchedName = null;
            let matchedIndex = null;
            // helper to record explicit with absolute index
            function recordExplicitIfFound(name, absIdx) {
                if (!name || typeof absIdx !== 'number') return;
                lastExplicitPerBuf.set(bufKey, { name: String(name).replace(/-(?:sama|san)$/i,'').trim(), idx: absIdx });
                if (settings.debug) console.log(`CostumeSwitch: recorded explicit '${name}' @${absIdx} (buf=${bufKey})`);
            }

            // TIER 1: speakerRegexG (look for "Name:")
            if (speakerRegexG) {
                try {
                    speakerRegexG.lastIndex = 0;
                    let m, last = null;
                    while ((m = speakerRegexG.exec(searchSlice)) !== null) last = { m, idx: searchFrom + m.index };
                    if (last) {
                        matchedName = last.m[1]?.trim();
                        matchedIndex = last.idx;
                        recordExplicitIfFound(matchedName, matchedIndex);
                        if (settings.debug) console.log(`speaker match ${matchedName} @${matchedIndex}`);
                    }
                } catch (e) {}
            }

            // TIER 2: attributionRegexG
            if (!matchedName && attributionRegexG) {
                try {
                    attributionRegexG.lastIndex = 0;
                    let m, last = null;
                    while ((m = attributionRegexG.exec(searchSlice)) !== null) last = { m, idx: searchFrom + m.index };
                    if (last) {
                        // find first non-empty capture
                        for (let i=1;i<last.m.length;i++){ if (last.m[i]) { matchedName = last.m[i].trim(); matchedIndex = last.idx; break; } }
                        if (matchedName && /^(she|he|they|it)$/i.test(matchedName)) {
                            const resolved = findLastExplicitBefore(combinedPlain, matchedIndex, 800);
                            if (resolved && resolved.idx < matchedIndex) { matchedName = resolved.name; matchedIndex = resolved.idx; if (settings.debug) console.log(`resolved pronoun -> ${matchedName} @${matchedIndex}`); }
                            else {
                                const le = lastExplicitPerBuf.get(bufKey);
                                if (le && le.idx < matchedIndex) { matchedName = le.name; matchedIndex = le.idx; if (settings.debug) console.log(`resolved pronoun via lastExp -> ${matchedName} @${matchedIndex}`); }
                                else { if (settings.debug) console.log(`ambiguous pronoun at ${matchedIndex}`); matchedName = null; matchedIndex = null; }
                            }
                        } else if (matchedName) { recordExplicitIfFound(matchedName, matchedIndex); if (settings.debug) console.log(`attribution matched ${matchedName} @${matchedIndex}`); }
                    }
                } catch (e) {}
            }

            // TIER 3: actionRegexG
            if (!matchedName && actionRegexG) {
                try {
                    actionRegexG.lastIndex = 0;
                    let m, last = null;
                    while ((m = actionRegexG.exec(searchSlice)) !== null) last = { m, idx: searchFrom + m.index };
                    if (last) {
                        for (let i=1;i<last.m.length;i++){ if (last.m[i]) { matchedName = last.m[i].trim(); matchedIndex = last.idx; break; } }
                        if (matchedName) { recordExplicitIfFound(matchedName, matchedIndex); if (settings.debug) console.log(`action matched ${matchedName} @${matchedIndex}`); }
                    }
                } catch (e) {}
            }

            // TIER 4: narration fallback (if enabled)
            if (!matchedName && nameRegexG && settings.narrationSwitch) {
                try {
                    const actionsOrPossessive = "(?:'s|held|shifted|stood|sat|nodded|smiled|laughed|leaned|stepped|walked|turned|looked|moved|approached|said|asked|replied|observed|gazed|watched|beamed|frowned|sighed|gestured)";
                    const re = new RegExp(`${nameRegexG.source}\\b\\s+${actionsOrPossessive}\\b`,'gi');
                    let mm, last = null;
                    while ((mm = re.exec(searchSlice)) !== null) {
                        const absIdx = searchFrom + mm.index;
                        if (isInsideQuotes(combinedPlain, absIdx)) continue;
                        last = { mm, idx: absIdx };
                    }
                    if (last) {
                        for (let i=1;i<last.mm.length;i++){ if (last.mm[i]) { matchedName = last.mm[i].trim(); matchedIndex = last.idx; break; } }
                        if (matchedName) { recordExplicitIfFound(matchedName, matchedIndex); if (settings.debug) console.log(`narration fallback matched ${matchedName} @${matchedIndex}`); }
                    }
                } catch (e) {}
            }

            if (matchedName) {
                // attempt switch - issueCostumeForName handles cooldowns
                issueCostumeForName(matchedName);
                scheduleResetIfIdle();

                // trim buffer to tail
                const keep = combined.slice(-BUFFER_KEEP);
                perMessageBuffers.set(bufKey, keep);

                // drop older explicit if it's outside current tail
                const le = lastExplicitPerBuf.get(bufKey);
                if (le && le.idx < Math.max(0, combinedPlain.length - BUFFER_KEEP)) lastExplicitPerBuf.delete(bufKey);
            }

        } catch (err) {
            console.error("CostumeSwitch stream handler error:", err);
        }
    });

    eventSource.on(event_types.GENERATION_ENDED, (messageId) => {
        if (messageId != null) perMessageBuffers.delete(`m${messageId}`);
        scheduleResetIfIdle();
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => { if (messageId != null) perMessageBuffers.delete(`m${messageId}`); });
    eventSource.on(event_types.CHAT_CHANGED, () => { perMessageBuffers.clear(); lastExplicitPerBuf.clear(); lastIssuedCostume = null; lastIssuedName = null; });

    console.log("SillyTavern-CostumeSwitch (perf & switch-fix patch) loaded.");
});
