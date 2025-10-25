import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, event_types, eventSource } from "../../../../script.js";
import { executeSlashCommandsOnChatInput, registerSlashCommand } from "../../../slash-commands.js";

const extensionName = "SillyTavern-CostumeSwitch";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const logPrefix = "[CostumeSwitch]";

// ======================================================================
// PRESET PROFILES
// ======================================================================
const PRESETS = {
    'novel': {
        name: "Novel Style (Recommended)",
        description: "A balanced setting for narrative or story-based roleplay. Excels at detecting speakers from dialogue and actions.",
        settings: {
            detectAttribution: true,
            detectAction: true,
            detectVocative: false,
            detectPossessive: true,
            detectPronoun: true,
            detectGeneral: false,
            enableSceneRoster: true,
            detectionBias: 0,
        },
    },
    'script': {
        name: "Script / Chat Mode",
        description: "A simple, highly accurate mode for chats that use a clear `Name: \"Dialogue\"` format. Disables complex narrative detection.",
        settings: {
            detectAttribution: false,
            detectAction: false,
            detectVocative: false,
            detectPossessive: false,
            detectPronoun: false,
            detectGeneral: false,
            enableSceneRoster: false,
            detectionBias: 100,
        },
    },
    'group': {
        name: "Group Chat / Ensemble Cast",
        description: "Optimized for chaotic scenes with many characters. Uses the Scene Roster to prioritize recently active participants.",
        settings: {
            detectAttribution: true,
            detectAction: true,
            detectVocative: true,
            detectPossessive: true,
            detectPronoun: true,
            detectGeneral: false,
            enableSceneRoster: true,
            detectionBias: -20,
        },
    },
};


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
    messageStats: new Map(), // For statistical logging
    eventHandlers: {},
    compiledRegexes: {},
    statusTimer: null,
    testerTimers: [],
    lastTesterReport: null,
    buildMeta: null,
    topSceneRanking: new Map(),
    latestTopRanking: { bufKey: null, ranking: [], fullRanking: [], updatedAt: 0 },
    currentGenerationKey: null,
};

const TAB_STORAGE_KEY = `${extensionName}-active-tab`;

function initTabNavigation() {
    const container = document.getElementById('costume-switcher-settings');
    if (!container) return;

    const buttons = Array.from(container.querySelectorAll('.cs-tab-button'));
    const panels = Array.from(container.querySelectorAll('.cs-tab-panel'));
    if (!buttons.length || !panels.length) return;

    const buttonByTab = new Map(buttons.map(btn => [btn.dataset.tab, btn]));
    const panelByTab = new Map(panels.map(panel => [panel.dataset.tab, panel]));

    let storedTab = null;
    try {
        storedTab = window.localStorage?.getItem(TAB_STORAGE_KEY) || null;
    } catch (err) {
        console.debug(`${logPrefix} Unable to read stored tab preference:`, err);
    }

    const activateTab = (tabId, { focusButton = false } = {}) => {
        if (!buttonByTab.has(tabId) || !panelByTab.has(tabId)) return;

        for (const [id, btn] of buttonByTab.entries()) {
            const isActive = id === tabId;
            btn.classList.toggle('is-active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
            btn.setAttribute('tabindex', isActive ? '0' : '-1');
            if (isActive && focusButton) {
                btn.focus();
            }
        }

        for (const [id, panel] of panelByTab.entries()) {
            const isActive = id === tabId;
            panel.classList.toggle('is-active', isActive);
            panel.toggleAttribute('hidden', !isActive);
        }

        try {
            window.localStorage?.setItem(TAB_STORAGE_KEY, tabId);
        } catch (err) {
            console.debug(`${logPrefix} Unable to persist tab preference:`, err);
        }
    };

    const defaultTab = buttonByTab.has(storedTab) ? storedTab : buttons[0].dataset.tab;
    activateTab(defaultTab);

    container.addEventListener('click', (event) => {
        const target = event.target.closest('.cs-tab-button');
        if (!target || !container.contains(target)) return;
        const tabId = target.dataset.tab;
        if (tabId) {
            activateTab(tabId);
        }
    });

    container.addEventListener('keydown', (event) => {
        if (!event.target.classList.contains('cs-tab-button')) return;

        const currentIndex = buttons.indexOf(event.target);
        if (currentIndex === -1) return;

        let nextIndex = null;
        switch (event.key) {
            case 'ArrowRight':
            case 'ArrowDown':
                nextIndex = (currentIndex + 1) % buttons.length;
                break;
            case 'ArrowLeft':
            case 'ArrowUp':
                nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
                break;
            case 'Home':
                nextIndex = 0;
                break;
            case 'End':
                nextIndex = buttons.length - 1;
                break;
            default:
                break;
        }

        if (nextIndex != null) {
            event.preventDefault();
            const nextButton = buttons[nextIndex];
            activateTab(nextButton.dataset.tab, { focusButton: true });
        }
    });
}

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

function findBestMatch(combined, precomputedMatches = null) {
    const profile = getActiveProfile();
    const allMatches = Array.isArray(precomputedMatches) ? precomputedMatches : findAllMatches(combined);
    if (allMatches.length === 0) return null;

    let rosterSet = null;
    if (profile.enableSceneRoster) {
        const msgState = Array.from(state.perMessageStates.values()).pop();
        if (msgState && msgState.sceneRoster.size > 0) {
            rosterSet = msgState.sceneRoster;
        }
    }

    return getWinner(allMatches, profile.detectionBias, combined.length, { rosterSet });
}

function getWinner(matches, bias = 0, textLength = 0, options = {}) {
    const rosterSet = options?.rosterSet instanceof Set ? options.rosterSet : null;
    const rosterBonus = Number.isFinite(options?.rosterBonus) ? options.rosterBonus : 150;
    const rosterPriorityDropoff = Number.isFinite(options?.rosterPriorityDropoff)
        ? options.rosterPriorityDropoff
        : 0.5;
    const scoredMatches = matches.map(match => {
        const isActive = match.priority >= 3; // speaker, attribution, action
        const distanceFromEnd = Number.isFinite(textLength)
            ? Math.max(0, textLength - match.matchIndex)
            : 0;
        const baseScore = match.priority * 100 - distanceFromEnd;
        let score = baseScore + (isActive ? bias : 0);
        if (rosterSet) {
            const normalized = String(match.name || '').toLowerCase();
            if (normalized && rosterSet.has(normalized)) {
                let bonus = rosterBonus;
                if (match.priority >= 3 && rosterPriorityDropoff > 0) {
                    const dropoffMultiplier = 1 - rosterPriorityDropoff * (match.priority - 2);
                    bonus *= Math.max(0, dropoffMultiplier);
                }
                score += bonus;
            }
        }
        return { ...match, score };
    });
    scoredMatches.sort((a, b) => b.score - a.score);
    return scoredMatches[0];
}

function buildLowercaseSet(values) {
    if (!values) return null;
    const iterable = values instanceof Set ? values : new Set(values);
    const lower = new Set();
    for (const value of iterable) {
        const normalized = String(value ?? '').trim().toLowerCase();
        if (normalized) {
            lower.add(normalized);
        }
    }
    return lower.size ? lower : null;
}

function rankSceneCharacters(matches, options = {}) {
    if (!Array.isArray(matches) || matches.length === 0) {
        return [];
    }

    const rosterSet = buildLowercaseSet(options?.rosterSet);
    const summary = new Map();

    matches.forEach((match, idx) => {
        if (!match || !match.name) return;
        const normalized = normalizeCostumeName(match.name);
        if (!normalized) return;

        const displayName = String(match.name).trim() || normalized;
        const key = normalized.toLowerCase();
        let entry = summary.get(key);
        if (!entry) {
            entry = {
                name: displayName,
                normalized,
                count: 0,
                bestPriority: -Infinity,
                earliest: Number.POSITIVE_INFINITY,
                latest: Number.NEGATIVE_INFINITY,
                inSceneRoster: rosterSet ? rosterSet.has(key) : false,
            };
            summary.set(key, entry);
        }

        entry.count += 1;
        const priority = Number.isFinite(match.priority) ? match.priority : 0;
        if (priority > entry.bestPriority) {
            entry.bestPriority = priority;
        }
        const index = Number.isFinite(match.matchIndex) ? match.matchIndex : idx;
        if (index < entry.earliest) {
            entry.earliest = index;
            entry.firstMatchKind = match.matchKind || entry.firstMatchKind || null;
        }
        if (index > entry.latest) {
            entry.latest = index;
        }
        if (!entry.inSceneRoster && rosterSet) {
            entry.inSceneRoster = rosterSet.has(key);
        }
    });

    const ranked = Array.from(summary.values()).map((entry) => {
        const priorityScore = Number.isFinite(entry.bestPriority) ? entry.bestPriority : 0;
        const earliest = Number.isFinite(entry.earliest) ? entry.earliest : Number.MAX_SAFE_INTEGER;
        const rosterBonus = entry.inSceneRoster ? 50 : 0;
        const score = entry.count * 1000 + priorityScore * 100 + rosterBonus - earliest;
        return {
            name: entry.name,
            normalized: entry.normalized,
            count: entry.count,
            bestPriority: priorityScore,
            earliest: Number.isFinite(entry.earliest) ? entry.earliest : null,
            latest: Number.isFinite(entry.latest) ? entry.latest : null,
            inSceneRoster: Boolean(entry.inSceneRoster),
            firstMatchKind: entry.firstMatchKind || null,
            score,
        };
    });

    ranked.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.count !== a.count) return b.count - a.count;
        if (b.bestPriority !== a.bestPriority) return b.bestPriority - a.bestPriority;
        const aEarliest = Number.isFinite(a.earliest) ? a.earliest : Number.MAX_SAFE_INTEGER;
        const bEarliest = Number.isFinite(b.earliest) ? b.earliest : Number.MAX_SAFE_INTEGER;
        if (aEarliest !== bEarliest) return aEarliest - bEarliest;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    return ranked;
}

function ensureSessionData() {
    const settings = getSettings();
    if (!settings) return null;
    if (typeof settings.session !== 'object' || settings.session === null) {
        settings.session = {};
    }
    return settings.session;
}

function updateSessionTopCharacters(bufKey, ranking) {
    const session = ensureSessionData();
    if (!session) return;

    const topRanking = Array.isArray(ranking) ? ranking.slice(0, 4) : [];
    const names = topRanking.map(entry => entry.name);
    const normalizedNames = topRanking.map(entry => entry.normalized);
    const details = topRanking.map(entry => ({
        name: entry.name,
        normalized: entry.normalized,
        count: entry.count,
        bestPriority: entry.bestPriority,
        inSceneRoster: entry.inSceneRoster,
        score: Number.isFinite(entry.score) ? Math.round(entry.score) : 0,
    }));

    session.topCharacters = names;
    session.topCharactersNormalized = normalizedNames;
    session.topCharactersString = names.join(', ');
    session.topCharacterDetails = details;
    session.lastMessageKey = bufKey || null;
    session.lastUpdated = Date.now();

    state.latestTopRanking = {
        bufKey: bufKey || null,
        ranking: topRanking,
        fullRanking: Array.isArray(ranking) ? ranking : [],
        updatedAt: session.lastUpdated,
    };
}

function clearSessionTopCharacters() {
    const session = ensureSessionData();
    if (!session) return;
    session.topCharacters = [];
    session.topCharactersNormalized = [];
    session.topCharactersString = '';
    session.topCharacterDetails = [];
    session.lastMessageKey = null;
    session.lastUpdated = Date.now();

    state.latestTopRanking = {
        bufKey: null,
        ranking: [],
        fullRanking: [],
        updatedAt: session.lastUpdated,
    };
}

function clampTopCount(count = 4) {
    return Math.min(Math.max(Number(count) || 4, 1), 4);
}

function getLastStatsMessageKey() {
    if (!(state.messageStats instanceof Map) || state.messageStats.size === 0) {
        return null;
    }
    const lastKey = Array.from(state.messageStats.keys()).pop();
    return normalizeMessageKey(lastKey);
}

function getLastTopCharacters(count = 4) {
    const limit = clampTopCount(count);
    if (Array.isArray(state.latestTopRanking?.ranking) && state.latestTopRanking.ranking.length) {
        return state.latestTopRanking.ranking.slice(0, limit);
    }

    const lastMessageKey = getLastStatsMessageKey();
    if (lastMessageKey && state.topSceneRanking instanceof Map) {
        const rankingForKey = state.topSceneRanking.get(lastMessageKey);
        if (Array.isArray(rankingForKey) && rankingForKey.length) {
            return rankingForKey.slice(0, limit);
        }
    }

    if (state.topSceneRanking instanceof Map && state.topSceneRanking.size > 0) {
        const lastRanking = Array.from(state.topSceneRanking.values()).pop();
        if (Array.isArray(lastRanking) && lastRanking.length) {
            return lastRanking.slice(0, limit);
        }
    }
    return [];
}


// ======================================================================
// UTILITY & HELPER FUNCTIONS
// ======================================================================
function escapeHtml(str) {
    const p = document.createElement("p");
    p.textContent = str;
    return p.innerHTML;
}
function normalizeStreamText(s) { return s ? String(s).replace(/[\uFEFF\u200B\u200C\u200D]/g, "").replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"').replace(/(\*\*|__|~~|`{1,3})/g, "").replace(/\u00A0/g, " ") : ""; }
function normalizeCostumeName(n) {
    if (!n) return "";
    let s = String(n).trim();
    if (s.startsWith("/") || s.startsWith("\\")) {
        s = s.slice(1).trim();
    }
    const segments = s.split(/[\\/]+/).filter(Boolean);
    const base = segments.length ? segments[segments.length - 1] : s;
    return String(base).replace(/[-_](?:sama|san)$/i, "").trim();
}
function getSettings() { return extension_settings[extensionName]; }
function getActiveProfile() { const settings = getSettings(); return settings?.profiles?.[settings.activeProfile]; }
function debugLog(...args) { try { if (getActiveProfile()?.debug) console.debug(logPrefix, ...args); } catch (e) { } }

function showStatus(message, type = 'info', duration = 3000) {
    const statusEl = $("#cs-status");
    const textEl = statusEl.find('.cs-status-text');
    if (state.statusTimer) {
        clearTimeout(state.statusTimer);
        state.statusTimer = null;
    }

    statusEl.toggleClass('is-error', type === 'error');
    statusEl.toggleClass('is-success', type === 'success');
    textEl.html(message);
    statusEl.stop(true, true).fadeIn();

    state.statusTimer = setTimeout(() => {
        statusEl.fadeOut(400, () => {
            textEl.text('Ready');
            statusEl.removeClass('is-error is-success').fadeIn();
        });
        state.statusTimer = null;
    }, Math.max(duration, 1000));
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

        const escapeVerbList = (list) => (list || [])
            .map(entry => parsePatternEntry(entry)?.body || escapeRegex(entry))
            .filter(Boolean)
            .join('|');
        const attributionVerbsPattern = escapeVerbList(profile.attributionVerbs);
        const actionVerbsPattern = escapeVerbList(profile.actionVerbs);

        const speakerTemplate = '(?:^|[\r\n]+|[>\]]\s*)({{PATTERNS}})\s*:';
        const boundaryLookbehind = "(?<![A-Za-z0-9_'’])";
        const attributionTemplate = attributionVerbsPattern
            ? `${boundaryLookbehind}({{PATTERNS}})\\s+(?:${attributionVerbsPattern})`
            : null;
        const actionTemplate = actionVerbsPattern
            ? `${boundaryLookbehind}({{PATTERNS}})(?:['’]s)?\\s+(?:\\w+\\s+){0,3}?(?:${actionVerbsPattern})`
            : null;

        state.compiledRegexes = {
            speakerRegex: buildRegex(effectivePatterns, speakerTemplate),
            attributionRegex: attributionTemplate ? buildRegex(effectivePatterns, attributionTemplate) : null,
            actionRegex: actionTemplate ? buildRegex(effectivePatterns, actionTemplate) : null,
            pronounRegex: actionVerbsPattern ? new RegExp(`(?:^|[\r\n]+)\s*(he|she|they)(?:'s)?\s+(?:\\w+\\s+){0,3}?(?:${actionVerbsPattern})`, 'i') : null,
            vocativeRegex: buildRegex(effectivePatterns, `["“'\\s]({{PATTERNS}})[,.!?]`),
            possessiveRegex: buildRegex(effectivePatterns, `\\b({{PATTERNS}})['’]s\\b`),
            nameRegex: buildRegex(effectivePatterns, `\\b({{PATTERNS}})\\b`),
            vetoRegex: buildGenericRegex(profile.vetoPatterns),
        };
        $("#cs-error").prop('hidden', true).find('.cs-status-text').text('');
    } catch (e) {
        $("#cs-error").prop('hidden', false).find('.cs-status-text').text(`Pattern compile error: ${String(e)}`);
        showStatus(`Pattern compile error: ${String(e)}`, 'error', 5000);
    }
}

function ensureMap(value) {
    if (value instanceof Map) return value;
    if (!value) return new Map();
    try { return new Map(value instanceof Array ? value : Object.entries(value)); }
    catch { return new Map(); }
}

function evaluateSwitchDecision(rawName, opts = {}, contextState = null, nowOverride = null) {
    const profile = getActiveProfile();
    if (!profile) {
        return { shouldSwitch: false, reason: 'no-profile' };
    }
    if (!rawName) {
        return { shouldSwitch: false, reason: 'no-name' };
    }

    const runtimeState = contextState || state;
    const now = Number.isFinite(nowOverride) ? nowOverride : Date.now();
    const decision = { now };

    decision.name = normalizeCostumeName(rawName);
    const currentName = normalizeCostumeName(runtimeState.lastIssuedCostume || "");

    if (!opts.isLock && currentName && currentName.toLowerCase() === decision.name.toLowerCase()) {
        return { shouldSwitch: false, reason: 'already-active', name: decision.name, now };
    }

    if (!opts.isLock && profile.globalCooldownMs > 0 && (now - (runtimeState.lastSwitchTimestamp || 0) < profile.globalCooldownMs)) {
        return { shouldSwitch: false, reason: 'global-cooldown', name: decision.name, now };
    }

    let mappedFolder = profile.mappings.find(m => m.name.toLowerCase() === decision.name.toLowerCase())?.folder;
    mappedFolder = mappedFolder ? mappedFolder.trim() : decision.name;

    const lastTriggerTimes = ensureMap(runtimeState.lastTriggerTimes);
    const failedTriggerTimes = ensureMap(runtimeState.failedTriggerTimes);
    if (contextState) {
        runtimeState.lastTriggerTimes = lastTriggerTimes;
        runtimeState.failedTriggerTimes = failedTriggerTimes;
    } else {
        state.lastTriggerTimes = lastTriggerTimes;
        state.failedTriggerTimes = failedTriggerTimes;
    }

    if (!opts.isLock && profile.perTriggerCooldownMs > 0) {
        const lastSuccess = lastTriggerTimes.get(mappedFolder) || 0;
        if (now - lastSuccess < profile.perTriggerCooldownMs) {
            return { shouldSwitch: false, reason: 'per-trigger-cooldown', name: decision.name, folder: mappedFolder, now };
        }
    }

    if (!opts.isLock && profile.failedTriggerCooldownMs > 0) {
        const lastFailed = failedTriggerTimes.get(mappedFolder) || 0;
        if (now - lastFailed < profile.failedTriggerCooldownMs) {
            return { shouldSwitch: false, reason: 'failed-trigger-cooldown', name: decision.name, folder: mappedFolder, now };
        }
    }

    return { shouldSwitch: true, name: decision.name, folder: mappedFolder, now };
}

async function issueCostumeForName(name, opts = {}) {
    const decision = evaluateSwitchDecision(name, opts);
    if (!decision.shouldSwitch) {
        debugLog("Switch skipped for", name, "reason:", decision.reason || 'n/a');
        return;
    }

    const command = `/costume \\${decision.folder}`;
    debugLog("Executing command:", command, "kind:", opts.matchKind || 'N/A');
    try {
        await executeSlashCommandsOnChatInput(command);
        state.lastTriggerTimes.set(decision.folder, decision.now);
        state.lastIssuedCostume = decision.name;
        state.lastSwitchTimestamp = decision.now;
        showStatus(`Switched -> <b>${escapeHtml(decision.folder)}</b>`, 'success');
    } catch (err) {
        state.failedTriggerTimes.set(decision.folder, decision.now);
        showStatus(`Failed to switch to costume "<b>${escapeHtml(decision.folder)}</b>". Check console (F12).`, 'error');
        console.error(`${logPrefix} Failed to execute /costume command for "${decision.folder}".`, err);
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
    perTriggerCooldownMs: { selector: '#cs-per-trigger-cooldown', type: 'number' },
    failedTriggerCooldownMs: { selector: '#cs-failed-trigger-cooldown', type: 'number' },
    maxBufferChars: { selector: '#cs-max-buffer-chars', type: 'number' },
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

function normalizeProfileNameInput(name) {
    return String(name ?? '').replace(/\s+/g, ' ').trim();
}

function getUniqueProfileName(baseName = 'Profile') {
    const settings = getSettings();
    let attempt = normalizeProfileNameInput(baseName);
    if (!attempt) attempt = 'Profile';
    if (!settings?.profiles?.[attempt]) return attempt;

    let counter = 2;
    while (settings.profiles[`${attempt} (${counter})`]) {
        counter += 1;
    }
    return `${attempt} (${counter})`;
}

function resolveMaxBufferChars(profile) {
    const raw = Number(profile?.maxBufferChars);
    if (Number.isFinite(raw) && raw > 0) {
        return raw;
    }
    return PROFILE_DEFAULTS.maxBufferChars;
}

function populateProfileDropdown() {
    const select = $("#cs-profile-select");
    const settings = getSettings();
    select.empty();
    if (!settings?.profiles) return;
    Object.keys(settings.profiles).forEach(name => {
        select.append($('<option>', { value: name, text: name }));
    });
    select.val(settings.activeProfile);
}

function populatePresetDropdown() {
    const select = $("#cs-preset-select");
    select.empty().append($('<option>', { value: '', text: 'Select a preset...' }));
    for (const key in PRESETS) {
        select.append($('<option>', { value: key, text: PRESETS[key].name }));
    }
    $("#cs-preset-description").text("Load a recommended configuration into the current profile.");
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
    $("#cs-profile-name").val('').attr('placeholder', `Enter a name... (current: ${profileName})`);
    $("#cs-enable").prop('checked', !!settings.enabled);
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
        const field = $(selector);
        if (!field.length) {
            const fallback = PROFILE_DEFAULTS[key];
            if (type === 'textarea' || type === 'csvTextarea') {
                profileData[key] = Array.isArray(fallback) ? [...fallback] : [];
            } else if (type === 'checkbox') {
                profileData[key] = Boolean(fallback);
            } else if (type === 'number' || type === 'range') {
                profileData[key] = Number.isFinite(fallback) ? fallback : 0;
            } else {
                profileData[key] = typeof fallback === 'string' ? fallback : '';
            }
            continue;
        }

        let value;
        switch (type) {
            case 'checkbox':
                value = field.prop('checked');
                break;
            case 'textarea':
                value = field.val().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                break;
            case 'csvTextarea':
                value = field.val().split(',').map(s => s.trim()).filter(Boolean);
                break;
            case 'number':
            case 'range': {
                const parsed = parseInt(field.val(), 10);
                const fallback = PROFILE_DEFAULTS[key] ?? 0;
                value = Number.isFinite(parsed) ? parsed : fallback;
                break;
            }
            default:
                value = String(field.val() ?? '').trim();
                break;
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

async function fetchBuildMetadata() {
    const meta = {
        version: null,
        label: 'Dev build',
        updatedLabel: `Loaded ${new Date().toLocaleString()}`,
    };

    try {
        const manifestRequest = $.ajax({
            url: `${extensionFolderPath}/manifest.json`,
            dataType: 'json',
            cache: false,
        });
        const manifest = await manifestRequest;
        if (manifest?.version) {
            meta.version = manifest.version;
            meta.label = `v${manifest.version}`;
        } else {
            meta.label = 'Local build';
        }

        const lastModifiedHeader = manifestRequest.getResponseHeader('Last-Modified');
        if (lastModifiedHeader) {
            const parsed = new Date(lastModifiedHeader);
            if (!Number.isNaN(parsed.valueOf())) {
                meta.updatedLabel = `Updated ${parsed.toLocaleString()}`;
            }
        }
    } catch (err) {
        console.warn(`${logPrefix} Unable to read manifest for build metadata.`, err);
        meta.label = 'Dev build';
        meta.updatedLabel = 'Manifest unavailable';
    }

    return meta;
}

function renderBuildMetadata(meta) {
    state.buildMeta = meta;
    const versionEl = document.getElementById('cs-build-version');
    const updatedEl = document.getElementById('cs-build-updated');

    if (versionEl) {
        versionEl.textContent = meta?.label || 'Dev build';
        if (meta?.version) {
            versionEl.dataset.version = meta.version;
            versionEl.setAttribute('title', `Extension version ${meta.version}`);
        } else {
            delete versionEl.dataset.version;
            versionEl.removeAttribute('title');
        }
    }

    if (updatedEl) {
        updatedEl.textContent = meta?.updatedLabel || '';
        if (meta?.updatedLabel) {
            updatedEl.setAttribute('title', meta.updatedLabel);
        } else {
            updatedEl.removeAttribute('title');
        }
    }
}

function persistSettings(message, type = 'success') {
    saveSettingsDebounced();
    if (message) showStatus(message, type);
}

function clearTesterTimers() {
    if (!Array.isArray(state.testerTimers)) {
        state.testerTimers = [];
    }
    state.testerTimers.forEach(clearTimeout);
    state.testerTimers.length = 0;
}

function describeSkipReason(code) {
    const messages = {
        'already-active': 'already the active costume',
        'global-cooldown': 'blocked by global cooldown',
        'per-trigger-cooldown': 'blocked by per-trigger cooldown',
        'failed-trigger-cooldown': 'waiting after a failed switch',
        'repeat-suppression': 'suppressed as a rapid repeat',
        'no-profile': 'profile unavailable',
        'no-name': 'no name detected',
    };
    return messages[code] || 'not eligible to switch yet';
}

function updateTesterCopyButton() {
    const button = $("#cs-regex-test-copy");
    if (!button.length) return;
    const hasReport = Boolean(state.lastTesterReport);
    button.prop('disabled', !hasReport);
}

function updateTesterTopCharactersDisplay(entries) {
    const el = document.getElementById('cs-test-top-characters');
    if (!el) return;

    if (entries === null) {
        el.textContent = 'N/A';
        el.classList.add('cs-tester-list-placeholder');
        return;
    }

    if (!Array.isArray(entries) || entries.length === 0) {
        el.textContent = '(none)';
        el.classList.add('cs-tester-list-placeholder');
        return;
    }

    el.textContent = entries.map(entry => entry.name).join(', ');
    el.classList.remove('cs-tester-list-placeholder');
}

function copyTextToClipboard(text) {
    if (typeof navigator !== 'undefined' && navigator?.clipboard?.writeText) {
        return navigator.clipboard.writeText(text).catch(() => fallbackCopy());
    }
    return fallbackCopy();

    function fallbackCopy() {
        return new Promise((resolve, reject) => {
            const temp = $('<textarea>').css({
                position: 'fixed',
                top: '-9999px',
                left: '-9999px',
                width: '1px',
                height: '1px',
                opacity: '0',
            }).val(text).appendTo('body');
            try {
                const node = temp.get(0);
                node.focus();
                node.select();
                const successful = document.execCommand('copy');
                temp.remove();
                if (successful) resolve();
                else reject(new Error('execCommand failed'));
            } catch (err) {
                temp.remove();
                reject(err);
            }
        });
    }
}

function summarizeDetectionsForReport(matches = []) {
    const summaries = new Map();
    matches.forEach(match => {
        const key = String(match.name || '').toLowerCase();
        if (!key) return;
        if (!summaries.has(key)) {
            summaries.set(key, {
                name: match.name || key,
                total: 0,
                highestPriority: -Infinity,
                earliest: Infinity,
                latest: -Infinity,
                kinds: {},
            });
        }
        const summary = summaries.get(key);
        summary.total += 1;
        const kind = match.matchKind || 'unknown';
        summary.kinds[kind] = (summary.kinds[kind] || 0) + 1;
        if (Number.isFinite(match.priority)) {
            summary.highestPriority = Math.max(summary.highestPriority, match.priority);
        }
        if (Number.isFinite(match.matchIndex)) {
            summary.earliest = Math.min(summary.earliest, match.matchIndex);
            summary.latest = Math.max(summary.latest, match.matchIndex);
        }
    });

    return Array.from(summaries.values()).map(summary => ({
        ...summary,
        highestPriority: summary.highestPriority === -Infinity ? null : summary.highestPriority,
        earliest: summary.earliest === Infinity ? null : summary.earliest + 1,
        latest: summary.latest === -Infinity ? null : summary.latest + 1,
    })).sort((a, b) => {
        if (b.total !== a.total) return b.total - a.total;
        const bPriority = b.highestPriority ?? -Infinity;
        const aPriority = a.highestPriority ?? -Infinity;
        if (bPriority !== aPriority) return bPriority - aPriority;
        const aEarliest = a.earliest ?? Infinity;
        const bEarliest = b.earliest ?? Infinity;
        if (aEarliest !== bEarliest) return aEarliest - bEarliest;
        return a.name.localeCompare(b.name);
    });
}

function summarizeSkipReasonsForReport(events = []) {
    const counts = new Map();
    events.forEach(event => {
        if (event?.type === 'skipped') {
            const key = event.reason || 'unknown';
            counts.set(key, (counts.get(key) || 0) + 1);
        }
    });
    return Array.from(counts.entries()).map(([code, count]) => ({ code, count })).sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.code.localeCompare(b.code);
    });
}

function summarizeSwitchesForReport(events = []) {
    const switches = events.filter(event => event?.type === 'switch');
    const uniqueFolders = [];
    const seen = new Set();
    switches.forEach(sw => {
        const raw = sw.folder || sw.name || '';
        const key = raw.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            uniqueFolders.push(raw || '(unknown)');
        }
    });

    const scored = switches.filter(sw => Number.isFinite(sw.score));
    const topScores = scored
        .slice()
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

    return {
        total: switches.length,
        uniqueCount: uniqueFolders.length,
        uniqueFolders,
        lastSwitch: switches.length ? switches[switches.length - 1] : null,
        topScores,
    };
}

function formatTesterReport(report) {
    const lines = [];
    const created = new Date(report.generatedAt || Date.now());
    lines.push('Costume Switcher – Live Pattern Tester Report');
    lines.push('---------------------------------------------');
    lines.push(`Profile: ${report.profileName || 'Unknown profile'}`);
    lines.push(`Generated: ${created.toLocaleString()}`);
    lines.push(`Original input length: ${report.input?.length ?? 0} chars`);
    lines.push(`Processed length: ${report.normalizedInput?.length ?? 0} chars`);
    lines.push(`Veto triggered: ${report.vetoed ? `Yes (match: "${report.vetoMatch || 'unknown'}")` : 'No'}`);

    const patternList = Array.isArray(report.profileSnapshot?.patterns)
        ? report.profileSnapshot.patterns.map((entry) => String(entry ?? '').trim()).filter(Boolean)
        : [];
    lines.push(`Character Patterns: ${patternList.length ? patternList.join(', ') : '(none)'}`);
    lines.push('');

    lines.push('Detections:');
    if (report.matches?.length) {
        report.matches.forEach((m, idx) => {
            const charPos = Number.isFinite(m.matchIndex) ? m.matchIndex + 1 : '?';
            lines.push(`  ${idx + 1}. ${m.name} – ${m.matchKind} @ char ${charPos} (priority ${m.priority})`);
        });
    } else {
        lines.push('  (none)');
    }
    lines.push('');

    lines.push('Switch Decisions:');
    if (report.events?.length) {
        report.events.forEach((event, idx) => {
            if (event.type === 'switch') {
                const detail = event.matchKind ? ` via ${event.matchKind}` : '';
                const score = Number.isFinite(event.score) ? `, score ${event.score}` : '';
                const charPos = Number.isFinite(event.charIndex) ? event.charIndex + 1 : '?';
                lines.push(`  ${idx + 1}. SWITCH → ${event.folder} (name: ${event.name}${detail}, char ${charPos}${score})`);
            } else if (event.type === 'veto') {
                const charPos = Number.isFinite(event.charIndex) ? event.charIndex + 1 : '?';
                lines.push(`  ${idx + 1}. VETO – matched "${event.match}" at char ${charPos}`);
            } else {
                const reason = describeSkipReason(event.reason);
                lines.push(`  ${idx + 1}. SKIP – ${event.name} (${event.matchKind}) because ${reason}`);
            }
        });
    } else {
        lines.push('  (none)');
    }

    const detectionSummary = summarizeDetectionsForReport(report.matches);
    lines.push('');
    lines.push('Detection Summary:');
    if (detectionSummary.length) {
        detectionSummary.forEach(item => {
            const kindBreakdown = Object.entries(item.kinds)
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .map(([kind, count]) => `${kind}:${count}`)
                .join(', ');
            const priorityInfo = item.highestPriority != null ? `, highest priority ${item.highestPriority}` : '';
            const rangeInfo = item.earliest != null
                ? item.latest != null && item.latest !== item.earliest
                    ? `, chars ${item.earliest}-${item.latest}`
                    : `, char ${item.earliest}`
                : '';
            const breakdownText = kindBreakdown || 'none';
            lines.push(`  - ${item.name}: ${item.total} detections (${breakdownText}${priorityInfo}${rangeInfo})`);
        });
    } else {
        lines.push('  (none)');
    }

    const switchSummary = summarizeSwitchesForReport(report.events || []);
    lines.push('');
    lines.push('Switch Summary:');
    lines.push(`  Total switches: ${switchSummary.total}`);
    if (switchSummary.uniqueCount > 0) {
        lines.push(`  Unique costumes: ${switchSummary.uniqueCount} (${switchSummary.uniqueFolders.join(', ')})`);
    } else {
        lines.push('  Unique costumes: 0');
    }
    if (switchSummary.lastSwitch) {
        const last = switchSummary.lastSwitch;
        const charPos = Number.isFinite(last.charIndex) ? last.charIndex + 1 : '?';
        const detail = last.matchKind ? ` via ${last.matchKind}` : '';
        const score = Number.isFinite(last.score) ? `, score ${last.score}` : '';
        const folderName = last.folder || last.name || '(unknown)';
        lines.push(`  Last switch: ${folderName} (trigger: ${last.name}${detail}, char ${charPos}${score})`);
    } else {
        lines.push('  Last switch: (none)');
    }
    if (switchSummary.topScores.length) {
        lines.push('  Top switch scores:');
        switchSummary.topScores.forEach((event, idx) => {
            const charPos = Number.isFinite(event.charIndex) ? event.charIndex + 1 : '?';
            const detail = event.matchKind ? ` via ${event.matchKind}` : '';
            const folderName = event.folder || event.name || '(unknown)';
            lines.push(`    ${idx + 1}. ${folderName} – ${event.score} (trigger: ${event.name}${detail}, char ${charPos})`);
        });
    }

    const skipSummary = summarizeSkipReasonsForReport(report.events || []);
    lines.push('');
    lines.push('Skip Reasons:');
    if (skipSummary.length) {
        skipSummary.forEach(item => {
            lines.push(`  - ${describeSkipReason(item.code)} (${item.code}): ${item.count}`);
        });
    } else {
        lines.push('  (none)');
    }

    if (report.finalState) {
        const rosterNames = Array.isArray(report.finalState.sceneRoster)
            ? report.finalState.sceneRoster.map(name => {
                const original = report.matches?.find(m => m.name?.toLowerCase() === name)?.name;
                return original || name;
            })
            : [];
        lines.push('');
        lines.push('Final Stream State:');
        lines.push(`  Scene roster (${rosterNames.length}): ${rosterNames.length ? rosterNames.join(', ') : '(empty)'}`);
        lines.push(`  Last accepted name: ${report.finalState.lastAcceptedName || '(none)'}`);
        lines.push(`  Last subject: ${report.finalState.lastSubject || '(none)'}`);
        if (Number.isFinite(report.finalState.processedLength)) {
            lines.push(`  Processed characters: ${report.finalState.processedLength}`);
        }
        if (Number.isFinite(report.finalState.virtualDurationMs)) {
            lines.push(`  Simulated duration: ${report.finalState.virtualDurationMs} ms`);
        }
    }

    if (Array.isArray(report.topCharacters)) {
        lines.push('');
        lines.push('Top Characters:');
        if (report.topCharacters.length) {
            report.topCharacters.slice(0, 4).forEach((entry, idx) => {
                const rosterTag = entry.inSceneRoster ? ' [scene roster]' : '';
                const scorePart = Number.isFinite(entry.score) ? ` (score ${entry.score})` : '';
                lines.push(`  ${idx + 1}. ${entry.name} – ${entry.count} detections${rosterTag}${scorePart}`);
            });
        } else {
            lines.push('  (none)');
        }
    }

    if (report.profileSnapshot) {
        const summaryKeys = ['globalCooldownMs', 'perTriggerCooldownMs', 'repeatSuppressMs', 'tokenProcessThreshold'];
        lines.push('');
        lines.push('Key Settings:');
        summaryKeys.forEach(key => {
            if (Object.prototype.hasOwnProperty.call(report.profileSnapshot, key)) {
                lines.push(`  ${key}: ${report.profileSnapshot[key]}`);
            }
        });
        lines.push(`  enableSceneRoster: ${report.profileSnapshot.enableSceneRoster ? 'true' : 'false'}`);
        lines.push(`  detectionBias: ${report.profileSnapshot.detectionBias}`);
    }

    lines.push('');
    lines.push('Message used:');
    lines.push(report.input || '(none)');

    return lines.join('\n');
}

function copyTesterReport() {
    if (!state.lastTesterReport) {
        showStatus('Run the live tester to generate a report first.', 'error');
        return;
    }

    const text = formatTesterReport(state.lastTesterReport);
    copyTextToClipboard(text)
        .then(() => showStatus('Live tester report copied to clipboard.', 'success'))
        .catch((err) => {
            console.error(`${logPrefix} Failed to copy tester report`, err);
            showStatus('Unable to copy report. Check console for details.', 'error');
        });
}

function createTesterMessageState(profile) {
    return {
        lastAcceptedName: null,
        lastAcceptedTs: 0,
        vetoed: false,
        lastSubject: null,
        sceneRoster: new Set(),
        rosterTTL: profile.sceneRosterTTL ?? PROFILE_DEFAULTS.sceneRosterTTL,
        processedLength: 0,
    };
}

function simulateTesterStream(combined, profile, bufKey) {
    const events = [];
    const msgState = state.perMessageStates.get(bufKey);
    if (!msgState) {
        return { events, finalState: null };
    }

    const simulationState = {
        lastIssuedCostume: null,
        lastSwitchTimestamp: 0,
        lastTriggerTimes: new Map(),
        failedTriggerTimes: new Map(),
    };

    const threshold = Math.max(0, Number(profile.tokenProcessThreshold) || 0);
    const maxBuffer = resolveMaxBufferChars(profile);
    const rosterTTL = profile.sceneRosterTTL ?? PROFILE_DEFAULTS.sceneRosterTTL;
    const repeatSuppress = Number(profile.repeatSuppressMs) || 0;
    let buffer = '';
    for (let i = 0; i < combined.length; i++) {
        buffer = (buffer + combined[i]).slice(-maxBuffer);
        state.perMessageBuffers.set(bufKey, buffer);

        if (state.compiledRegexes.vetoRegex && state.compiledRegexes.vetoRegex.test(buffer)) {
            const vetoMatch = buffer.match(state.compiledRegexes.vetoRegex)?.[0];
            if (vetoMatch) {
                events.push({ type: 'veto', match: vetoMatch, charIndex: i });
            }
            msgState.vetoed = true;
            break;
        }

        if (buffer.length < msgState.processedLength + threshold) {
            continue;
        }

        msgState.processedLength = buffer.length;
        const bestMatch = findBestMatch(buffer);
        if (!bestMatch) continue;

        if (profile.enableSceneRoster) {
            msgState.sceneRoster.add(bestMatch.name.toLowerCase());
            msgState.rosterTTL = rosterTTL;
        }

        if (bestMatch.matchKind !== 'pronoun') {
            msgState.lastSubject = bestMatch.name;
        }

        const virtualNow = i * 50;
        if (msgState.lastAcceptedName?.toLowerCase() === bestMatch.name.toLowerCase() &&
            (virtualNow - msgState.lastAcceptedTs < repeatSuppress)) {
            events.push({ type: 'skipped', name: bestMatch.name, matchKind: bestMatch.matchKind, reason: 'repeat-suppression', charIndex: i });
            continue;
        }

        msgState.lastAcceptedName = bestMatch.name;
        msgState.lastAcceptedTs = virtualNow;

        const decision = evaluateSwitchDecision(bestMatch.name, { matchKind: bestMatch.matchKind }, simulationState, virtualNow);
        if (decision.shouldSwitch) {
            events.push({
                type: 'switch',
                name: bestMatch.name,
                folder: decision.folder,
                matchKind: bestMatch.matchKind,
                score: Math.round(bestMatch.score ?? 0),
                charIndex: i,
            });
            simulationState.lastIssuedCostume = decision.name;
            simulationState.lastSwitchTimestamp = decision.now;
            simulationState.lastTriggerTimes.set(decision.folder, decision.now);
        } else {
            events.push({
                type: 'skipped',
                name: bestMatch.name,
                matchKind: bestMatch.matchKind,
                reason: decision.reason || 'unknown',
                charIndex: i,
            });
        }
    }

    const finalState = {
        lastAcceptedName: msgState.lastAcceptedName,
        lastAcceptedTimestamp: msgState.lastAcceptedTs,
        lastSubject: msgState.lastSubject,
        processedLength: msgState.processedLength,
        sceneRoster: Array.from(msgState.sceneRoster || []),
        rosterTTL: msgState.rosterTTL,
        vetoed: Boolean(msgState.vetoed),
        virtualDurationMs: combined.length > 0 ? Math.max(0, (combined.length - 1) * 50) : 0,
    };

    return { events, finalState };
}

function renderTesterStream(eventList, events) {
    eventList.empty();
    if (!events.length) {
        eventList.html('<li class="cs-tester-list-placeholder">No stream activity.</li>');
        return;
    }

    let delay = 0;
    events.forEach(event => {
        const item = $('<li>');
        if (event.type === 'switch') {
            item.addClass('cs-tester-log-switch').html(`<b>Switch → ${event.folder}</b><small> (${event.name}${event.matchKind ? ' via ' + event.matchKind : ''}, char #${event.charIndex + 1}${Number.isFinite(event.score) ? ', score ' + event.score : ''})</small>`);
        } else if (event.type === 'veto') {
            item.addClass('cs-tester-log-veto').html(`<b>Veto Triggered</b><small> (${event.match})</small>`);
        } else {
            item.addClass('cs-tester-log-skip').html(`<span>${event.name}</span><small> (${event.matchKind}, ${describeSkipReason(event.reason)})</small>`);
        }

        const timer = setTimeout(() => {
            eventList.append(item);
            const listEl = eventList.get(0);
            if (listEl) {
                listEl.scrollTop = listEl.scrollHeight;
            }
        }, delay);
        state.testerTimers.push(timer);
        delay += event.type === 'switch' ? 260 : 160;
    });
}



function testRegexPattern() {
    clearTesterTimers();
    state.lastTesterReport = null;
    updateTesterCopyButton();
    updateTesterTopCharactersDisplay(null);
    $("#cs-test-veto-result").text('N/A').css('color', 'var(--text-color-soft)');
    const text = $("#cs-regex-test-input").val();
    if (!text) {
        $("#cs-test-all-detections, #cs-test-winner-list").html('<li class="cs-tester-list-placeholder">Enter text to test.</li>');
        updateTesterTopCharactersDisplay(null);
        return;
    }

    const settings = getSettings();
    const originalProfileName = settings.activeProfile;
    const tempProfile = saveCurrentProfileData();
    const tempProfileName = '__temp_test';
    settings.profiles[tempProfileName] = tempProfile;
    settings.activeProfile = tempProfileName;

    const originalPerMessageStates = state.perMessageStates;
    const originalPerMessageBuffers = state.perMessageBuffers;
    const bufKey = tempProfileName;

    const resetTesterMessageState = () => {
        const testerState = createTesterMessageState(tempProfile);
        state.perMessageStates = new Map([[bufKey, testerState]]);
        state.perMessageBuffers = new Map([[bufKey, '']]);
        return testerState;
    };

    resetTesterMessageState();
    recompileRegexes();

    const combined = normalizeStreamText(text);
    const allDetectionsList = $("#cs-test-all-detections");
    const streamList = $("#cs-test-winner-list");

    const reportBase = {
        profileName: originalProfileName,
        profileSnapshot: structuredClone(tempProfile),
        input: text,
        normalizedInput: combined,
        generatedAt: Date.now(),
    };

    if (state.compiledRegexes.vetoRegex && state.compiledRegexes.vetoRegex.test(combined)) {
        const vetoMatch = combined.match(state.compiledRegexes.vetoRegex)?.[0] || 'unknown veto phrase';
        $("#cs-test-veto-result").html(`Vetoed by: <b style="color: var(--red);">${vetoMatch}</b>`);
        allDetectionsList.html('<li class="cs-tester-list-placeholder">Message vetoed.</li>');
        const vetoEvents = [{ type: 'veto', match: vetoMatch, charIndex: combined.length - 1 }];
        renderTesterStream(streamList, vetoEvents);
        state.lastTesterReport = { ...reportBase, vetoed: true, vetoMatch, events: vetoEvents, matches: [], topCharacters: [] };
        updateTesterTopCharactersDisplay([]);
        updateTesterCopyButton();
    } else {
        $("#cs-test-veto-result").text('No veto phrases matched.').css('color', 'var(--green)');

        const allMatches = findAllMatches(combined).sort((a, b) => a.matchIndex - b.matchIndex);
        allDetectionsList.empty();
        if (allMatches.length > 0) {
            allMatches.forEach(m => {
                const charPos = Number.isFinite(m.matchIndex) ? m.matchIndex + 1 : '?';
                allDetectionsList.append(`<li><b>${m.name}</b> <small>(${m.matchKind} @ ${charPos}, p:${m.priority})</small></li>`);
            });
        } else {
            allDetectionsList.html('<li class="cs-tester-list-placeholder">No detections found.</li>');
        }

        resetTesterMessageState();
        const simulationResult = simulateTesterStream(combined, tempProfile, bufKey);
        const events = Array.isArray(simulationResult?.events) ? simulationResult.events : [];
        renderTesterStream(streamList, events);
        const testerRoster = simulationResult?.finalState?.sceneRoster || [];
        const topCharacters = rankSceneCharacters(allMatches, { rosterSet: testerRoster });
        updateTesterTopCharactersDisplay(topCharacters);
        state.lastTesterReport = {
            ...reportBase,
            vetoed: false,
            vetoMatch: null,
            matches: allMatches.map(m => ({ ...m })),
            events: events.map(e => ({ ...e })),
            finalState: simulationResult?.finalState
                ? {
                    ...simulationResult.finalState,
                    sceneRoster: Array.isArray(simulationResult.finalState.sceneRoster)
                        ? [...simulationResult.finalState.sceneRoster]
                        : [],
                }
                : null,
            topCharacters: topCharacters.map(entry => ({
                name: entry.name,
                normalized: entry.normalized,
                count: entry.count,
                bestPriority: entry.bestPriority,
                inSceneRoster: entry.inSceneRoster,
                score: Number.isFinite(entry.score) ? Math.round(entry.score) : 0,
            })),
        };
        updateTesterCopyButton();
    }

    state.perMessageStates = originalPerMessageStates;
    state.perMessageBuffers = originalPerMessageBuffers;
    delete settings.profiles[tempProfileName];
    settings.activeProfile = originalProfileName;
    loadProfile(originalProfileName);
}

function wireUI() {
    const settings = getSettings();
    initTabNavigation();
    $(document).on('change', '#cs-enable', function() { settings.enabled = $(this).prop("checked"); persistSettings("Extension " + (settings.enabled ? "Enabled" : "Disabled"), 'info'); });
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
        const profile = getActiveProfile();
        if (!profile) return;
        Object.assign(profile, saveCurrentProfileData());
        persistSettings('Profile saved.');
        loadProfile(settings.activeProfile);
    });
    $(document).on('click', '#cs-profile-saveas', () => {
        const desiredName = normalizeProfileNameInput($("#cs-profile-name").val());
        if (!desiredName) { showStatus('Enter a name to save a new profile.', 'error'); return; }
        if (settings.profiles[desiredName]) { showStatus('A profile with that name already exists.', 'error'); return; }
        const profileData = Object.assign({}, structuredClone(PROFILE_DEFAULTS), saveCurrentProfileData());
        settings.profiles[desiredName] = profileData;
        settings.activeProfile = desiredName;
        populateProfileDropdown();
        loadProfile(desiredName);
        $("#cs-profile-name").val('');
        persistSettings(`Saved a new profile as "${escapeHtml(desiredName)}".`);
    });
    $(document).on('click', '#cs-profile-rename', () => {
        const newName = normalizeProfileNameInput($("#cs-profile-name").val());
        const oldName = settings.activeProfile;
        if (!newName) { showStatus('Enter a new name to rename this profile.', 'error'); return; }
        if (newName === oldName) { showStatus('The profile already uses that name.', 'info'); return; }
        if (settings.profiles[newName]) { showStatus('A profile with that name already exists.', 'error'); return; }
        settings.profiles[newName] = settings.profiles[oldName];
        delete settings.profiles[oldName];
        settings.activeProfile = newName;
        populateProfileDropdown();
        loadProfile(newName);
        $("#cs-profile-name").val('');
        persistSettings(`Renamed profile to "${escapeHtml(newName)}".`, 'info');
    });
    $(document).on('click', '#cs-profile-new', () => {
        const baseName = normalizeProfileNameInput($("#cs-profile-name").val()) || 'New Profile';
        const uniqueName = getUniqueProfileName(baseName);
        settings.profiles[uniqueName] = structuredClone(PROFILE_DEFAULTS);
        settings.activeProfile = uniqueName;
        populateProfileDropdown();
        loadProfile(uniqueName);
        $("#cs-profile-name").val('');
        persistSettings(`Created profile "${escapeHtml(uniqueName)}" from defaults.`, 'info');
    });
    $(document).on('click', '#cs-profile-duplicate', () => {
        const activeProfile = getActiveProfile();
        if (!activeProfile) return;
        const baseName = normalizeProfileNameInput($("#cs-profile-name").val()) || `${settings.activeProfile} Copy`;
        const uniqueName = getUniqueProfileName(baseName);
        settings.profiles[uniqueName] = Object.assign({}, structuredClone(PROFILE_DEFAULTS), structuredClone(activeProfile));
        settings.activeProfile = uniqueName;
        populateProfileDropdown();
        loadProfile(uniqueName);
        $("#cs-profile-name").val('');
        persistSettings(`Duplicated profile as "${escapeHtml(uniqueName)}".`, 'info');
    });
    $(document).on('click', '#cs-profile-delete', () => {
        if (Object.keys(settings.profiles).length <= 1) { showStatus("Cannot delete the last profile.", 'error'); return; }
        const profileNameToDelete = settings.activeProfile;
        if (confirm(`Are you sure you want to delete the profile "${profileNameToDelete}"?`)) {
            delete settings.profiles[profileNameToDelete];
            settings.activeProfile = Object.keys(settings.profiles)[0];
            populateProfileDropdown(); loadProfile(settings.activeProfile);
            $("#cs-profile-name").val('');
            persistSettings(`Deleted profile "${escapeHtml(profileNameToDelete)}".`);
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
                persistSettings(`Imported profile as "${escapeHtml(profileName)}".`);
            } catch (err) { showStatus(`Import failed: ${escapeHtml(err.message)}`, 'error'); }
        };
        reader.readAsText(file);
        $(this).val('');
    });
    $(document).on('change', '#cs-preset-select', function() {
        const presetKey = $(this).val();
        const descriptionEl = $("#cs-preset-description");
        if (presetKey && PRESETS[presetKey]) {
            descriptionEl.text(PRESETS[presetKey].description);
        } else {
            descriptionEl.text("Load a recommended configuration into the current profile.");
        }
    });
    $(document).on('click', '#cs-preset-load', () => {
        const presetKey = $("#cs-preset-select").val();
        if (!presetKey) {
            showStatus("Please select a preset first.", 'error');
            return;
        }
        const preset = PRESETS[presetKey];
        if (confirm(`This will apply the "${preset.name}" preset to your current profile ("${settings.activeProfile}").\n\nYour other settings like character patterns and mappings will be kept. Continue?`)) {
            const currentProfile = getActiveProfile();
            Object.assign(currentProfile, preset.settings);
            loadProfile(settings.activeProfile); // Reload UI to show changes
            persistSettings(`"${preset.name}" preset loaded.`);
        }
    });
    $(document).on('click', '#cs-focus-lock-toggle', async () => {
        if (settings.focusLock.character) {
            settings.focusLock.character = null;
            await manualReset();
        } else {
            const selectedChar = $("#cs-focus-lock-select").val();
            if (selectedChar) { settings.focusLock.character = selectedChar; await issueCostumeForName(selectedChar, { isLock: true }); }
        }
        updateFocusLockUI(); persistSettings("Focus lock " + (settings.focusLock.character ? "set." : "removed."), 'info');
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
    $(document).on('click', '#cs-regex-test-copy', copyTesterReport);
    $(document).on('click', '#cs-stats-log', logLastMessageStats);

    updateTesterCopyButton();

}

async function manualReset() {
    const profile = getActiveProfile();
    const costumeArg = profile?.defaultCostume?.trim() ? `\\${profile.defaultCostume.trim()}` : '\\';
    const command = `/costume ${costumeArg}`;
    debugLog("Attempting manual reset with command:", command);
    try {
        await executeSlashCommandsOnChatInput(command);
        state.lastIssuedCostume = profile?.defaultCostume?.trim() || '';
        showStatus(`Reset to <b>${escapeHtml(costumeArg)}</b>`, 'success');
    } catch (err) {
        showStatus(`Manual reset failed.`, 'error');
        console.error(`${logPrefix} Manual reset failed.`, err);
    }
}

function logLastMessageStats() {
    let lastMessageKey = getLastStatsMessageKey();

    if (!lastMessageKey) {
        const sessionKey = ensureSessionData()?.lastMessageKey;
        const normalizedSessionKey = normalizeMessageKey(sessionKey);
        if (normalizedSessionKey && state.messageStats.has(normalizedSessionKey)) {
            lastMessageKey = normalizedSessionKey;
        }
    }

    if (!lastMessageKey || !state.messageStats.has(lastMessageKey)) {
        const message = "No stats recorded for the last message.";
        showStatus(message, "info");
        console.log(`${logPrefix} ${message}`);
        return message;
    }

    const stats = state.messageStats.get(lastMessageKey);
    if (stats.size === 0) {
        const message = "No character mentions were detected in the last message.";
        showStatus(message, "info");
        console.log(`${logPrefix} ${message}`);
        return message;
    }

    let logOutput = "Character Mention Stats for Last Message:\n";
    logOutput += "========================================\n";
    const sortedStats = Array.from(stats.entries()).sort((a, b) => b[1] - a[1]);
    sortedStats.forEach(([name, count]) => {
        logOutput += `- ${name}: ${count} mentions\n`;
    });
    logOutput += "========================================";

    const ranking = state.topSceneRanking instanceof Map
        ? state.topSceneRanking.get(lastMessageKey)
        : null;
    logOutput += "\n\nTop Ranked Characters:\n";
    if (Array.isArray(ranking) && ranking.length) {
        ranking.slice(0, 4).forEach((entry, idx) => {
            const rosterTag = entry.inSceneRoster ? ' [scene roster]' : '';
            const scorePart = Number.isFinite(entry.score) ? ` (score ${Math.round(entry.score)})` : '';
            logOutput += `  ${idx + 1}. ${entry.name} – ${entry.count} detections${rosterTag}${scorePart}\n`;
        });
    } else {
        logOutput += '  (none)\n';
    }

    console.log(logOutput);
    showStatus("Last message stats logged to browser console (F12).", "success");
    return logOutput;
}

function normalizeMessageKey(value) {
    if (value == null) return null;
    const str = typeof value === 'string' ? value : String(value);
    const trimmed = str.trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^m?(\d+)$/i);
    if (match) return `m${match[1]}`;
    return trimmed;
}

function extractMessageIdFromKey(key) {
    const normalized = normalizeMessageKey(key);
    if (!normalized) return null;
    const match = normalized.match(/^m(\d+)$/);
    return match ? Number(match[1]) : null;
}

function parseMessageReference(input) {
    let key = null;
    let messageId = null;

    const commitKey = (candidate) => {
        const normalized = normalizeMessageKey(candidate);
        if (!normalized) return;
        if (!key) key = normalized;
        if (messageId == null) {
            const parsed = extractMessageIdFromKey(normalized);
            if (parsed != null) {
                messageId = parsed;
            }
        }
    };

    const commitId = (candidate) => {
        const num = Number(candidate);
        if (!Number.isFinite(num)) return;
        if (messageId == null) messageId = num;
        if (!key) key = `m${num}`;
    };

    if (input == null) {
        return { key: null, messageId: null };
    }

    if (typeof input === 'number') {
        commitId(input);
    } else if (typeof input === 'string') {
        commitKey(input);
    } else if (typeof input === 'object') {
        if (Number.isFinite(input.messageId)) commitId(input.messageId);
        if (Number.isFinite(input.mesId)) commitId(input.mesId);
        if (Number.isFinite(input.id)) commitId(input.id);
        if (typeof input.messageId === 'string') commitKey(input.messageId);
        if (typeof input.mesId === 'string') commitKey(input.mesId);
        if (typeof input.id === 'string') commitKey(input.id);
        if (typeof input.key === 'string') commitKey(input.key);
        if (typeof input.bufKey === 'string') commitKey(input.bufKey);
        if (typeof input.messageKey === 'string') commitKey(input.messageKey);
        if (typeof input.generationType === 'string') commitKey(input.generationType);
        if (typeof input.message === 'object' && input.message !== null) {
            const nested = parseMessageReference(input.message);
            if (!key && nested.key) key = nested.key;
            if (messageId == null && nested.messageId != null) messageId = nested.messageId;
        }
    }

    if (!key && messageId != null) {
        key = `m${messageId}`;
    } else if (key && messageId == null) {
        const parsed = extractMessageIdFromKey(key);
        if (parsed != null) messageId = parsed;
    }

    return { key, messageId };
}

function findExistingMessageKey(preferredKey, messageId) {
    const seen = new Set();
    const candidates = [];
    const addCandidate = (value) => {
        const normalized = normalizeMessageKey(value);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        candidates.push(normalized);
    };

    addCandidate(preferredKey);
    if (Number.isFinite(messageId)) {
        addCandidate(`m${messageId}`);
    }
    addCandidate(state.currentGenerationKey);

    for (const candidate of candidates) {
        if (state.perMessageBuffers.has(candidate)) {
            return candidate;
        }
    }
    for (const candidate of candidates) {
        if (state.perMessageStates.has(candidate)) {
            return candidate;
        }
    }

    return candidates[0] || null;
}

function summarizeMatches(matches) {
    const stats = new Map();
    matches.forEach((match) => {
        const normalizedName = normalizeCostumeName(match.name);
        if (!normalizedName) return;
        stats.set(normalizedName, (stats.get(normalizedName) || 0) + 1);
    });
    return stats;
}

function updateMessageAnalytics(bufKey, text, { rosterSet, updateSession = true, assumeNormalized = false } = {}) {
    if (!bufKey) {
        return { stats: new Map(), ranking: [] };
    }

    if (!(state.messageStats instanceof Map)) {
        state.messageStats = new Map();
    }

    if (!(state.topSceneRanking instanceof Map)) {
        state.topSceneRanking = new Map();
    }

    const normalizedText = typeof text === 'string' ? (assumeNormalized ? text : normalizeStreamText(text)) : '';
    const matches = normalizedText ? findAllMatches(normalizedText) : [];
    const stats = summarizeMatches(matches);

    state.messageStats.set(bufKey, stats);

    const ranking = rankSceneCharacters(matches, { rosterSet });
    state.topSceneRanking.set(bufKey, ranking);

    if (updateSession !== false) {
        updateSessionTopCharacters(bufKey, ranking);
    }

    return { stats, ranking, matches };
}

function calculateFinalMessageStats(reference) {
    const { key: requestedKey, messageId } = parseMessageReference(reference);
    const bufKey = findExistingMessageKey(requestedKey, messageId);

    if (!bufKey) {
        debugLog("Could not resolve message key to calculate stats for:", reference);
        return;
    }

    const resolvedMessageId = Number.isFinite(messageId) ? messageId : extractMessageIdFromKey(bufKey);

    let fullText = state.perMessageBuffers.get(bufKey);
    if (!fullText && requestedKey && requestedKey !== bufKey && state.perMessageBuffers.has(requestedKey)) {
        fullText = state.perMessageBuffers.get(requestedKey);
    }

    if (!fullText) {
        debugLog("Could not find message buffer to calculate stats for:", bufKey);
        const { chat } = getContext();
        if (!Number.isFinite(resolvedMessageId)) {
            debugLog("No valid message id available to fall back to chat context for key:", bufKey);
            return;
        }

        const message = chat.find(m => m.mesId === resolvedMessageId);
        if (!message || !message.mes) return;
        fullText = normalizeStreamText(message.mes);
    }

    const msgState = state.perMessageStates.get(bufKey);
    const rosterSet = msgState?.sceneRoster instanceof Set ? msgState.sceneRoster : null;
    updateMessageAnalytics(bufKey, fullText, { rosterSet, assumeNormalized: true });

    debugLog("Final stats calculated for", bufKey, state.messageStats.get(bufKey));
}


// ======================================================================
// SLASH COMMANDS
// ======================================================================
function registerCommands() {
    const emptyTopCharactersMessage = 'No character detections available for the last message.';

    const getTopCharacterNamesString = (count = 4) => {
        const ranking = getLastTopCharacters(count);
        if (!ranking.length) {
            return '';
        }
        return ranking.map(entry => entry.name).join(', ');
    };

    registerSlashCommand("cs-addchar", (args) => {
        const profile = getActiveProfile();
        const name = String(args?.join(' ') ?? '').trim();
        if (profile && name) {
            profile.patterns.push(name);
            recompileRegexes();
            showStatus(`Added "<b>${escapeHtml(name)}</b>" to patterns for this session.`, 'success');
        } else if (profile) {
            showStatus('Please provide a character name to add.', 'error');
        }
    }, ["char"], "Adds a character to the current profile's pattern list for this session.", true);

    registerSlashCommand("cs-ignore", (args) => {
        const profile = getActiveProfile();
        const name = String(args?.join(' ') ?? '').trim();
        if (profile && name) {
            profile.ignorePatterns.push(name);
            recompileRegexes();
            showStatus(`Ignoring "<b>${escapeHtml(name)}</b>" for this session.`, 'success');
        } else if (profile) {
            showStatus('Please provide a character name to ignore.', 'error');
        }
    }, ["char"], "Adds a character to the current profile's ignore list for this session.", true);

    registerSlashCommand("cs-map", (args) => {
        const profile = getActiveProfile();
        const toIndex = args.map(arg => arg.toLowerCase()).indexOf('to');

        if (profile && toIndex > 0 && toIndex < args.length - 1) {
            const alias = args.slice(0, toIndex).join(' ').trim();
            const folder = args.slice(toIndex + 1).join(' ').trim();
            
            if (alias && folder) {
                profile.mappings.push({ name: alias, folder: folder });
                showStatus(`Mapped "<b>${escapeHtml(alias)}</b>" to "<b>${escapeHtml(folder)}</b>" for this session.`, 'success');
            } else {
                showStatus('Invalid format. Use /cs-map (alias) to (folder).', 'error');
            }
        } else {
            showStatus('Invalid format. Use /cs-map (alias) to (folder).', 'error');
        }
    }, ["alias", "to", "folder"], "Maps a character alias to a costume folder for this session. Use 'to' to separate.", true);
    
    registerSlashCommand("cs-stats", () => {
        return logLastMessageStats();
    }, [], "Logs mention statistics for the last generated message to the console.", true);

    registerSlashCommand("cs-top", (args) => {
        const desired = Number(args?.[0]);
        const count = clampTopCount(Number.isFinite(desired) ? desired : 4);
        const names = getTopCharacterNamesString(count);
        const message = names || emptyTopCharactersMessage;
        console.log(`${logPrefix} ${message}`);
        return names || message;
    }, ["count?"], "Returns a comma-separated list of the top detected characters from the last message (1-4) and logs the result to the console.", true);

    [1, 2, 3, 4].forEach((num) => {
        registerSlashCommand(`cs-top${num}`, () => {
            const names = getTopCharacterNamesString(num);
            return names || emptyTopCharactersMessage;
        }, [], `Shortcut for the top ${num} detected character${num > 1 ? 's' : ''} from the last message.`, true);
    });
}

// ======================================================================
// EVENT HANDLERS
// ======================================================================

function createMessageState(profile, bufKey) {
    if (!profile || !bufKey) return null;

    const oldState = state.perMessageStates.size > 0 ? Array.from(state.perMessageStates.values()).pop() : null;

    const newState = {
        lastAcceptedName: null,
        lastAcceptedTs: 0,
        vetoed: false,
        lastSubject: oldState?.lastSubject || null,
        sceneRoster: new Set(oldState?.sceneRoster || []),
        rosterTTL: profile.sceneRosterTTL,
        processedLength: 0,
    };

    if (newState.sceneRoster.size > 0) {
        newState.rosterTTL--;
        if (newState.rosterTTL <= 0) {
            debugLog("Scene roster TTL expired, clearing roster.");
            newState.sceneRoster.clear();
        }
    }

    state.perMessageStates.set(bufKey, newState);
    state.perMessageBuffers.set(bufKey, '');

    return newState;
}

function remapMessageKey(oldKey, newKey) {
    if (!oldKey || !newKey || oldKey === newKey) return;

    const moveEntry = (map) => {
        if (!(map instanceof Map) || !map.has(oldKey)) return;
        const value = map.get(oldKey);
        map.delete(oldKey);
        map.set(newKey, value);
    };

    moveEntry(state.perMessageBuffers);
    moveEntry(state.perMessageStates);
    moveEntry(state.messageStats);

    if (state.topSceneRanking instanceof Map) {
        moveEntry(state.topSceneRanking);
    }

    if (state.latestTopRanking?.bufKey === oldKey) {
        state.latestTopRanking.bufKey = newKey;
    }

    const settings = getSettings?.();
    if (settings?.session && settings.session.lastMessageKey === oldKey) {
        settings.session.lastMessageKey = newKey;
    }

    debugLog(`Remapped message data from ${oldKey} to ${newKey}.`);
}

const handleGenerationStart = (...args) => {
    let bufKey = null;
    for (const arg of args) {
        if (typeof arg === 'string' && arg.trim().length) {
            bufKey = arg.trim();
            break;
        }
        if (typeof arg === 'number' && Number.isFinite(arg)) {
            bufKey = `m${arg}`;
            break;
        }
        if (arg && typeof arg === 'object') {
            if (typeof arg.generationType === 'string' && arg.generationType.trim().length) {
                bufKey = arg.generationType.trim();
                break;
            }
            if (typeof arg.messageId === 'number' && Number.isFinite(arg.messageId)) {
                bufKey = `m${arg.messageId}`;
                break;
            }
            if (typeof arg.key === 'string' && arg.key.trim().length) {
                bufKey = arg.key.trim();
                break;
            }
        }
    }

    if (!bufKey) {
        bufKey = 'live';
    }

    state.currentGenerationKey = bufKey;
    debugLog(`Generation started for ${bufKey}, resetting state.`);

    const profile = getActiveProfile();
    if (profile) {
        createMessageState(profile, bufKey);
    } else {
        state.perMessageStates.delete(bufKey);
        state.perMessageBuffers.set(bufKey, '');
    }
};

const handleStream = (...args) => {
    try {
        const settings = getSettings();
        if (!settings.enabled || settings.focusLock.character) return;
        const profile = getActiveProfile();
        if (!profile) return;

        let tokenText = "";
        if (typeof args[0] === 'number') { tokenText = String(args[1] ?? ""); }
        else if (typeof args[0] === 'object') { tokenText = String(args[0].token ?? args[0].text ?? ""); }
        else { tokenText = String(args.join(' ') || ""); }
        if (!tokenText) return;

        const bufKey = state.currentGenerationKey;
        if (!bufKey) return;

        let msgState = state.perMessageStates.get(bufKey);
        if (!msgState) {
            msgState = createMessageState(profile, bufKey);
        }
        if (!msgState) return;

        if (msgState.vetoed) return;

        const prev = state.perMessageBuffers.get(bufKey) || "";
        const maxBuffer = resolveMaxBufferChars(profile);
        const combined = (prev + normalizeStreamText(tokenText)).slice(-maxBuffer);
        state.perMessageBuffers.set(bufKey, combined);

        const rosterSet = msgState?.sceneRoster instanceof Set ? msgState.sceneRoster : null;
        const analytics = updateMessageAnalytics(bufKey, combined, { rosterSet, assumeNormalized: true });

        if (combined.length < msgState.processedLength + profile.tokenProcessThreshold) {
            return;
        }

        msgState.processedLength = combined.length;
        const bestMatch = findBestMatch(combined, analytics?.matches);
        debugLog(`[STREAM] Buffer len: ${combined.length}. Match:`, bestMatch ? `${bestMatch.name} (${bestMatch.matchKind})` : 'None');

        if (state.compiledRegexes.vetoRegex && state.compiledRegexes.vetoRegex.test(combined)) {
            debugLog("Veto phrase matched. Halting detection for this message.");
            msgState.vetoed = true; return;
        }

        if (bestMatch) {
            const { name: matchedName, matchKind } = bestMatch;
            const now = Date.now();
            const suppressMs = profile.repeatSuppressMs;

            if (profile.enableSceneRoster) {
                msgState.sceneRoster.add(matchedName.toLowerCase());
                msgState.rosterTTL = profile.sceneRosterTTL;
            }
            if (matchKind !== 'pronoun') {
                msgState.lastSubject = matchedName;
            }
            
            if (msgState.lastAcceptedName?.toLowerCase() === matchedName.toLowerCase() && (now - msgState.lastAcceptedTs < suppressMs)) {
                return;
            }
            
            msgState.lastAcceptedName = matchedName;
            msgState.lastAcceptedTs = now;
            issueCostumeForName(matchedName, { matchKind, bufKey });
        }
    } catch (err) { console.error(`${logPrefix} stream handler error:`, err); }
};

const handleMessageRendered = (...args) => {
    const tempKey = state.currentGenerationKey;
    let resolvedKey = null;
    let resolvedId = null;

    const mergeReference = (value) => {
        const parsed = parseMessageReference(value);
        if (!resolvedKey && parsed.key) {
            resolvedKey = parsed.key;
        }
        if (resolvedId == null && Number.isFinite(parsed.messageId)) {
            resolvedId = parsed.messageId;
        }
    };

    args.forEach(arg => mergeReference(arg));

    if (!resolvedKey && tempKey) {
        mergeReference(tempKey);
    }

    if (!resolvedKey && Number.isFinite(resolvedId)) {
        resolvedKey = `m${resolvedId}`;
    }

    if (tempKey && resolvedKey && tempKey !== resolvedKey) {
        remapMessageKey(tempKey, resolvedKey);
    }

    const finalKey = resolvedKey || tempKey;
    if (!finalKey) {
        debugLog('Message rendered without a resolvable key.', args);
        state.currentGenerationKey = null;
        return;
    }

    debugLog(`Message ${finalKey} rendered, calculating final stats from buffer.`);
    calculateFinalMessageStats({ key: finalKey, messageId: resolvedId });
    state.currentGenerationKey = null;
};

const resetGlobalState = () => {
    if (state.statusTimer) {
        clearTimeout(state.statusTimer);
        state.statusTimer = null;
    }
    if (Array.isArray(state.testerTimers)) {
        state.testerTimers.forEach(clearTimeout);
        state.testerTimers.length = 0;
    }
    state.lastTesterReport = null;
    updateTesterCopyButton();
    Object.assign(state, {
        lastIssuedCostume: null,
        lastSwitchTimestamp: 0,
        lastTriggerTimes: new Map(),
        failedTriggerTimes: new Map(),
        perMessageBuffers: new Map(),
        perMessageStates: new Map(),
        messageStats: new Map(),
        topSceneRanking: new Map(),
        latestTopRanking: { bufKey: null, ranking: [], fullRanking: [], updatedAt: Date.now() },
        currentGenerationKey: null,
    });
    clearSessionTopCharacters();
};

function load() {
    state.eventHandlers = {};
    const registered = new Set();
    const registerHandler = (eventType, handler) => {
        if (typeof eventType !== 'string' || typeof handler !== 'function' || registered.has(eventType)) {
            return;
        }
        registered.add(eventType);
        state.eventHandlers[eventType] = handler;
        eventSource.on(eventType, handler);
    };

    registerHandler(event_types?.STREAM_TOKEN_RECEIVED, handleStream);
    registerHandler(event_types?.GENERATION_STARTED, handleGenerationStart);

    const renderEvents = [
        event_types?.CHARACTER_MESSAGE_RENDERED,
        event_types?.MESSAGE_RENDERED,
        event_types?.GENERATION_ENDED,
        event_types?.STREAM_ENDED,
        event_types?.STREAM_FINISHED,
        event_types?.STREAM_COMPLETE,
    ].filter((evt) => typeof evt === 'string');

    renderEvents.forEach((evt) => registerHandler(evt, handleMessageRendered));

    registerHandler(event_types?.CHAT_CHANGED, resetGlobalState);
}

function unload() {
    if (state.eventHandlers && typeof state.eventHandlers === 'object') {
        for (const [event, handler] of Object.entries(state.eventHandlers)) {
            eventSource.off(event, handler);
        }
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

    const sessionDefaults = {
        topCharacters: [],
        topCharactersNormalized: [],
        topCharactersString: '',
        topCharacterDetails: [],
        lastMessageKey: null,
        lastUpdated: 0,
    };
    if (typeof storeSource[extensionName].session !== 'object' || storeSource[extensionName].session === null) {
        storeSource[extensionName].session = { ...sessionDefaults };
    } else {
        storeSource[extensionName].session = Object.assign({}, sessionDefaults, storeSource[extensionName].session);
    }

    return { store: storeSource, save: ctx.saveSettingsDebounced, ctx };
}

jQuery(async () => {
    try {
        const { store } = getSettingsObj();
        extension_settings[extensionName] = store[extensionName];

        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);

        const buildMeta = await fetchBuildMetadata();
        renderBuildMetadata(buildMeta);

        populateProfileDropdown();
        populatePresetDropdown();
        loadProfile(getSettings().activeProfile);
        wireUI();
        registerCommands();
        load();

        window[`__${extensionName}_unload`] = unload;
        console.log(`${logPrefix} ${buildMeta?.label || 'dev build'} loaded successfully.`);
    } catch (error) {
        console.error(`${logPrefix} failed to initialize:`, error);
        alert(`Failed to initialize Costume Switcher. Check console (F12) for details.`);
    }
});
