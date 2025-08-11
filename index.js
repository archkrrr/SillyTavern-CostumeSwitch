// index.js - SillyTavern-CostumeSwitch (patched: robust UI init / waits for settings DOM,
// plus sliding window, pronoun resolution, markdown-strip, derived character aliases)

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
            if (!Object.hasOwn(extension_settings[extensionName], k)) extension_settings[extensionName][extensionName] = DEFAULTS[k];
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
const lastExplicitPerBuf = new Map();
let lastIssuedCostume = null;
let resetTimer = null;
let lastSwitchTimestamp = 0; // global cooldown

// throttling map and cooldown
const lastTriggerTimes = new Map();
const TRIGGER_COOLDOWN_MS = 250;
const GLOBAL_SWITCH_COOLDOWN_MS = 1200; // ms between ANY switch (tunable)

// sliding buffer keep
const BUFFER_KEEP = 800; // chars to keep after a match (tuneable)


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


// --- New helpers for pronoun resolution + formatting strip ---

function stripFormatting(s) {
    if (!s) return s;
    // remove simple markdown bold/italic/code markers and excessive whitespace
    return s.replace(/[*_~`]+/g, '').replace(/\s+/g,' ').trim();
}

// find last explicit name using our strict speaker/action/name regexes, searching backward up to lookbackChars
function findLastExplicitBefore(text, pos, lookbackChars = 600) {
    const start = Math.max(0, pos - lookbackChars);
    const slice = text.slice(start, pos);
    const tryRegexes = [speakerRegex, actionRegex, nameRegex].filter(Boolean);
    for (const r of tryRegexes) {
        try {
            const re = new RegExp(r.source, 'gi');
            let m, last = null;
            while ((m = re.exec(slice)) !== null) last = m;
            if (last) {
                for (let i = 1; i < last.length; i++) {
                    if (last[i]) return String(last[i]).replace(/-(?:sama|san)$/i,'').trim();
                }
            }
        } catch (err) {
            // ignore ill-formed regex attempts
        }
    }
    return null;
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

    // Wait for the settings elements to actually exist in the DOM (the settings.html script may clone/move nodes asynchronously).
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
    const { eventSource, event_types, characters } = realCtx;

    // Derived patterns: start with user settings.patterns but add aliases from characters (first name, full name)
    function buildDerivedPatterns() {
        const base = (settings.patterns || DEFAULTS.patterns).map(s => (s||'').trim()).filter(Boolean);
        const extra = [];
        try {
            if (realCtx && realCtx.characters) {
                for (const id of Object.keys(realCtx.characters)) {
                    const ch = realCtx.characters[id];
                    if (!ch || !ch.name) continue;
                    const full = ch.name.trim();
                    // if full is "Tohka Yatogami", add "Tohka" and "Tohka Yatogami"
                    const parts = full.split(/\s+/).filter(Boolean);
                    if (parts.length > 1) {
                        extra.push(full);
                        extra.push(parts[0]);
                    } else {
                        extra.push(full);
                    }
                }
            }
        } catch (e) {
            // ignore
        }
        return Array.from(new Set([...base, ...extra]));
    }

    // Build initial regexes (use derived patterns)
    let derivedPatterns = buildDerivedPatterns();
    let nameRegex = buildNameRegex(derivedPatterns);
    let speakerRegex = buildSpeakerRegex(derivedPatterns);
    let attributionRegex = buildAttributionRegex(derivedPatterns);
    let actionRegex = buildActionRegex(derivedPatterns);

    // Wiring: only attach handlers if the elements exist — if they later appear, we re-run binding once
    function tryWireUI() {
        if ($("#cs-save").length) {
            $("#cs-save").off('click.cs').on("click.cs", () => {
                settings.enabled = !!$("#cs-enable").prop("checked");
                settings.patterns = $("#cs-patterns").val().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                settings.defaultCostume = $("#cs-default").val().trim();
                settings.resetTimeoutMs = parseInt($("#cs-timeout").val()||DEFAULTS.resetTimeoutMs, 10);
                if ($("#cs-narration").length) settings.narrationSwitch = !!$("#cs-narration").prop("checked");

                // rebuild derived patterns & regexes after saving patterns
                derivedPatterns = buildDerivedPatterns();
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
            // store raw combined but use stripped variant for regex tests (to avoid markdown interfering)
            perMessageBuffers.set(bufKey, combined);

            // helper to record explicit matches
            function recordExplicitIfFound(name) {
                if (name) {
                    lastExplicitPerBuf.set(bufKey, String(name).replace(/-(?:sama|san)$/i,'').trim());
                }
            }

            let matchedName = null;

            // Try regex matching on stripped text where helpful
            const combinedPlain = stripFormatting(combined);

            // --- Start of Tiered Logic ---

            // Priority 1: Check for a "Speaker:" match first (explicit). Use stripped text to be robust.
            if (speakerRegex) {
                try {
                    const speakerSearchRe = new RegExp(speakerRegex.source, 'gi');
                    let lastSpeakerMatch = null, m;
                    while ((m = speakerSearchRe.exec(combinedPlain)) !== null) lastSpeakerMatch = m;
                    if (lastSpeakerMatch) {
                        matchedName = lastSpeakerMatch[1]?.trim();
                        recordExplicitIfFound(matchedName);
                    }
                } catch (e) {
                    // ignore
                }
            }

            // Priority 2: Dialogue attribution (e.g., "..." , Name said  OR  Name said, "...")
            if (!matchedName && attributionRegex) {
                try {
                    const aRe = new RegExp(attributionRegex.source, 'gi');
                    let lastA = null; let am;
                    while ((am = aRe.exec(combinedPlain)) !== null) lastA = am;
                    if (lastA) {
                        // extract a name capture
                        for (let i = 1; i < lastA.length; i++) {
                            if (lastA[i]) {
                                matchedName = lastA[i].trim();
                                break;
                            }
                        }

                        // Pronoun resolution: if the attribution gave a pronoun like "she"/"he"/"they", try to resolve
                        if (matchedName && /^(she|he|they|it)$/i.test(matchedName)) {
                            const resolved = findLastExplicitBefore(combinedPlain, lastA.index);
                            if (resolved) {
                                matchedName = resolved;
                            } else {
                                const lastExp = lastExplicitPerBuf.get(bufKey);
                                if (lastExp) matchedName = lastExp;
                                else matchedName = null; // ambiguous pronoun, give up
                            }
                        }

                        if (matchedName) recordExplicitIfFound(matchedName);
                    }
                } catch (e) {
                    // ignore regex problems
                }
            }

            // Priority 3: Action/narration lines that start with the name (Kotori nodded...)
            if (!matchedName && actionRegex) {
                try {
                    const acRe = new RegExp(actionRegex.source, 'gi');
                    let lastAct = null, am2;
                    while ((am2 = acRe.exec(combinedPlain)) !== null) lastAct = am2;
                    if (lastAct) {
                        for (let i = 1; i < lastAct.length; i++) {
                            if (lastAct[i]) {
                                matchedName = lastAct[i].trim();
                                break;
                            }
                        }
                        if (matchedName) recordExplicitIfFound(matchedName);
                    }
                } catch (e) {
                    // ignore
                }
            }

            // Priority 4: Optional fallback - match Name + verb/possessive anywhere in narration (skip quoted regions)
            if (!matchedName && nameRegex && settings.narrationSwitch) {
                try {
                    const actionsOrPossessive = "(?:'s|held|shifted|stood|sat|nodded|smiled|laughed|leaned|stepped|walked|turned|looked|moved|approached|said|asked|replied|observed|gazed|watched|beamed|frowned|grimaced|sighed|grinned|shrugged|gestured|patted|pointed|winked|cried|shouted|called|whispered|muttered|murmured|exclaimed|yelled|tilted|lowered|raised|offered|placed|rested|crossed|uncrossed|adjusted|brushed|tapped|drummed|pulled|pushed|hugged|embraced|kissed|blushed|flinched|winced|smirked|glared|narrowed|widened|opened|closed|folded|unfolded|readjusted|touched|stroked|caressed|examined|inspected|studied|surveyed|scanned|noted|remarked|added|continued|explained|clarified|responded|countered|retorted|offered)";
                    const narrationRe = new RegExp(`${nameRegex.source}\\b\\s+${actionsOrPossessive}\\b`, 'gi');

                    let lastMatch = null, mm;
                    while ((mm = narrationRe.exec(combinedPlain)) !== null) {
                        if (isInsideQuotes(combinedPlain, mm.index)) continue; // skip if inside dialogue
                        for (let i = 1; i < mm.length; i++) {
                            if (mm[i]) {
                                lastMatch = { name: mm[i], idx: mm.index };
                                break;
                            }
                        }
                    }
                    if (lastMatch) {
                        matchedName = String(lastMatch.name).replace(/-(?:sama|san)$/i, '').trim();
                        recordExplicitIfFound(matchedName);
                    }
                } catch (e) {
                    // ignore
                }
            }

            // --- End of Tiered Logic ---

            if (matchedName) {
                issueCostumeForName(matchedName);
                scheduleResetIfIdle();

                // keep a sliding tail of buffer (so later pronoun attributions can still resolve)
                const keep = combined.slice(-BUFFER_KEEP);
                perMessageBuffers.set(bufKey, keep);
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

    console.log("SillyTavern-CostumeSwitch (context-aware, patched) loaded.");
});
