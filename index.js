import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, event_types, eventSource } from "../../../../script.js";
import { executeSlashCommandsOnChatInput, registerSlashCommand } from "../../../slash-commands.js";

const extensionName = "SillyTavern-CostumeSwitch";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const logPrefix = "[CostumeSwitch]";

// ======================================================================
// DEFAULT SETTINGS
// ======================================================================
const PROFILE_DEFAULTS = {
    patterns: [],
    ignorePatterns: [],
    vetoPatterns: ["OOC:", "(OOC)"],
    defaultCostume: "",
    debug: false,
    globalCooldownMs: 1200,
    perTriggerCooldownMs: 250,
    failedTriggerCooldownMs: 10000,
    maxBufferChars: 3000,
    repeatSuppressMs: 800,
    tokenProcessThreshold: 60,
    mappings: [],
    detectAttribution: true,
    detectAction: true,
    detectVocative: true,
    detectPossessive: true,
    detectPronoun: true,
    detectGeneral: false,
    attributionVerbs: ["acknowledged", "added", "admitted", "advised", "affirmed", "agreed", "announced", "answered", "argued", "asked", "barked", "began", "bellowed", "blurted", "boasted", "bragged", "called", "chirped", "commanded", "commented", "complained", "conceded", "concluded", "confessed", "confirmed", "continued", "countered", "cried", "croaked", "crowed", "declared", "decreed", "demanded", "denied", "drawled", "echoed", "emphasized", "enquired", "enthused", "estimated", "exclaimed", "explained", "gasped", "insisted", "instructed", "interjected", "interrupted", "joked", "lamented", "lied", "maintained", "moaned", "mumbled", "murmured", "mused", "muttered", "nagged", "nodded", "noted", "objected", "offered", "ordered", "perked up", "pleaded", "prayed", "predicted", "proclaimed", "promised", "proposed", "protested", "queried", "questioned", "quipped", "rambled", "reasoned", "reassured", "recited", "rejoined", "remarked", "repeated", "replied", "responded", "retorted", "roared", "said", "scolded", "scoffed", "screamed", "shouted", "sighed", "snapped", "snarled", "spoke", "stammered", "stated", "stuttered", "suggested", "surmised", "tapped", "threatened", "turned", "urged", "vowed", "wailed", "warned", "whimpered", "whispered", "wondered", "yelled"],
    actionVerbs: ["adjust", "adjusted", "appear", "appeared", "approach", "approached", "arrive", "arrived", "blink", "blinked", "bow", "bowed", "charge", "charged", "chase", "chased", "climb", "climbed", "collapse", "collapsed", "crawl", "crawled", "crept", "crouch", "crouched", "dance", "danced", "dart", "darted", "dash", "dashed", "depart", "departed", "dive", "dived", "dodge", "dodged", "drag", "dragged", "drift", "drifted", "drop", "dropped", "emerge", "emerged", "enter", "entered", "exit", "exited", "fall", "fell", "flee", "fled", "flinch", "flinched", "float", "floated", "fly", "flew", "follow", "followed", "freeze", "froze", "frown", "frowned", "gesture", "gestured", "giggle", "giggled", "glance", "glanced", "grab", "grabbed", "grasp", "grasped", "grin", "grinned", "groan", "groaned", "growl", "growled", "grumble", "grumbled", "grunt", "grunted", "hold", "held", "hit", "hop", "hopped", "hurry", "hurried", "jerk", "jerked", "jog", "jogged", "jump", "jumped", "kneel", "knelt", "laugh", "laughed", "lean", "leaned", "leap", "leapt", "left", "limp", "limped", "look", "looked", "lower", "lowered", "lunge", "lunged", "march", "marched", "motion", "motioned", "move", "moved", "nod", "nodded", "observe", "observed", "pace", "paced", "pause", "paused", "point", "pointed", "pop", "popped", "position", "positioned", "pounce", "pounced", "push", "pushed", "race", "raced", "raise", "raised", "reach", "reached", "retreat", "retreated", "rise", "rose", "run", "ran", "rush", "rushed", "sit", "sat", "scramble", "scrambled", "set", "shift", "shifted", "shake", "shook", "shrug", "shrugged", "shudder", "shuddered", "sigh", "sighed", "sip", "sipped", "slip", "slipped", "slump", "slumped", "smile", "smiled", "snort", "snorted", "spin", "spun", "sprint", "sprinted", "stagger", "staggered", "stare", "stared", "step", "stepped", "stand", "stood", "straighten", "straightened", "stumble", "stumbled", "swagger", "swaggered", "swallow", "swallowed", "swap", "swapped", "swing", "swung", "tap", "tapped", "throw", "threw", "tilt", "tilted", "tiptoe", "tiptoed", "take", "took", "toss", "tossed", "trudge", "trudged", "turn", "turned", "twist", "twisted", "vanish", "vanished", "wake", "woke", "walk", "walked", "wander", "wandered", "watch", "watched", "wave", "waved", "wince", "winced", "withdraw", "withdrew"],
    detectionBias: 0,
    enableSceneRoster: true,
    sceneRosterTTL: 5,
};

const DEFAULTS = {
    enabled: true,
    profiles: {
        'Default': structuredClone(PROFILE_DEFAULTS),
    },
    activeProfile: 'Default',
    focusLock: { character: null },
};

// ======================================================================
// GLOBAL STATE
// ======================================================================
const state = {
    lastIssuedCostume: null,
    lastSwitchTimestamp: 0,
    lastTriggerTimes: new Map(),
    failedTriggerTimes: new Map(),
    perMessageBuffers: new Map(),
    perMessageStates: new Map(),
    eventHandlers: {},
    compiledRegexes: {},
};

// ======================================================================
// REGEX & DETECTION LOGIC
// ======================================================================
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function parsePatternEntry(raw) {
    const t = String(raw || '').trim();
    if (!t) return null;
    const m = t.match(/^\/((?:\\.|[^\/])+)\/([gimsuy]*)$/);
    return m ? { body: m[1], flags: m[2] || '', raw: t } : { body: escapeRegex(t), flags: '', raw: t };
}
function computeFlags(entries, requireI = true) {
    const flags = new Set(requireI ? ['i'] : []);
    for (const e of entries) {
        if (!e) continue;
        for (const c of (e.flags || '')) flags.add(c);
    }
    return Array.from(flags).filter(c => 'gimsuy'.includes(c)).join('');
}
function buildRegex(patternList, template) {
    const entries = (patternList || []).map(parsePatternEntry).filter(Boolean);
    if (!entries.length) return null;
    const parts = entries.map(e => `(?:${e.body})`);
    const combinedBody = parts.join('|');
    const finalBody = template.replace('{{PATTERNS}}', combinedBody);
    const finalFlags = computeFlags(entries, true);
    try {
        return new RegExp(finalBody, finalFlags);
    } catch (e) {
        console.warn(`${logPrefix} Regex compilation failed for template: ${template}`, e);
        return null;
    }
}
function buildGenericRegex(patternList) {
    if (!patternList || patternList.length === 0) return null;
    const body = `(?:${patternList.map(p => parsePatternEntry(p)?.body).filter(Boolean).join('|')})`;
    return new RegExp(body, computeFlags(patternList.map(parsePatternEntry)));
}

function getQuoteRanges(s) {
    const ranges = [];
    const re = /"|\u201C|\u201D/g;
    let match;
    const starts = [];
    while ((match = re.exec(s)) !== null) {
        starts.push(match.index);
    }
    for (let i = 0; i < starts.length - 1; i += 2) {
        ranges.push([starts[i], starts[i + 1]]);
    }
    return ranges;
}
function isIndexInsideQuotes(idx, quoteRanges) {
    for (const [start, end] of quoteRanges) {
        if (idx > start && idx < end) return true;
    }
    return false;
}
function findMatches(text, regex, quoteRanges, searchInsideQuotes = false) {
    if (!text || !regex) return [];
    const results = [];
    const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    let match;
    while ((match = re.exec(text)) !== null) {
        if (searchInsideQuotes || !isIndexInsideQuotes(match.index, quoteRanges)) {
            results.push({ match: match[0], groups: match.slice(1), index: match.index });
        }
    }
    return results;
}

function findAllMatches(combined) {
    const allMatches = [];
    const profile = getActiveProfile();
    const { compiledRegexes } = state;
    if (!profile || !combined) return allMatches;

    const quoteRanges = getQuoteRanges(combined);
    const priorities = { speaker: 5, attribution: 4, action: 3, pronoun: 2, vocative: 2, possessive: 1, name: 0 };

    if (compiledRegexes.speakerRegex) {
        findMatches(combined, compiledRegexes.speakerRegex, quoteRanges).forEach(m => {
            const name = m.groups?.[0]?.trim();
            if (name) allMatches.push({ name, matchKind: "speaker", matchIndex: m.index, priority: priorities.speaker });
        });
    }
    if (profile.detectAttribution && compiledRegexes.attributionRegex) {
        findMatches(combined, compiledRegexes.attributionRegex, quoteRanges).forEach(m => {
            const name = m.groups?.find(g => g)?.trim();
            if (name) allMatches.push({ name, matchKind: "attribution", matchIndex: m.index, priority: priorities.attribution });
        });
    }
    if (profile.detectAction && compiledRegexes.actionRegex) {
        findMatches(combined, compiledRegexes.actionRegex, quoteRanges).forEach(m => {
            const name = m.groups?.find(g => g)?.trim();
            if (name) allMatches.push({ name, matchKind: "action", matchIndex: m.index, priority: priorities.action });
        });
    }
    if (profile.detectPronoun && state.perMessageStates.size > 0) {
        const msgState = Array.from(state.perMessageStates.values()).pop(); // Get latest state
        if (msgState && msgState.lastSubject && compiledRegexes.pronounRegex) {
            findMatches(combined, compiledRegexes.pronounRegex, quoteRanges).forEach(m => {
                allMatches.push({ name: msgState.lastSubject, matchKind: "pronoun", matchIndex: m.index, priority: priorities.pronoun });
            });
        }
    }
    if (profile.detectVocative && compiledRegexes.vocativeRegex) {
        findMatches(combined, compiledRegexes.vocativeRegex, quoteRanges, true).forEach(m => {
            const name = m.groups?.[0]?.trim();
            if (name) allMatches.push({ name, matchKind: "vocative", matchIndex: m.index, priority: priorities.vocative });
        });
    }
    if (profile.detectPossessive && compiledRegexes.possessiveRegex) {
        findMatches(combined, compiledRegexes.possessiveRegex, quoteRanges).forEach(m => {
            const name = m.groups?.[0]?.trim();
            if (name) allMatches.push({ name, matchKind: "possessive", matchIndex: m.index, priority: priorities.possessive });
        });
    }
    if (profile.detectGeneral && compiledRegexes.nameRegex) {
        findMatches(combined, compiledRegexes.nameRegex, quoteRanges).forEach(m => {
            const name = String(m.groups?.[0] || m.match).replace(/-(?:sama|san)$/i, "").trim();
            if (name) allMatches.push({ name, matchKind: "name", matchIndex: m.index, priority: priorities.name });
        });
    }
    return allMatches;
}

function findBestMatch(combined) {
    const profile = getActiveProfile();
    const allMatches = findAllMatches(combined);
    if (allMatches.length === 0) return null;

    if (profile.enableSceneRoster) {
        const msgState = Array.from(state.perMessageStates.values()).pop();
        if (msgState && msgState.sceneRoster.size > 0) {
            const rosterMatches = allMatches.filter(m => msgState.sceneRoster.has(m.name.toLowerCase()));
            if (rosterMatches.length > 0) {
                // Roster is active, only consider matches from the roster
                return getWinner(rosterMatches, profile.detectionBias);
            }
        }
    }
    
    return getWinner(allMatches, profile.detectionBias);
}

function getWinner(matches, bias = 0) {
    const scoredMatches = matches.map(match => {
        const isActive = match.priority >= 3; // speaker, attribution, action
        let score = match.matchIndex + (isActive ? bias : 0);
        return { ...match, score };
    });
    scoredMatches.sort((a, b) => b.score - a.score);
    return scoredMatches[0];
}


// ======================================================================
// UTILITY & HELPER FUNCTIONS
// ======================================================================
function normalizeStreamText(s) { return s ? String(s).replace(/[\uFEFF\u200B\u200C\u200D]/g, "").replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"').replace(/(\*\*|__|~~|`{1,3})/g, "").replace(/\u00A0/g, " ") : ""; }
function normalizeCostumeName(n) { if (!n) return ""; let s = String(n).trim(); if (s.startsWith("/")) { s = s.slice(1).trim(); } const first = s.split(/[\/\s]+/).filter(Boolean)[0] || s; return String(first).replace(/[-_](?:sama|san)$/i, "").trim(); }
function getSettings() { return extension_settings[extensionName]; }
function getActiveProfile() { const settings = getSettings(); return settings?.profiles?.[settings.activeProfile]; }
function debugLog(...args) { try { if (getActiveProfile()?.debug) console.debug(logPrefix, ...args); } catch (e) { } }

function showStatus(message, type = 'info', duration = 3000) {
    const statusEl = $("#cs-status");
    statusEl.removeClass('cs-status-message cs-error-message').addClass(type === 'error' ? 'cs-error-message' : 'cs-status-message');
    statusEl.html(message).fadeIn();
    setTimeout(() => { statusEl.fadeOut(400, () => statusEl.html("Ready").fadeIn().removeClass('cs-error-message')); }, duration);
}

// ======================================================================
// CORE LOGIC
// ======================================================================
function recompileRegexes() {
    try {
        const profile = getActiveProfile();
        if (!profile) return;
        const lowerIgnored = (profile.ignorePatterns || []).map(p => String(p).trim().toLowerCase());
        const effectivePatterns = (profile.patterns || []).filter(p => !lowerIgnored.includes(String(p).trim().toLowerCase()));

        state.compiledRegexes = {
            speakerRegex: buildRegex(effectivePatterns, '^(?:{{PATTERNS}}):'),
            attributionRegex: buildRegex(effectivePatterns, `(?:,\\s*|["”])\\s*({{PATTERNS}})\\s+(?:${profile.attributionVerbs.join('|')})`),
            actionRegex: buildRegex(effectivePatterns, `^({{PATTERNS}})(?:'s)?\\s+(?:\\w+\\s+){0,3}?(?:${profile.actionVerbs.join('|')})`),
            pronounRegex: new RegExp(`^(he|she|they)(?:'s)?\\s+(?:\\w+\\s+){0,3}?(?:${profile.actionVerbs.join('|')})`, 'i'),
            vocativeRegex: buildRegex(effectivePatterns, `["“'\\s]({{PATTERNS}})[,.!?]`),
            possessiveRegex: buildRegex(effectivePatterns, `\\b({{PATTERNS}})['’]s\\b`),
            nameRegex: buildRegex(effectivePatterns, `\\b({{PATTERNS}})\\b`),
            vetoRegex: buildGenericRegex(profile.vetoPatterns),
        };
        $("#cs-error").text("").hide();
    } catch (e) {
        $("#cs-error").text(`Pattern compile error: ${String(e)}`).show();
        showStatus(`Pattern compile error: ${String(e)}`, 'error', 5000);
    }
}

async function issueCostumeForName(name, opts = {}) {
    const profile = getActiveProfile();
    const settings = getSettings();
    if (!name || !profile) return;
    const now = Date.now();
    name = normalizeCostumeName(name);

    const currentName = normalizeCostumeName(state.lastIssuedCostume || "");
    if (!opts.isLock && currentName.toLowerCase() === name.toLowerCase()) {
        debugLog("Already using costume for", name, "- skipping.");
        return;
    }

    if (!opts.isLock && (now - state.lastSwitchTimestamp < profile.globalCooldownMs)) {
        debugLog("Global cooldown active, skipping switch to", name);
        return;
    }
    
    let argFolder = (profile.mappings.find(m => m.name.toLowerCase() === name.toLowerCase())?.folder) || name;

    if (!opts.isLock) {
        const lastSuccess = state.lastTriggerTimes.get(argFolder) || 0;
        if (now - lastSuccess < profile.perTriggerCooldownMs) {
            debugLog("Per-trigger cooldown active for", argFolder);
            return;
        }
        const lastFailed = state.failedTriggerTimes.get(argFolder) || 0;
        if (now - lastFailed < profile.failedTriggerCooldownMs) {
            debugLog("Failed-trigger cooldown active for", argFolder);
            return;
        }
    }

    const command = `/costume \\${argFolder}`;
    debugLog("Executing command:", command, "kind:", opts.matchKind || 'N/A');
    try {
        await executeSlashCommandsOnChatInput(command);
        state.lastTriggerTimes.set(argFolder, now);
        state.lastIssuedCostume = argFolder;
        state.lastSwitchTimestamp = now;
        showStatus(`Switched -> <b>${argFolder}</b>`, 'success');
    } catch (err) {
        state.failedTriggerTimes.set(argFolder, now);
        showStatus(`Failed to switch to costume "<b>${argFolder}</b>". Check console (F12).`, 'error');
        console.error(`${logPrefix} Failed to execute /costume command for "${argFolder}".`, err);
    }
}

// ======================================================================
// UI MANAGEMENT
// ======================================================================
const uiMapping = {
    patterns: { selector: '#cs-patterns', type: 'textarea' },
    ignorePatterns: { selector: '#cs-ignore-patterns', type: 'textarea' },
    vetoPatterns: { selector: '#cs-veto-patterns', type: 'textarea' },
    defaultCostume: { selector: '#cs-default', type: 'text' },
    debug: { selector: '#cs-debug', type: 'checkbox' },
    globalCooldownMs: { selector: '#cs-global-cooldown', type: 'number' },
    repeatSuppressMs: { selector: '#cs-repeat-suppress', type: 'number' },
    tokenProcessThreshold: { selector: '#cs-token-process-threshold', type: 'number' },
    detectionBias: { selector: '#cs-detection-bias', type: 'range' },
    detectAttribution: { selector: '#cs-detect-attribution', type: 'checkbox' },
    detectAction: { selector: '#cs-detect-action', type: 'checkbox' },
    detectVocative: { selector: '#cs-detect-vocative', type: 'checkbox' },
    detectPossessive: { selector: '#cs-detect-possessive', type: 'checkbox' },
    detectPronoun: { selector: '#cs-detect-pronoun', type: 'checkbox' },
    detectGeneral: { selector: '#cs-detect-general', type: 'checkbox' },
    attributionVerbs: { selector: '#cs-attribution-verbs', type: 'csvTextarea' },
    actionVerbs: { selector: '#cs-action-verbs', type: 'csvTextarea' },
    enableSceneRoster: { selector: '#cs-scene-roster-enable', type: 'checkbox' },
    sceneRosterTTL: { selector: '#cs-scene-roster-ttl', type: 'number' },
};

function populateProfileDropdown() {
    const select = $("#cs-profile-select");
    const settings = getSettings();
    select.empty();
    Object.keys(settings.profiles).forEach(name => {
        select.append($('<option>', { value: name, text: name }));
    });
    select.val(settings.activeProfile);
}

function updateFocusLockUI() {
    const profile = getActiveProfile();
    const settings = getSettings();
    const lockSelect = $("#cs-focus-lock-select");
    const lockToggle = $("#cs-focus-lock-toggle");
    lockSelect.empty().append($('<option>', { value: '', text: 'None' }));
    (profile.patterns || []).forEach(name => {
        const cleanName = normalizeCostumeName(name);
        if (cleanName) lockSelect.append($('<option>', { value: cleanName, text: cleanName }));
    });
    if (settings.focusLock.character) {
        lockSelect.val(settings.focusLock.character).prop("disabled", true);
        lockToggle.text("Unlock");
    } else {
        lockSelect.val('').prop("disabled", false);
        lockToggle.text("Lock");
    }
}

function loadProfile(profileName) {
    const settings = getSettings();
    if (!settings.profiles[profileName]) {
        profileName = Object.keys(settings.profiles)[0];
    }
    settings.activeProfile = profileName;
    const profile = getActiveProfile();
    $("#cs-profile-name").val(profileName);
    for (const key in uiMapping) {
        const { selector, type } = uiMapping[key];
        const value = profile[key] ?? PROFILE_DEFAULTS[key];
        switch (type) {
            case 'checkbox': $(selector).prop('checked', !!value); break;
            case 'textarea': $(selector).val((value || []).join('\n')); break;
            case 'csvTextarea': $(selector).val((value || []).join(', ')); break;
            default: $(selector).val(value); break;
        }
    }
    $("#cs-detection-bias-value").text(profile.detectionBias || 0);
    renderMappings(profile);
    recompileRegexes();
    updateFocusLockUI();
}

function saveCurrentProfileData() {
    const profileData = {};
    for (const key in uiMapping) {
        const { selector, type } = uiMapping[key];
        let value;
        switch (type) {
            case 'checkbox': value = $(selector).prop('checked'); break;
            case 'textarea': value = $(selector).val().split(/\r?\n/).map(s => s.trim()).filter(Boolean); break;
            case 'csvTextarea': value = $(selector).val().split(',').map(s => s.trim()).filter(Boolean); break;
            case 'number':
            case 'range': value = parseInt($(selector).val(), 10) || 0; break;
            default: value = $(selector).val().trim(); break;
        }
        profileData[key] = value;
    }
    profileData.mappings = [];
    $("#cs-mappings-tbody tr").each(function () {
        const name = $(this).find(".map-name").val().trim();
        const folder = $(this).find(".map-folder").val().trim();
        if (name && folder) profileData.mappings.push({ name, folder });
    });
    return profileData;
}

function renderMappings(profile) {
    const tbody = $("#cs-mappings-tbody");
    tbody.empty();
    (profile.mappings || []).forEach((m, idx) => {
        tbody.append($("<tr>").attr("data-idx", idx)
            .append($("<td>").append($("<input>").addClass("map-name text_pole").val(m.name || "")))
            .append($("<td>").append($("<input>").addClass("map-folder text_pole").val(m.folder || "")))
            .append($("<td>").append($("<button>").addClass("map-remove menu_button interactable").html('<i class="fa-solid fa-trash-can"></i>')))
        );
    });
}

function persistSettings(message) {
    saveSettingsDebounced();
    if(message) showStatus(message, 'success');
}

function testRegexPattern() {
    $("#cs-test-veto-result").text('N/A').css('color', 'var(--text-color-soft)');
    const text = $("#cs-regex-test-input").val();
    if (!text) {
        $("#cs-test-all-detections, #cs-test-winner-list").html('<li class="cs-tester-list-placeholder">Enter text to test.</li>');
        return;
    }

    const tempState = { perMessageStates: new Map([[ 'test', { lastSubject: null, sceneRoster: new Set() } ]]) };
    const originalState = { ...state };
    Object.assign(state, tempState);
    
    const tempProfile = saveCurrentProfileData();
    const originalProfile = getActiveProfile();
    getSettings().profiles["__temp_test"] = tempProfile;
    getSettings().activeProfile = "__temp_test";
    
    recompileRegexes();

    const combined = normalizeStreamText(text);
    if (state.compiledRegexes.vetoRegex && state.compiledRegexes.vetoRegex.test(combined)) {
        const vetoMatch = combined.match(state.compiledRegexes.vetoRegex)[0];
        $("#cs-test-veto-result").html(`Vetoed by: <b style="color: var(--red);">${vetoMatch}</b>`);
        $("#cs-test-all-detections, #cs-test-winner-list").html('<li class="cs-tester-list-placeholder">Message vetoed.</li>');
    } else {
        $("#cs-test-veto-result").text('No veto phrases matched.').css('color', 'var(--green)');
        const allMatches = findAllMatches(combined).sort((a, b) => a.matchIndex - b.matchIndex);
        
        const allDetectionsList = $("#cs-test-all-detections").empty();
        if (allMatches.length > 0) {
            allMatches.forEach(m => allDetectionsList.append(`<li><b>${m.name}</b> <small>(${m.matchKind} @ ${m.matchIndex}, p: ${m.priority})</small></li>`));
        } else {
            allDetectionsList.html('<li class="cs-tester-list-placeholder">No detections found.</li>');
        }

        const winnerList = $("#cs-test-winner-list").empty();
        const winners = [];
        let lastWinnerName = null;
        for (let i = 1; i <= combined.length; i++) {
            const buffer = combined.substring(0, i);
            const bestMatch = findBestMatch(buffer);
            if (bestMatch && bestMatch.name !== lastWinnerName) {
                const existingWinner = winners.find(w => w.name === bestMatch.name);
                if (existingWinner) {
                    existingWinner.count = (existingWinner.count || 1) + 1;
                    existingWinner.score = Math.round(bestMatch.score);
                } else {
                    winners.push({ ...bestMatch, score: Math.round(bestMatch.score), count: 1 });
                }
                lastWinnerName = bestMatch.name;
            }
        }

        if (winners.length > 0) {
            winners.forEach(m => winnerList.append(`<li><b>${m.name}</b> <small>(${m.count > 1 ? m.count + 'x, ' : ''}last as ${m.matchKind} @ ${m.matchIndex}, s: ${m.score})</small></li>`));
        } else {
            winnerList.html('<li class="cs-tester-list-placeholder">No winning match.</li>');
        }
    }
    
    Object.assign(state, originalState);
    delete getSettings().profiles["__temp_test"];
    getSettings().activeProfile = Object.keys(getSettings().profiles).find(p => p !== '__temp_test');
    loadProfile(getSettings().activeProfile);
    recompileRegexes();
}

function wireUI() {
    const settings = getSettings();
    $(document).on('change', '#cs-enable', function() { settings.enabled = $(this).prop("checked"); persistSettings("Extension " + (settings.enabled ? "Enabled" : "Disabled")); });
    $(document).on('click', '#cs-save', () => { 
        const profile = getActiveProfile();
        if(profile) {
            Object.assign(profile, saveCurrentProfileData());
            recompileRegexes(); 
            updateFocusLockUI();
            persistSettings("Profile Saved");
        }
    });
    $(document).on('change', '#cs-profile-select', function() { loadProfile($(this).val()); });
    $(document).on('click', '#cs-profile-save', () => {
        const newName = $("#cs-profile-name").val().trim(); if (!newName) return;
        const oldName = settings.activeProfile;
        if (newName !== oldName && settings.profiles[newName]) { showStatus("A profile with that name already exists.", 'error'); return; }
        const profileData = saveCurrentProfileData();
        if (newName !== oldName) {
             settings.profiles[newName] = profileData;
             settings.activeProfile = newName;
             delete settings.profiles[oldName];
        } else {
            Object.assign(getActiveProfile(), profileData);
        }
        populateProfileDropdown();
        persistSettings(`Profile saved as "${newName}"`);
    });
    $(document).on('click', '#cs-profile-delete', () => {
        if (Object.keys(settings.profiles).length <= 1) { showStatus("Cannot delete the last profile.", 'error'); return; }
        const profileNameToDelete = settings.activeProfile;
        if (confirm(`Are you sure you want to delete the profile "${profileNameToDelete}"?`)) {
            delete settings.profiles[profileNameToDelete];
            settings.activeProfile = Object.keys(settings.profiles)[0];
            populateProfileDropdown(); loadProfile(settings.activeProfile);
            persistSettings(`Deleted profile "${profileNameToDelete}".`);
        }
    });
    $(document).on('click', '#cs-profile-export', () => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify({name: settings.activeProfile, data: getActiveProfile()}, null, 2));
        const dl = document.createElement('a');
        dl.setAttribute("href", dataStr);
        dl.setAttribute("download", `${settings.activeProfile}_costume_profile.json`);
        document.body.appendChild(dl);
        dl.click();
        dl.remove();
        showStatus("Profile exported.", 'info');
    });
    $(document).on('click', '#cs-profile-import', () => { $('#cs-profile-file-input').click(); });
    $(document).on('change', '#cs-profile-file-input', function(event) {
        const file = event.target.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const content = JSON.parse(e.target.result);
                if (!content.name || !content.data) throw new Error("Invalid profile format.");
                let profileName = content.name;
                if (settings.profiles[profileName]) profileName = `${profileName} (Imported) ${Date.now()}`;
                settings.profiles[profileName] = Object.assign({}, structuredClone(PROFILE_DEFAULTS), content.data);
                settings.activeProfile = profileName;
                populateProfileDropdown(); loadProfile(profileName);
                persistSettings(`Imported profile as "${profileName}".`);
            } catch (err) { showStatus(`Import failed: ${err.message}`, 'error'); }
        };
        reader.readAsText(file);
        $(this).val('');
    });
    $(document).on('click', '#cs-focus-lock-toggle', async () => {
        if (settings.focusLock.character) {
            settings.focusLock.character = null;
            await manualReset();
        } else {
            const selectedChar = $("#cs-focus-lock-select").val();
            if (selectedChar) { settings.focusLock.character = selectedChar; await issueCostumeForName(selectedChar, { isLock: true }); }
        }
        updateFocusLockUI(); persistSettings("Focus lock " + (settings.focusLock.character ? "set." : "removed."));
    });
    $(document).on('input', '#cs-detection-bias', function() { $("#cs-detection-bias-value").text($(this).val()); });
    $(document).on('click', '#cs-reset', manualReset);
    $(document).on('click', '#cs-mapping-add', () => { const profile = getActiveProfile(); if (profile) { profile.mappings.push({ name: "", folder: "" }); renderMappings(profile); } });
    $(document).on('click', '#cs-mappings-tbody .map-remove', function() {
        const idx = parseInt($(this).closest('tr').attr('data-idx'), 10);
        const profile = getActiveProfile();
        if (profile && !isNaN(idx)) {
            profile.mappings.splice(idx, 1);
            renderMappings(profile); // Re-render to update indices
        }
    });
    $(document).on('click', '#cs-regex-test-button', testRegexPattern);
}

async function manualReset() {
    const profile = getActiveProfile();
    const costumeArg = profile?.defaultCostume?.trim() ? `\\${profile.defaultCostume.trim()}` : '\\';
    const command = `/costume ${costumeArg}`;
    debugLog("Attempting manual reset with command:", command);
    try {
        await executeSlashCommandsOnChatInput(command);
        state.lastIssuedCostume = costumeArg;
        showStatus(`Reset to <b>${costumeArg}</b>`, 'success');
    } catch (err) {
        showStatus(`Manual reset failed.`, 'error');
        console.error(`${logPrefix} Manual reset failed.`, err);
    }
}

// ======================================================================
// SLASH COMMANDS
// ======================================================================
function registerCommands() {
    registerSlashCommand("cs-addchar", (args) => {
        const profile = getActiveProfile();
        if (profile) {
            profile.patterns.push(args[0]);
            recompileRegexes();
            showStatus(`Added "<b>${args[0]}</b>" to patterns for this session.`, 'success');
        }
    }, ["char"], "Adds a character to the current profile's pattern list for this session.", true);

    registerSlashCommand("cs-ignore", (args) => {
        const profile = getActiveProfile();
        if (profile) {
            profile.ignorePatterns.push(args[0]);
            recompileRegexes();
            showStatus(`Ignoring "<b>${args[0]}</b>" for this session.`, 'success');
        }
    }, ["char"], "Adds a character to the current profile's ignore list for this session.", true);

    registerSlashCommand("cs-map", (args) => {
        const profile = getActiveProfile();
        const [alias, , folder] = args;
        if (profile && alias && folder) {
            profile.mappings.push({ name: alias, folder: folder });
            showStatus(`Mapped "<b>${alias}</b>" to "<b>${folder}</b>" for this session.`, 'success');
        }
    }, ["alias", "to", "folder"], "Maps a character alias to a costume folder for this session. Use 'to' to separate.", true);
}

// ======================================================================
// EVENT HANDLERS
// ======================================================================
const handleGenerationStart = (messageId) => {
    const bufKey = messageId != null ? `m${messageId}` : 'live';
    debugLog(`Generation started for ${bufKey}, resetting state.`);
    
    const profile = getActiveProfile();
    const oldState = state.perMessageStates.size > 0 ? Array.from(state.perMessageStates.values()).pop() : null;
    
    const newState = { 
        lastAcceptedName: null, 
        lastAcceptedTs: 0, 
        vetoed: false,
        lastSubject: oldState?.lastSubject || null,
        sceneRoster: new Set(oldState?.sceneRoster || []),
        rosterTTL: profile.sceneRosterTTL,
    };

    if (newState.sceneRoster.size > 0) {
        newState.rosterTTL--;
        if (newState.rosterTTL <= 0) {
            debugLog("Scene roster TTL expired, clearing roster.");
            newState.sceneRoster.clear();
        }
    }
    
    state.perMessageStates.set(bufKey, newState);
    state.perMessageBuffers.delete(bufKey);
};

const handleStream = (...args) => {
    try {
        const settings = getSettings();
        if (!settings.enabled || settings.focusLock.character) return;
        const profile = getActiveProfile();
        if (!profile) return;

        let tokenText = "", messageId = null;
        if (typeof args[0] === 'number') { messageId = args[0]; tokenText = String(args[1] ?? ""); } 
        else if (typeof args[0] === 'object') { tokenText = String(args[0].token ?? args[0].text ?? ""); messageId = args[0].messageId ?? args[1] ?? null; } 
        else { tokenText = String(args.join(' ') || ""); }
        if (!tokenText) return;

        const bufKey = messageId != null ? `m${messageId}` : 'live';
        if (!state.perMessageStates.has(bufKey)) handleGenerationStart(messageId);
        
        const msgState = state.perMessageStates.get(bufKey);
        if (msgState.vetoed) return;

        const prev = state.perMessageBuffers.get(bufKey) || "";
        const combined = (prev + normalizeStreamText(tokenText)).slice(-profile.maxBufferChars);
        state.perMessageBuffers.set(bufKey, combined);
        
        if (combined.length < (msgState.nextThreshold || profile.tokenProcessThreshold)) return;
        msgState.nextThreshold = combined.length + profile.tokenProcessThreshold;

        if (state.compiledRegexes.vetoRegex && state.compiledRegexes.vetoRegex.test(combined)) {
            debugLog("Veto phrase matched. Halting detection for this message.");
            msgState.vetoed = true; return;
        }

        const bestMatch = findBestMatch(combined);

        if (bestMatch) {
            const { name: matchedName, matchKind } = bestMatch;
            const now = Date.now();
            const suppressMs = profile.repeatSuppressMs;

            // Update Scene Roster
            if (profile.enableSceneRoster) {
                msgState.sceneRoster.add(matchedName.toLowerCase());
                msgState.rosterTTL = profile.sceneRosterTTL; // Reset TTL on mention
                debugLog("Updated scene roster:", Array.from(msgState.sceneRoster));
            }
            // Update Last Subject for pronoun detection
            if (matchKind !== 'pronoun') {
                msgState.lastSubject = matchedName;
                debugLog("Last subject set to:", matchedName);
            }
            
            if (msgState.lastAcceptedName?.toLowerCase() === matchedName.toLowerCase() && (now - msgState.lastAcceptedTs < suppressMs)) {
                debugLog('Suppressing repeat match for same name (flicker guard)', { matchedName }); 
                return;
            }
            
            msgState.lastAcceptedName = matchedName;
            msgState.lastAcceptedTs = now;
            issueCostumeForName(matchedName, { matchKind, bufKey });
        }
    } catch (err) { console.error(`${logPrefix} stream handler error:`, err); }
};

const cleanupMessageState = (messageId) => { if (messageId != null) { state.perMessageBuffers.delete(`m${messageId}`); }};
const resetGlobalState = () => { Object.assign(state, { lastIssuedCostume: null, lastSwitchTimestamp: 0, lastTriggerTimes: new Map(), failedTriggerTimes: new Map(), perMessageBuffers: new Map(), perMessageStates: new Map() }); };

function load() {
    state.eventHandlers = {
        [event_types.STREAM_TOKEN_RECEIVED]: handleStream,
        [event_types.GENERATION_STARTED]: handleGenerationStart,
        [event_types.GENERATION_ENDED]: cleanupMessageState,
        [event_types.CHAT_CHANGED]: resetGlobalState,
    };
    for (const [event, handler] of Object.entries(state.eventHandlers)) {
        eventSource.on(event, handler);
    }
}

function unload() {
    for (const [event, handler] of Object.entries(state.eventHandlers)) {
        eventSource.off(event, handler);
    }
    resetGlobalState();
}

// ======================================================================
// INITIALIZATION
// ======================================================================
function getSettingsObj() {
    const getCtx = typeof getContext === 'function' ? getContext : () => window.SillyTavern.getContext();
    const ctx = getCtx();
    let storeSource = ctx.extensionSettings;

    if (!storeSource[extensionName] || !storeSource[extensionName].profiles) {
        console.log(`${logPrefix} Migrating old settings to new profile format.`);
        const oldSettings = storeSource[extensionName] || {};
        const newSettings = structuredClone(DEFAULTS);
        Object.keys(PROFILE_DEFAULTS).forEach(key => {
            if (oldSettings.hasOwnProperty(key)) newSettings.profiles.Default[key] = oldSettings[key];
        });
        if (oldSettings.hasOwnProperty('enabled')) newSettings.enabled = oldSettings.enabled;
        storeSource[extensionName] = newSettings;
    }
    
    storeSource[extensionName] = Object.assign({}, structuredClone(DEFAULTS), storeSource[extensionName]);
    for (const profileName in storeSource[extensionName].profiles) {
        storeSource[extensionName].profiles[profileName] = Object.assign({}, structuredClone(PROFILE_DEFAULTS), storeSource[extensionName].profiles[profileName]);
    }
    
    return { store: storeSource, save: ctx.saveSettingsDebounced, ctx };
}

jQuery(async () => {
    try {
        const { store } = getSettingsObj();
        extension_settings[extensionName] = store[extensionName];
        
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);

        populateProfileDropdown();
        loadProfile(getSettings().activeProfile);
        wireUI();
        registerCommands();
        load();
        
        window[`__${extensionName}_unload`] = unload;
        console.log(`${logPrefix} v2.0.0 loaded successfully.`);
    } catch (error) {
        console.error(`${logPrefix} failed to initialize:`, error);
        alert(`Failed to initialize Costume Switcher. Check console (F12) for details.`);
    }
});
