import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { executeSlashCommandsOnChatInput } from "../../../slash-commands.js";

const extensionName = "SillyTavern-CostumeSwitch";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

const DEFAULTS = {
    enabled: true,
    resetTimeoutMs: 3000,
    patterns: ["Char A", "Char B", "Char C", "Char D"],
    defaultCostume: "",
    debug: false,
    globalCooldownMs: 1200,
    perTriggerCooldownMs: 250,
    failedTriggerCooldownMs: 10000,
    maxBufferChars: 2000,
    repeatSuppressMs: 800,
    mappings: [],
    detectAttribution: true,
    detectAction: true,
    detectVocative: true,
    detectPossessive: true,
    detectGeneral: false,
};

// Helper to escape strings for regex construction
function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Parses a user-provided pattern, supporting both simple strings and /regex/
function parsePatternEntry(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return null;
    const m = trimmed.match(/^\/((?:\\.|[^\/])+)\/([gimsuy]*)$/);
    if (m) return { body: m[1], flags: (m[2] || '') };
    return { body: escapeRegex(trimmed), flags: '' };
}

// Combines regex flags from multiple patterns
function computeFlagsFromEntries(entries, requireI = true) {
    let flagsSet = new Set();
    for (const e of entries) {
        if (!e) continue;
        for (const ch of (e.flags || '')) flagsSet.add(ch);
    }
    if (requireI) flagsSet.add('i');
    const allowed = 'gimsuy';
    return Array.from(flagsSet).filter(c => allowed.includes(c)).join('');
}

// Builds the various regex patterns from the user's list
function buildNameRegex(patternList) {
    const entries = (patternList || []).map(parsePatternEntry).filter(Boolean);
    if (!entries.length) return null;
    const parts = entries.map(e => `(?:${e.body})`);
    const body = `(?:^|\\n|[\\(\\[\\-—–])(?:(${parts.join('|')}))(?:\\W|$)`;
    const flags = computeFlagsFromEntries(entries, true);
    try { return new RegExp(body, flags); } catch (e) { console.warn("buildNameRegex compile failed:", e); return null; }
}

function buildSpeakerRegex(patternList) {
    const entries = (patternList || []).map(parsePatternEntry).filter(Boolean);
    if (!entries.length) return null;
    const parts = entries.map(e => `(?:${e.body})`);
    const body = `(?:^|\\n)\\s*(${parts.join('|')})\\s*[:;,]\\s*`;
    const flags = computeFlagsFromEntries(entries, true);
    try { return new RegExp(body, flags); } catch (e) { console.warn("buildSpeakerRegex compile failed:", e); return null; }
}

function buildVocativeRegex(patternList) {
    const entries = (patternList || []).map(parsePatternEntry).filter(Boolean);
    if (!entries.length) return null;
    const parts = entries.map(e => `(?:${e.body})`);
    // IMPROVED: Now uses a lookahead to match a name followed by punctuation or end of line/quote, without consuming it.
    const body = `(?:^|\\n|\\s)(${parts.join('|')})(?=[\\s,.!?“"]|$)`;
    const flags = computeFlagsFromEntries(entries, true);
    try { return new RegExp(body, flags); } catch (e) { console.warn("buildVocativeRegex compile failed:", e); return null; }
}

function buildAttributionRegex(patternList) {
    const entries = (patternList || []).map(parsePatternEntry).filter(Boolean);
    if (!entries.length) return null;
    const names = entries.map(e => `(?:${e.body})`).join('|');
    // IMPROVED: Added more common verbs.
    const verbs = '(?:said|asked|replied|murmured|whispered|sighed|laughed|exclaimed|noted|added|answered|shouted|cried|muttered|remarked|offered|suggested|stated)';
    const patA = '(?:["\\u201C\\u201D][^"\\u201C\\u201D]{0,400}["\\u201C\\u201D])\\s*,?\\s*(' + names + ')\\s+' + verbs;
    const patB = '\\b(' + names + ')\\s+' + verbs + '\\s*[:,]?\\s*["\\u201C\\u201D]';
    const body = `(?:${patA})|(?:${patB})`;
    const flags = computeFlagsFromEntries(entries, true);
    try { return new RegExp(body, flags); } catch (e) { console.warn("buildAttributionRegex compile failed:", e); return null; }
}

function buildActionRegex(patternList) {
    const entries = (patternList || []).map(parsePatternEntry).filter(Boolean);
    if (!entries.length) return null;
    const parts = entries.map(e => `(?:${e.body})`);
    // IMPROVED: Added more common action verbs.
    const actions = '(?:nodded|leaned|smiled|laughed|stood|sat|gestured|sighed|replied|said|murmured|whispered|muttered|observed|watched|turned|glanced|held|lowered|positioned|stepped|approached|walked|looked|moved|danced|spun|tapped)';
    const body = `\\b(${parts.join('|')})(?:\\s+[A-Z][a-z]+)?\\b\\s+${actions}\\b`;
    const flags = computeFlagsFromEntries(entries, true);
    try { return new RegExp(body, flags); } catch (e) { console.warn("buildActionRegex compile failed:", e); return null; }
}

// Finds all quote pairs in a string to determine what text is dialogue
function getQuoteRanges(s) {
    const q = /["\u201C\u201D]/g;
    const pos = [];
    let m;
    while ((m = q.exec(s)) !== null) pos.push(m.index);
    const ranges = [];
    for (let i = 0; i + 1 < pos.length; i += 2) ranges.push([pos[i], pos[i + 1]]);
    return ranges;
}

// Checks if a given index is inside any of the quote ranges
function isIndexInsideQuotesRanges(ranges, idx) {
    for (const [a, b] of ranges) if (idx > a && idx < b) return true;
    return false;
}

// Finds all regex matches that are NOT inside quotation marks
function findNonQuotedMatches(combined, regex, quoteRanges) {
    if (!combined || !regex) return [];
    const flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
    const re = new RegExp(regex.source, flags);
    const results = [];
    let m;
    while ((m = re.exec(combined)) !== null) {
        const idx = m.index || 0;
        if (!isIndexInsideQuotesRanges(quoteRanges, idx)) {
            results.push({ match: m[0], groups: m.slice(1), index: idx });
        }
        if (re.lastIndex === m.index) re.lastIndex++;
    }
    return results;
}

// Context-aware match finding.
function findBestMatch(combined, regexes, settings, quoteRanges) {
    if (!combined) return null;
    let allMatches = [];
    const { speakerRegex, attributionRegex, actionRegex, vocativeRegex, nameRegex } = regexes;
    const priorities = { speaker: 5, attribution: 4, action: 3, vocative: 3, possessive: 2, name: 1, inferred: 6 };

    // Gather all possible matches from all detection methods for KNOWN characters
    if (speakerRegex) {
        findNonQuotedMatches(combined, speakerRegex, quoteRanges).forEach(m => {
            const name = m.groups?.[0]?.trim();
            if (name) allMatches.push({ name, matchKind: 'speaker', matchIndex: m.index, priority: priorities.speaker });
        });
    }
    if (settings.detectAttribution && attributionRegex) {
        findNonQuotedMatches(combined, attributionRegex, quoteRanges).forEach(m => {
            const name = m.groups?.find(g => g)?.trim();
            if (name) allMatches.push({ name, matchKind: 'attribution', matchIndex: m.index, priority: priorities.attribution });
        });
    }
    if (settings.detectAction && actionRegex) {
        findNonQuotedMatches(combined, actionRegex, quoteRanges).forEach(m => {
            const name = m.groups?.[0]?.trim();
            if (name) allMatches.push({ name, matchKind: 'action', matchIndex: m.index, priority: priorities.action });
        });
    }
    if (settings.detectVocative && vocativeRegex) {
        findNonQuotedMatches(combined, vocativeRegex, quoteRanges).forEach(m => {
            const name = m.groups?.[0]?.trim();
            if (name) allMatches.push({ name, matchKind: 'vocative', matchIndex: m.index, priority: priorities.vocative });
        });
    }
    if (settings.detectPossessive && settings.patterns && settings.patterns.length) {
        const names_poss = settings.patterns.map(s => (s || '').trim()).filter(Boolean);
        if (names_poss.length) {
            const possRe = new RegExp('\\b(' + names_poss.map(escapeRegex).join('|') + ")[’'`]s\\b", 'gi');
            findNonQuotedMatches(combined, possRe, quoteRanges).forEach(m => {
                const name = m.groups?.[0]?.trim();
                if (name) allMatches.push({ name, matchKind: 'possessive', matchIndex: m.index, priority: priorities.possessive });
            });
        }
    }
    if (settings.detectGeneral && nameRegex) {
        findNonQuotedMatches(combined, nameRegex, quoteRanges).forEach(m => {
            const name = String(m.groups?.[0] || m.match).replace(/-(?:sama|san)$/i, '').trim();
            if (name) allMatches.push({ name, matchKind: 'name', matchIndex: m.index, priority: priorities.name });
        });
    }

    // This pass looks for any character speaking, to prevent incorrect switches on mentioned names.
    const genericNamePattern = '[A-Z][a-z]+(?:\\s[A-Z][a-z]+)?';
    const genericVerbs = '(?:said|asked|replied|murmured|whispered|sighed|laughed|exclaimed|noted|added|answered|shouted|cried|muttered|remarked|offered|suggested|stated)';
    const genericAttributionRegex = new RegExp(`(?:["“][^"”]{0,400}["”])\\s*,?\\s*(${genericNamePattern})\\s+${genericVerbs}`, 'g');
    
    let vetoSpeaker = null;
    let genericMatches = [];
    let m;
    while ((m = genericAttributionRegex.exec(combined)) !== null) {
        // Ensure the found "name" isn't a common non-name capital word.
        const potentialName = m[1].trim();
        if (!/^(The|He|She|It|They)$/i.test(potentialName)) {
            genericMatches.push({ name: potentialName, index: m.index });
        }
    }

    if (genericMatches.length > 0) {
        genericMatches.sort((a, b) => b.index - a.index);
        vetoSpeaker = genericMatches[0].name;
        
        const isKnown = (settings.patterns || []).some(p => p.toLowerCase() === vetoSpeaker.toLowerCase());
        
        // If the speaker is UNKNOWN (e.g., Kannazuki), we apply a "soft veto".
        if (!isKnown) {
            debugLog(settings, `Unknown speaker '${vetoSpeaker}' detected. Vetoing low-priority matches.`);
            // Remove low-priority general and possessive matches from consideration.
            allMatches = allMatches.filter(match => match.priority > priorities.possessive);
        }
    }

    if (allMatches.length === 0) return null;

    // Standard Veto Logic for KNOWN speakers
    const speakerMatches = allMatches.filter(m => m.matchKind === 'speaker' || m.matchKind === 'attribution');
    if (speakerMatches.length > 0) {
        speakerMatches.sort((a, b) => b.matchIndex - a.matchIndex || b.priority - a.priority);
        const primarySpeaker = speakerMatches[0];
        
        const vetoedMatches = allMatches.filter(m => m.name.toLowerCase() === primarySpeaker.name.toLowerCase());
        debugLog(settings, `Primary speaker identified: '${primarySpeaker.name}'. Vetoing other character mentions.`);
        
        vetoedMatches.sort((a, b) => b.priority - a.priority || b.matchIndex - a.matchIndex);
        return vetoedMatches[0];
    }

    // Fallback for cases with no definitive speaker
    allMatches.sort((a, b) => b.priority - a.priority || b.matchIndex - a.matchIndex);
    return allMatches[0];
}

// Normalizes text for processing
function normalizeStreamText(s) {
    if (!s) return '';
    s = String(s);
    s = s.replace(/[\uFEFF\u200B\u200C\u200D]/g, '');
    s = s.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"');
    s = s.replace(/(\*\*|__|~~|`{1,3})/g, '');
    s = s.replace(/\u00A0/g, ' ');
    return s;
}

// Normalizes a name for matching against costumes
function normalizeCostumeName(n) {
    if (!n) return "";
    let s = String(n).trim();
    if (s.startsWith("/")) s = s.slice(1).trim();
    const first = s.split(/[\/\s]+/).filter(Boolean)[0] || s;
    return String(first).replace(/[-_](?:sama|san)$/i, '').trim();
}

// Global state variables
const perMessageBuffers = new Map();
const perMessageStates = new Map();
let lastIssuedCostume = null;
let lastSwitchTimestamp = 0;
const lastTriggerTimes = new Map();
const failedTriggerTimes = new Map();

// Event handlers
let _streamHandler = null;
let _genStartHandler = null;
let _genEndHandler = null;
let _msgRecvHandler = null;
let _chatChangedHandler = null;

const MAX_MESSAGE_BUFFERS = 60;
function ensureBufferLimit() {
    if (perMessageBuffers.size <= MAX_MESSAGE_BUFFERS) return;
    while (perMessageBuffers.size > MAX_MESSAGE_BUFFERS) {
        const firstKey = perMessageBuffers.keys().next().value;
        perMessageBuffers.delete(firstKey);
        perMessageStates.delete(firstKey);
    }
}

function waitForSelector(selector, timeout = 3000, interval = 120) {
    return new Promise((resolve) => {
        const start = Date.now();
        const iv = setInterval(() => {
            const el = document.querySelector(selector);
            if (el) { clearInterval(iv); resolve(true); return; }
            if (Date.now() - start > timeout) { clearInterval(iv); resolve(false); }
        }, interval);
    });
}

function debugLog(settings, ...args) {
    try {
        if (settings && settings.debug) console.debug.apply(console, ["[CostumeSwitch]"].concat(args));
    } catch (e) { /* ignore */ }
}

jQuery(async () => {
    if (typeof executeSlashCommandsOnChatInput !== 'function') {
        console.error("[CostumeSwitch] FATAL: The global 'executeSlashCommandsOnChatInput' function is not available. This extension cannot run.");
        const statusEl = document.querySelector("#cs-status");
        if (statusEl) {
            statusEl.textContent = "FATAL ERROR: See console";
            statusEl.style.color = "red";
        }
        return;
    }

    const { store, save, ctx } = getSettingsObj();
    const settings = store[extensionName];

    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);
    } catch (e) {
        console.warn("Failed to load settings.html:", e);
        $("#extensions_settings").append('<div><h3>Costume Switch</h3><div>Failed to load UI (see console)</div></div>');
    }

    const ok = await waitForSelector("#cs-save", 3000, 100);
    if (!ok) console.warn("CostumeSwitch: settings UI did not appear within timeout. Attempting to continue (UI may be unresponsive).");

    // Load settings into the UI
    $("#cs-enable").prop("checked", !!settings.enabled);
    $("#cs-patterns").val((settings.patterns || []).join("\n"));
    $("#cs-default").val(settings.defaultCostume || "");
    $("#cs-timeout").val(settings.resetTimeoutMs || DEFAULTS.resetTimeoutMs);
    $("#cs-debug").prop("checked", !!settings.debug);
    $("#cs-global-cooldown").val(settings.globalCooldownMs || DEFAULTS.globalCooldownMs);
    $("#cs-repeat-suppress").val(settings.repeatSuppressMs || DEFAULTS.repeatSuppressMs);
    $("#cs-detect-attribution").prop("checked", !!settings.detectAttribution);
    $("#cs-detect-action").prop("checked", !!settings.detectAction);
    $("#cs-detect-vocative").prop("checked", !!settings.detectVocative);
    $("#cs-detect-possessive").prop("checked", !!settings.detectPossessive);
    $("#cs-detect-general").prop("checked", !!settings.detectGeneral);

    function renderMappings() {
        const tbody = $("#cs-mappings-tbody");
        if (!tbody.length) return;
        tbody.empty();
        const arr = settings.mappings || [];
        arr.forEach((m, idx) => {
            const tr = $(`<tr data-idx="${idx}">
                <td><input class="map-name" value="${(m.name || '').replace(/"/g, '&quot;')}" /></td>
                <td><input class="map-folder" value="${(m.folder || '').replace(/"/g, '&quot;')}" /></td>
                <td><button class="map-remove">Remove</button></td>
            </tr>`);
            tbody.append(tr);
        });
    }
    settings.mappings = settings.mappings || [];
    renderMappings();
    $("#cs-status").text("Ready");

    function persistSettings() {
        if (save) save();
        if (jQuery("#cs-status").length) $("#cs-status").text(`Saved ${new Date().toLocaleTimeString()}`);
        setTimeout(() => $("#cs-status").text("Ready"), 1500);
    }

    const { eventSource, event_types } = ctx;

    let nameRegex = buildNameRegex(settings.patterns || DEFAULTS.patterns);
    let speakerRegex = buildSpeakerRegex(settings.patterns || DEFAULTS.patterns);
    let attributionRegex = buildAttributionRegex(settings.patterns || DEFAULTS.patterns);
    let actionRegex = buildActionRegex(settings.patterns || DEFAULTS.patterns);
    let vocativeRegex = buildVocativeRegex(settings.patterns || DEFAULTS.patterns);

    function tryWireUI() {
        $("#cs-save").off('click.cs').on("click.cs", () => {
            settings.enabled = !!$("#cs-enable").prop("checked");
            settings.patterns = $("#cs-patterns").val().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            settings.defaultCostume = $("#cs-default").val().trim();
            settings.resetTimeoutMs = parseInt($("#cs-timeout").val() || DEFAULTS.resetTimeoutMs, 10);
            settings.debug = !!$("#cs-debug").prop("checked");
            settings.globalCooldownMs = parseInt($("#cs-global-cooldown").val() || DEFAULTS.globalCooldownMs, 10);
            settings.repeatSuppressMs = parseInt($("#cs-repeat-suppress").val() || DEFAULTS.repeatSuppressMs, 10);
            settings.detectAttribution = !!$("#cs-detect-attribution").prop("checked");
            settings.detectAction = !!$("#cs-detect-action").prop("checked");
            settings.detectVocative = !!$("#cs-detect-vocative").prop("checked");
            settings.detectPossessive = !!$("#cs-detect-possessive").prop("checked");
            settings.detectGeneral = !!$("#cs-detect-general").prop("checked");
            const newMaps = [];
            $("#cs-mappings-tbody tr").each(function () {
                const name = $(this).find(".map-name").val().trim();
                const folder = $(this).find(".map-folder").val().trim();
                if (name && folder) newMaps.push({ name, folder });
            });
            settings.mappings = newMaps;
            let compileError = null;
            try {
                nameRegex = buildNameRegex(settings.patterns || DEFAULTS.patterns);
                speakerRegex = buildSpeakerRegex(settings.patterns || DEFAULTS.patterns);
                attributionRegex = buildAttributionRegex(settings.patterns || DEFAULTS.patterns);
                actionRegex = buildActionRegex(settings.patterns || DEFAULTS.patterns);
                vocativeRegex = buildVocativeRegex(settings.patterns || DEFAULTS.patterns);
            } catch (e) {
                compileError = String(e);
            }
            if (compileError) {
                $("#cs-error").text(`Pattern compile error: ${compileError}`).show();
            } else {
                $("#cs-error").text("").hide();
            }
            persistSettings();
        });
        $("#cs-reset").off('click.cs').on("click.cs", async () => { await manualReset(); });
        $("#cs-mapping-add").off('click.cs').on("click.cs", () => {
            settings.mappings = settings.mappings || [];
            settings.mappings.push({ name: "", folder: "" });
            renderMappings();
        });
        $("#cs-mappings-tbody").off('click.cs', '.map-remove').on('click.cs', '.map-remove', function () {
            const tr = $(this).closest('tr');
            const idx = parseInt(tr.attr('data-idx'), 10);
            if (!isNaN(idx)) {
                settings.mappings.splice(idx, 1);
                renderMappings();
            }
        });
        $(document).off('input.cs_patterns', '#cs-patterns').on('input.cs_patterns', '#cs-patterns', function () {
            const val = $(this).val();
            const arr = String(val || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            settings.patterns = arr;
            try {
                nameRegex = buildNameRegex(settings.patterns || DEFAULTS.patterns);
                speakerRegex = buildSpeakerRegex(settings.patterns || DEFAULTS.patterns);
                attributionRegex = buildAttributionRegex(settings.patterns || DEFAULTS.patterns);
                actionRegex = buildActionRegex(settings.patterns || DEFAULTS.patterns);
                vocativeRegex = buildVocativeRegex(settings.patterns || DEFAULTS.patterns);
                $("#cs-status").text('Patterns updated (live)');
                setTimeout(() => $("#cs-status").text('Ready'), 900);
            } catch (e) {
                $("#cs-error").text('Pattern compile error').show();
            }
        });
    }
    tryWireUI();

    async function manualReset() {
        const costumeArg = settings.defaultCostume?.trim() ? `\\${settings.defaultCostume.trim()}` : '\\';
        const command = `/costume ${costumeArg}`;
        debugLog(settings, "Attempting manual reset with command:", command);
        try {
            await executeSlashCommandsOnChatInput(command);
            lastIssuedCostume = costumeArg;
            if ($("#cs-status").length) $("#cs-status").text(`Reset -> ${costumeArg}`);
            setTimeout(() => $("#cs-status").text("Ready"), 1500);
        } catch (err) {
            console.error(`[CostumeSwitch] Manual reset failed for "${costumeArg}".`, err);
        }
    }

    function getMappedCostume(name) {
        if (!name) return null;
        const arr = settings.mappings || [];
        for (const m of arr) {
            if (!m || !m.name) continue;
            if (m.name.toLowerCase() === name.toLowerCase()) {
                return m.folder ? m.folder.trim() : null;
            }
        }
        return null;
    }

    async function issueCostumeForName(name, opts = {}) {
        if (!name) return;
        const now = Date.now();
        name = normalizeCostumeName(name);
        const matchKind = opts.matchKind || null;

        const currentName = normalizeCostumeName(lastIssuedCostume || settings.defaultCostume || (ctx?.characters?.[ctx.characterId]?.name) || '');
        if (currentName && currentName.toLowerCase() === name.toLowerCase()) {
            debugLog(settings, "already using costume for", name, "- skipping switch.");
            return;
        }
        if (now - lastSwitchTimestamp < (settings.globalCooldownMs || DEFAULTS.globalCooldownMs)) {
            debugLog(settings, "global cooldown active, skipping switch to", name);
            return;
        }
        let argFolder = getMappedCostume(name) || name;
        const lastSuccess = lastTriggerTimes.get(argFolder) || 0;
        if (now - lastSuccess < (settings.perTriggerCooldownMs || DEFAULTS.perTriggerCooldownMs)) {
            debugLog(settings, "per-trigger cooldown active, skipping", argFolder);
            return;
        }
        const lastFailed = failedTriggerTimes.get(argFolder) || 0;
        if (now - lastFailed < (settings.failedTriggerCooldownMs || DEFAULTS.failedTriggerCooldownMs)) {
            debugLog(settings, "failed-trigger cooldown active, skipping", argFolder);
            return;
        }

        const command = `/costume \\${argFolder}`;
        debugLog(settings, "executing command:", command, "kind:", matchKind);
        try {
            await executeSlashCommandsOnChatInput(command);
            lastTriggerTimes.set(argFolder, now);
            lastIssuedCostume = argFolder;
            lastSwitchTimestamp = now;
            if ($("#cs-status").length) $("#cs-status").text(`Switched -> ${argFolder}`);
            setTimeout(() => $("#cs-status").text("Ready"), 1000);
        } catch (err) {
            failedTriggerTimes.set(argFolder, now);
            console.error(`[CostumeSwitch] Failed to execute /costume command for "${argFolder}".`, err);
        }
    }

    const streamEventName = event_types?.STREAM_TOKEN_RECEIVED || event_types?.SMOOTH_STREAM_TOKEN_RECEIVED || 'stream_token_received';

    _genStartHandler = (messageId) => {
        const bufKey = messageId != null ? `m${messageId}` : 'live';
        debugLog(settings, `Generation started for ${bufKey}, resetting state.`);
        perMessageStates.set(bufKey, {
            lastAcceptedName: null,
            lastAcceptedTs: 0,
            lastSpeaker: null,
            lastAddressed: null,
            lastInferredDialogue: false,
        });
        perMessageBuffers.delete(bufKey);
    };

    _streamHandler = (...args) => {
        try {
            if (!settings.enabled) return;
            let tokenText = "";
            let messageId = null;
            if (typeof args[0] === 'number') { messageId = args[0]; tokenText = String(args[1] ?? ""); } else if (typeof args[0] === 'object') { tokenText = String(args[0].token ?? args[0].text ?? ""); messageId = args[0].messageId ?? args[1] ?? null; } else { tokenText = String(args.join(' ') || ""); }
            if (!tokenText) return;

            const bufKey = messageId != null ? `m${messageId}` : 'live';
            if (!perMessageStates.has(bufKey)) { _genStartHandler(messageId); }
            const state = perMessageStates.get(bufKey);

            const sceneChangeRegex = /^(?:\*\*|--|##|__|\*--).*(?:\*\*|--|##|__|\*--)$/i;
            if (sceneChangeRegex.test(tokenText.trim())) {
                debugLog(settings, `Scene change detected. Resetting context for: ${bufKey}`);
                _genStartHandler(messageId);
                return;
            }

            const prev = perMessageBuffers.get(bufKey) || "";
            const normalizedToken = normalizeStreamText(tokenText);
            const combined = (prev + normalizedToken).slice(-(settings.maxBufferChars || DEFAULTS.maxBufferChars));
            perMessageBuffers.set(bufKey, combined);
            ensureBufferLimit();

            const isNewDialogue = /^\s*["\u201C]/.test(normalizedToken);
            if (isNewDialogue && state.lastAddressed && !state.lastInferredDialogue) {
                const inferredSpeaker = state.lastAddressed;
                debugLog(settings, `Inferred speaker from unattributed dialogue: ${inferredSpeaker}`);
                issueCostumeForName(inferredSpeaker, { matchKind: 'inferred' });
                state.lastSpeaker = inferredSpeaker;
                state.lastAddressed = null;
                state.lastInferredDialogue = true;
                perMessageStates.set(bufKey, state);
                return;
            }

            const quoteRanges = getQuoteRanges(combined);
            const bestMatch = findBestMatch(combined, { speakerRegex, attributionRegex, actionRegex, vocativeRegex, nameRegex }, settings, quoteRanges);
            
            if (bestMatch) {
                const { name: matchedName, matchKind } = bestMatch;
                const now = Date.now();
                
                if (matchKind === 'speaker' || matchKind === 'attribution' || matchKind === 'action') {
                    state.lastSpeaker = matchedName;
                    state.lastAddressed = null;
                    state.lastInferredDialogue = false;
                }
                if (matchKind === 'vocative') {
                    state.lastAddressed = matchedName;
                }

                const suppressMs = Number(settings.repeatSuppressMs || DEFAULTS.repeatSuppressMs);
                if (state.lastAcceptedName && state.lastAcceptedName.toLowerCase() === matchedName.toLowerCase() && (now - state.lastAcceptedTs < suppressMs)) {
                    debugLog(settings, 'Suppressing repeat match for same name (flicker guard)', { matchedName });
                    return;
                }

                state.lastAcceptedName = matchedName;
                state.lastAcceptedTs = now;
                perMessageStates.set(bufKey, state);
                issueCostumeForName(matchedName, { matchKind, bufKey });
            }
        } catch (err) { console.error("CostumeSwitch stream handler error:", err); }
    };

    _genEndHandler = (messageId) => {
        if (messageId != null) {
            perMessageBuffers.delete(`m${messageId}`);
            perMessageStates.delete(`m${messageId}`);
        }
    };
    _msgRecvHandler = (messageId) => { if (messageId != null) { perMessageBuffers.delete(`m${messageId}`); perMessageStates.delete(`m${messageId}`); } };
    _chatChangedHandler = () => { perMessageBuffers.clear(); perMessageStates.clear(); lastIssuedCostume = null; lastTriggerTimes.clear(); failedTriggerTimes.clear(); };

    function unload() {
        try {
            if (eventSource && _streamHandler) eventSource.off?.(streamEventName, _streamHandler);
            if (eventSource && _genStartHandler) eventSource.off?.(event_types.GENERATION_STARTED, _genStartHandler);
            if (eventSource && _genEndHandler) eventSource.off?.(event_types.GENERATION_ENDED, _genEndHandler);
            if (eventSource && _msgRecvHandler) eventSource.off?.(event_types.MESSAGE_RECEIVED, _msgRecvHandler);
            if (eventSource && _chatChangedHandler) eventSource.off?.(event_types.CHAT_CHANGED, _chatChangedHandler);
        } catch (e) { /* ignore */ }
        perMessageBuffers.clear();
        perMessageStates.clear();
        lastIssuedCostume = null;
        lastTriggerTimes.clear();
        failedTriggerTimes.clear();
    }

    try { unload(); } catch (e) {}

    try {
        eventSource.on(streamEventName, _streamHandler);
        eventSource.on(event_types.GENERATION_STARTED, _genStartHandler);
        eventSource.on(event_types.GENERATION_ENDED, _genEndHandler);
        eventSource.on(event_types.MESSAGE_RECEIVED, _msgRecvHandler);
        eventSource.on(event_types.CHAT_CHANGED, _chatChangedHandler);
    } catch (e) {
        console.error("CostumeSwitch: failed to attach event handlers:", e);
    }

    try { window[`__${extensionName}_unload`] = unload; } catch (e) {}

    console.log("SillyTavern-CostumeSwitch (v2 Logic) loaded successfully.");
});

function getSettingsObj() {
    const ctx = typeof getContext === 'function' ? getContext() : (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null);
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
