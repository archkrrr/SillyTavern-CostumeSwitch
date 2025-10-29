import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, event_types, eventSource } from "../../../../script.js";
import { executeSlashCommandsOnChatInput, registerSlashCommand } from "../../../slash-commands.js";
import {
    DEFAULT_ACTION_VERBS,
    DEFAULT_ATTRIBUTION_VERBS,
    EXTENDED_ACTION_VERBS,
    EXTENDED_ATTRIBUTION_VERBS,
} from "./verbs.js";

const extensionName = "SillyTavern-CostumeSwitch-Testing";
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

const SCORE_WEIGHT_KEYS = [
    'prioritySpeakerWeight',
    'priorityAttributionWeight',
    'priorityActionWeight',
    'priorityPronounWeight',
    'priorityVocativeWeight',
    'priorityPossessiveWeight',
    'priorityNameWeight',
    'rosterBonus',
    'rosterPriorityDropoff',
    'distancePenaltyWeight',
];

const SCORE_WEIGHT_LABELS = {
    prioritySpeakerWeight: 'Speaker',
    priorityAttributionWeight: 'Attribution',
    priorityActionWeight: 'Action',
    priorityPronounWeight: 'Pronoun',
    priorityVocativeWeight: 'Vocative',
    priorityPossessiveWeight: 'Possessive',
    priorityNameWeight: 'General Name',
    rosterBonus: 'Roster Bonus',
    rosterPriorityDropoff: 'Roster Drop-off',
    distancePenaltyWeight: 'Distance Penalty',
};

const DEFAULT_SCORE_PRESETS = {
    'Balanced Baseline': {
        description: 'Matches the default scoring behaviour with a steady roster bonus.',
        builtIn: true,
        weights: {
            prioritySpeakerWeight: 5,
            priorityAttributionWeight: 4,
            priorityActionWeight: 3,
            priorityPronounWeight: 2,
            priorityVocativeWeight: 2,
            priorityPossessiveWeight: 1,
            priorityNameWeight: 0,
            rosterBonus: 150,
            rosterPriorityDropoff: 0.5,
            distancePenaltyWeight: 1,
        },
    },
    'Dialogue Spotlight': {
        description: 'Favors explicit dialogue cues and attribution-heavy scenes.',
        builtIn: true,
        weights: {
            prioritySpeakerWeight: 6,
            priorityAttributionWeight: 5,
            priorityActionWeight: 2.5,
            priorityPronounWeight: 1.5,
            priorityVocativeWeight: 2.5,
            priorityPossessiveWeight: 1,
            priorityNameWeight: 0,
            rosterBonus: 140,
            rosterPriorityDropoff: 0.35,
            distancePenaltyWeight: 1.1,
        },
    },
    'Action Tracker': {
        description: 'Boosts action verbs and keeps recent actors in the roster for fast scenes.',
        builtIn: true,
        weights: {
            prioritySpeakerWeight: 4.5,
            priorityAttributionWeight: 3.5,
            priorityActionWeight: 4,
            priorityPronounWeight: 2.5,
            priorityVocativeWeight: 2,
            priorityPossessiveWeight: 1.5,
            priorityNameWeight: 0.5,
            rosterBonus: 170,
            rosterPriorityDropoff: 0.25,
            distancePenaltyWeight: 0.8,
        },
    },
    'Pronoun Guardian': {
        description: 'Keeps pronoun hand-offs sticky and penalizes distant matches more heavily.',
        builtIn: true,
        weights: {
            prioritySpeakerWeight: 4.5,
            priorityAttributionWeight: 3.5,
            priorityActionWeight: 3,
            priorityPronounWeight: 3.5,
            priorityVocativeWeight: 2,
            priorityPossessiveWeight: 1.2,
            priorityNameWeight: 0,
            rosterBonus: 160,
            rosterPriorityDropoff: 0.4,
            distancePenaltyWeight: 1.4,
        },
    },
};

const BUILTIN_SCORE_PRESET_KEYS = new Set(Object.keys(DEFAULT_SCORE_PRESETS));

const DEFAULT_PRONOUNS = ['he', 'she', 'they'];

const EXTENDED_PRONOUNS = [
    'thee', 'thou', 'thy', 'thine', 'yon', 'ye',
    'xe', 'xem', 'xyr', 'xyrs', 'xemself', 'ze', 'zir', 'zirs', 'zirself',
    'zie', 'zim', 'zir', 'zirself', 'sie', 'hir', 'hirs', 'hirself',
    'ey', 'em', 'eir', 'eirs', 'eirself', 'ae', 'aer', 'aers', 'aerself',
    'fae', 'faer', 'faers', 'faerself', 've', 'ver', 'vis', 'verself',
    'ne', 'nem', 'nir', 'nirs', 'nirself', 'per', 'pers', 'perself',
    'ya', "ya'll", 'y\'all', 'yer', 'yourselves',
    'watashi', 'boku', 'ore', 'anata', 'kanojo', 'kare',
    'zie', 'zir', 'it', 'its', 'someone', 'something',
];

const COVERAGE_TOKEN_REGEX = /[\p{L}\p{M}']+/gu;

const UNICODE_WORD_PATTERN = '[\\p{L}\\p{M}\\p{N}_]';
const WORD_CHAR_REGEX = /[\\p{L}\\p{M}\\p{N}]/u;

const QUOTE_PAIRS = [
    { open: '"', close: '"', symmetric: true },
    { open: '＂', close: '＂', symmetric: true },
    { open: '“', close: '”' },
    { open: '„', close: '”' },
    { open: '‟', close: '”' },
    { open: '«', close: '»' },
    { open: '‹', close: '›' },
    { open: '「', close: '」' },
    { open: '『', close: '』' },
    { open: '｢', close: '｣' },
    { open: '《', close: '》' },
    { open: '〈', close: '〉' },
    { open: '﹁', close: '﹂' },
    { open: '﹃', close: '﹄' },
    { open: '〝', close: '〞' },
    { open: '‘', close: '’' },
    { open: '‚', close: '’' },
    { open: '‛', close: '’' },
    { open: '\'', close: '\'', symmetric: true, apostropheSensitive: true },
];

const QUOTE_OPENERS = new Map();
const QUOTE_CLOSERS = new Map();

for (const pair of QUOTE_PAIRS) {
    const info = {
        close: pair.close,
        symmetric: Boolean(pair.symmetric),
        apostropheSensitive: Boolean(pair.apostropheSensitive),
    };
    QUOTE_OPENERS.set(pair.open, info);
    if (info.symmetric) {
        continue;
    }
    if (!QUOTE_CLOSERS.has(pair.close)) {
        QUOTE_CLOSERS.set(pair.close, []);
    }
    QUOTE_CLOSERS.get(pair.close).push(pair.open);
}


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
    pronounVocabulary: [...DEFAULT_PRONOUNS],
    attributionVerbs: [...DEFAULT_ATTRIBUTION_VERBS],
    actionVerbs: [...DEFAULT_ACTION_VERBS],
    detectionBias: 0,
    enableSceneRoster: true,
    sceneRosterTTL: 5,
    prioritySpeakerWeight: 5,
    priorityAttributionWeight: 4,
    priorityActionWeight: 3,
    priorityPronounWeight: 2,
    priorityVocativeWeight: 2,
    priorityPossessiveWeight: 1,
    priorityNameWeight: 0,
    rosterBonus: 150,
    rosterPriorityDropoff: 0.5,
    distancePenaltyWeight: 1,
};

const KNOWN_PRONOUNS = new Set([
    ...DEFAULT_PRONOUNS,
    ...EXTENDED_PRONOUNS,
    ...PROFILE_DEFAULTS.pronounVocabulary,
].map(value => String(value).toLowerCase()));

const KNOWN_ATTRIBUTION_VERBS = new Set([
    ...PROFILE_DEFAULTS.attributionVerbs,
    ...EXTENDED_ATTRIBUTION_VERBS,
].map(value => String(value).toLowerCase()));

const KNOWN_ACTION_VERBS = new Set([
    ...PROFILE_DEFAULTS.actionVerbs,
    ...EXTENDED_ACTION_VERBS,
].map(value => String(value).toLowerCase()));

const DEFAULTS = {
    enabled: true,
    profiles: {
        'Default': structuredClone(PROFILE_DEFAULTS),
    },
    activeProfile: 'Default',
    scorePresets: structuredClone(DEFAULT_SCORE_PRESETS),
    activeScorePreset: 'Balanced Baseline',
    focusLock: { character: null },
};

// ======================================================================
// GLOBAL STATE
// ======================================================================
const MAX_TRACKED_MESSAGES = 24;

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
    mappingLookup: new Map(),
    messageKeyQueue: [],
    activeScorePresetKey: null,
    coverageDiagnostics: null,
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

function ensureMessageQueue() {
    if (!Array.isArray(state.messageKeyQueue)) {
        state.messageKeyQueue = [];
    }
    return state.messageKeyQueue;
}

function trackMessageKey(key) {
    const normalized = normalizeMessageKey(key);
    if (!normalized) return;
    const queue = ensureMessageQueue();
    const existingIndex = queue.indexOf(normalized);
    if (existingIndex !== -1) {
        queue.splice(existingIndex, 1);
    }
    queue.push(normalized);
}

function replaceTrackedMessageKey(oldKey, newKey) {
    const normalizedOld = normalizeMessageKey(oldKey);
    const normalizedNew = normalizeMessageKey(newKey);
    if (!normalizedNew) return;
    const queue = ensureMessageQueue();
    if (normalizedOld) {
        const index = queue.indexOf(normalizedOld);
        if (index !== -1) {
            queue[index] = normalizedNew;
            for (let i = queue.length - 1; i >= 0; i -= 1) {
                if (i !== index && queue[i] === normalizedNew) {
                    queue.splice(i, 1);
                }
            }
            return;
        }
    }
    trackMessageKey(normalizedNew);
}

function pruneMessageCaches(limit = MAX_TRACKED_MESSAGES) {
    const queue = ensureMessageQueue();
    const maxEntries = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_TRACKED_MESSAGES;
    while (queue.length > maxEntries) {
        const oldest = queue.shift();
        if (!oldest) continue;
        state.perMessageBuffers?.delete(oldest);
        state.perMessageStates?.delete(oldest);
        state.messageStats?.delete(oldest);
        if (state.topSceneRanking instanceof Map) {
            state.topSceneRanking.delete(oldest);
        }
    }
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
function buildRegex(patternList, template, options = {}) {
    const entries = (patternList || []).map(parsePatternEntry).filter(Boolean);
    if (!entries.length) return null;
    const parts = entries.map(e => `(?:${e.body})`);
    const combinedBody = parts.join('|');
    const finalBody = template.replace('{{PATTERNS}}', combinedBody);
    let finalFlags = computeFlags(entries, options.requireI !== false);
    if (options.extraFlags) {
        for (const flag of options.extraFlags) {
            if (flag && !finalFlags.includes(flag)) {
                finalFlags += flag;
            }
        }
    }
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
    if (!s) return [];
    const ranges = [];
    const stack = [];

    const isLikelyApostrophe = (index) => {
        if (index < 0 || index >= s.length) return false;
        const prev = index > 0 ? s[index - 1] : '';
        const next = index + 1 < s.length ? s[index + 1] : '';
        return WORD_CHAR_REGEX.test(prev) && WORD_CHAR_REGEX.test(next);
    };

    for (let i = 0; i < s.length; i += 1) {
        const ch = s[i];
        const openerInfo = QUOTE_OPENERS.get(ch);
        if (openerInfo) {
            if (openerInfo.symmetric) {
                if (openerInfo.apostropheSensitive && isLikelyApostrophe(i)) {
                    continue;
                }
                const top = stack[stack.length - 1];
                if (top && top.open === ch && top.symmetric) {
                    stack.pop();
                    ranges.push([top.index, i]);
                } else {
                    stack.push({ open: ch, close: openerInfo.close, index: i, symmetric: true, apostropheSensitive: openerInfo.apostropheSensitive });
                }
                continue;
            }
            stack.push({ open: ch, close: openerInfo.close, index: i, symmetric: false });
            continue;
        }

        const closeCandidates = QUOTE_CLOSERS.get(ch);
        if (closeCandidates && stack.length) {
            for (let j = stack.length - 1; j >= 0; j -= 1) {
                const candidate = stack[j];
                if (!candidate.symmetric && candidate.close === ch && closeCandidates.includes(candidate.open)) {
                    stack.splice(j, 1);
                    ranges.push([candidate.index, i]);
                    break;
                }
            }
            continue;
        }

        const top = stack[stack.length - 1];
        if (top && top.symmetric && ch === top.close) {
            stack.pop();
            ranges.push([top.index, i]);
        }
    }

    return ranges.sort((a, b) => a[0] - b[0]);
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

const PRIORITY_FIELD_MAP = {
    speaker: 'prioritySpeakerWeight',
    attribution: 'priorityAttributionWeight',
    action: 'priorityActionWeight',
    pronoun: 'priorityPronounWeight',
    vocative: 'priorityVocativeWeight',
    possessive: 'priorityPossessiveWeight',
    name: 'priorityNameWeight',
};

function getPriorityWeights(profile) {
    const weights = {};
    for (const [key, field] of Object.entries(PRIORITY_FIELD_MAP)) {
        weights[key] = resolveNumericSetting(profile?.[field], PROFILE_DEFAULTS[field]);
    }
    return weights;
}

function findAllMatches(combined) {
    const allMatches = [];
    const profile = getActiveProfile();
    const { compiledRegexes } = state;
    if (!profile || !combined) return allMatches;

    const quoteRanges = getQuoteRanges(combined);
    const priorities = getPriorityWeights(profile);

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

    const scoringOptions = {
        rosterSet,
        rosterBonus: resolveNumericSetting(profile?.rosterBonus, PROFILE_DEFAULTS.rosterBonus),
        rosterPriorityDropoff: resolveNumericSetting(profile?.rosterPriorityDropoff, PROFILE_DEFAULTS.rosterPriorityDropoff),
        distancePenaltyWeight: resolveNumericSetting(profile?.distancePenaltyWeight, PROFILE_DEFAULTS.distancePenaltyWeight),
        priorityMultiplier: 100,
    };

    return getWinner(allMatches, profile.detectionBias, combined.length, scoringOptions);
}

function getWinner(matches, bias = 0, textLength = 0, options = {}) {
    const rosterSet = options?.rosterSet instanceof Set ? options.rosterSet : null;
    const rosterBonus = Number.isFinite(options?.rosterBonus) ? options.rosterBonus : 150;
    const rosterPriorityDropoff = Number.isFinite(options?.rosterPriorityDropoff)
        ? options.rosterPriorityDropoff
        : 0.5;
    const distancePenaltyWeight = Number.isFinite(options?.distancePenaltyWeight)
        ? options.distancePenaltyWeight
        : 1;
    const priorityMultiplier = Number.isFinite(options?.priorityMultiplier)
        ? options.priorityMultiplier
        : 100;
    const scoredMatches = matches.map(match => {
        const isActive = match.priority >= 3; // speaker, attribution, action
        const distanceFromEnd = Number.isFinite(textLength)
            ? Math.max(0, textLength - match.matchIndex)
            : 0;
        const baseScore = match.priority * priorityMultiplier - distancePenaltyWeight * distanceFromEnd;
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

    const profile = options?.profile || getActiveProfile();
    const distancePenaltyWeight = Number.isFinite(options?.distancePenaltyWeight)
        ? options.distancePenaltyWeight
        : resolveNumericSetting(profile?.distancePenaltyWeight, PROFILE_DEFAULTS.distancePenaltyWeight);
    const rosterBonusWeight = Number.isFinite(options?.rosterBonus)
        ? options.rosterBonus
        : resolveNumericSetting(profile?.rosterBonus, PROFILE_DEFAULTS.rosterBonus);
    const countWeight = Number.isFinite(options?.countWeight) ? options.countWeight : 1000;
    const priorityMultiplier = Number.isFinite(options?.priorityMultiplier) ? options.priorityMultiplier : 100;

    const ranked = Array.from(summary.values()).map((entry) => {
        const priorityScore = Number.isFinite(entry.bestPriority) ? entry.bestPriority : 0;
        const earliest = Number.isFinite(entry.earliest) ? entry.earliest : Number.MAX_SAFE_INTEGER;
        const rosterBonus = entry.inSceneRoster ? rosterBonusWeight : 0;
        const earliestPenalty = earliest * distancePenaltyWeight;
        const score = entry.count * countWeight + priorityScore * priorityMultiplier + rosterBonus - earliestPenalty;
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

function scoreMatchesDetailed(matches, textLength, options = {}) {
    if (!Array.isArray(matches) || matches.length === 0) {
        return [];
    }

    const profile = options.profile || getActiveProfile();
    const detectionBias = Number(profile?.detectionBias) || 0;
    const priorityMultiplier = Number.isFinite(options?.priorityMultiplier) ? options.priorityMultiplier : 100;
    const rosterBonus = resolveNumericSetting(options?.rosterBonus, PROFILE_DEFAULTS.rosterBonus);
    const rosterPriorityDropoff = resolveNumericSetting(options?.rosterPriorityDropoff, PROFILE_DEFAULTS.rosterPriorityDropoff);
    const distancePenaltyWeight = resolveNumericSetting(options?.distancePenaltyWeight, PROFILE_DEFAULTS.distancePenaltyWeight);
    const rosterSet = buildLowercaseSet(options?.rosterSet);

    const scored = matches.map((match, idx) => {
        const priority = Number(match?.priority) || 0;
        const matchIndex = Number.isFinite(match?.matchIndex) ? match.matchIndex : idx;
        const distanceFromEnd = Number.isFinite(textLength) ? Math.max(0, textLength - matchIndex) : 0;
        const priorityScore = priority * priorityMultiplier;
        const biasBonus = priority >= 3 ? detectionBias : 0;
        let rosterBonusApplied = 0;
        let inRoster = false;
        if (rosterSet) {
            const normalized = String(match?.name || '').toLowerCase();
            if (normalized && rosterSet.has(normalized)) {
                inRoster = true;
                let bonus = rosterBonus;
                if (priority >= 3 && rosterPriorityDropoff > 0) {
                    const dropoffMultiplier = 1 - rosterPriorityDropoff * (priority - 2);
                    bonus *= Math.max(0, dropoffMultiplier);
                }
                rosterBonusApplied = bonus;
            }
        }
        const distancePenalty = distancePenaltyWeight * distanceFromEnd;
        const totalScore = priorityScore + biasBonus + rosterBonusApplied - distancePenalty;
        return {
            name: match?.name || '(unknown)',
            matchKind: match?.matchKind || 'unknown',
            priority,
            priorityScore,
            biasBonus,
            rosterBonus: rosterBonusApplied,
            distancePenalty,
            totalScore,
            matchIndex,
            charIndex: matchIndex,
            inRoster,
        };
    });

    scored.sort((a, b) => {
        const scoreDiff = b.totalScore - a.totalScore;
        if (scoreDiff !== 0) return scoreDiff;
        return a.matchIndex - b.matchIndex;
    });

    return scored;
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

        const escapeVerbList = (list) => {
            const seen = new Set();
            return (list || [])
                .map(entry => parsePatternEntry(entry))
                .filter(Boolean)
                .map(entry => entry.body)
                .filter(body => {
                    if (!body || seen.has(body)) return false;
                    seen.add(body);
                    return true;
                })
                .join('|');
        };
        const attributionVerbsPattern = escapeVerbList(profile.attributionVerbs);
        const actionVerbsPattern = escapeVerbList(profile.actionVerbs);
        const pronounVocabulary = Array.isArray(profile.pronounVocabulary) && profile.pronounVocabulary.length
            ? profile.pronounVocabulary
            : DEFAULT_PRONOUNS;
        const pronounPattern = escapeVerbList(pronounVocabulary);

        const speakerTemplate = '(?:^|[\r\n]+|[>\]]\s*)({{PATTERNS}})\s*:';
        const boundaryLookbehind = "(?<![A-Za-z0-9_'’])";
        const attributionTemplate = attributionVerbsPattern
            ? `${boundaryLookbehind}({{PATTERNS}})\\s+(?:${attributionVerbsPattern})`
            : null;
        const actionTemplate = actionVerbsPattern
            ? `${boundaryLookbehind}({{PATTERNS}})(?:['’]s)?\\s+(?:${UNICODE_WORD_PATTERN}+\\s+){0,3}?(?:${actionVerbsPattern})`
            : null;

        state.compiledRegexes = {
            speakerRegex: buildRegex(effectivePatterns, speakerTemplate),
            attributionRegex: attributionTemplate ? buildRegex(effectivePatterns, attributionTemplate) : null,
            actionRegex: actionTemplate ? buildRegex(effectivePatterns, actionTemplate, { extraFlags: 'u' }) : null,
            pronounRegex: (actionVerbsPattern && pronounPattern)
                ? new RegExp(`(?:^|[\r\n]+)\s*(?:${pronounPattern})(?:['’]s)?\s+(?:${UNICODE_WORD_PATTERN}+\\s+){0,3}?(?:${actionVerbsPattern})`, 'iu')
                : null,
            vocativeRegex: buildRegex(effectivePatterns, `["“'\\s]({{PATTERNS}})[,.!?]`),
            possessiveRegex: buildRegex(effectivePatterns, `\\b({{PATTERNS}})['’]s\\b`),
            nameRegex: buildRegex(effectivePatterns, `\\b({{PATTERNS}})\\b`),
            vetoRegex: buildGenericRegex(profile.vetoPatterns),
        };
        rebuildMappingLookup(profile);
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

function rebuildMappingLookup(profile) {
    const map = new Map();
    if (profile && Array.isArray(profile.mappings)) {
        for (const entry of profile.mappings) {
            if (!entry) continue;
            const normalized = normalizeCostumeName(entry.name);
            if (!normalized) continue;
            const folder = String(entry.folder ?? '').trim();
            map.set(normalized.toLowerCase(), folder || normalized);
        }
    }
    state.mappingLookup = map;
    return map;
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

    const lookupKey = decision.name.toLowerCase();
    const mapped = state.mappingLookup instanceof Map ? state.mappingLookup.get(lookupKey) : null;
    let mappedFolder = String(mapped ?? decision.name).trim();
    if (!mappedFolder) {
        mappedFolder = decision.name;
    }

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
    pronounVocabulary: { selector: '#cs-pronoun-vocabulary', type: 'csvTextarea' },
    enableSceneRoster: { selector: '#cs-scene-roster-enable', type: 'checkbox' },
    sceneRosterTTL: { selector: '#cs-scene-roster-ttl', type: 'number' },
    prioritySpeakerWeight: { selector: '#cs-priority-speaker', type: 'number' },
    priorityAttributionWeight: { selector: '#cs-priority-attribution', type: 'number' },
    priorityActionWeight: { selector: '#cs-priority-action', type: 'number' },
    priorityPronounWeight: { selector: '#cs-priority-pronoun', type: 'number' },
    priorityVocativeWeight: { selector: '#cs-priority-vocative', type: 'number' },
    priorityPossessiveWeight: { selector: '#cs-priority-possessive', type: 'number' },
    priorityNameWeight: { selector: '#cs-priority-name', type: 'number' },
    rosterBonus: { selector: '#cs-roster-bonus', type: 'number' },
    rosterPriorityDropoff: { selector: '#cs-roster-dropoff', type: 'number' },
    distancePenaltyWeight: { selector: '#cs-distance-penalty', type: 'number' },
};

function normalizeProfileNameInput(name) {
    return String(name ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeScorePresetName(name) {
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

function resolveNumericSetting(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
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

function normalizeScorePresetWeights(weights = {}) {
    const normalized = {};
    SCORE_WEIGHT_KEYS.forEach((key) => {
        const fallback = PROFILE_DEFAULTS[key] ?? 0;
        normalized[key] = resolveNumericSetting(weights?.[key], fallback);
    });
    return normalized;
}

function normalizeScorePresetEntry(name, preset) {
    if (!name) return null;
    const entry = typeof preset === 'object' && preset !== null ? preset : {};
    const weights = normalizeScorePresetWeights(entry.weights || entry);
    const createdAt = Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now();
    const normalized = {
        name,
        description: typeof entry.description === 'string' ? entry.description : '',
        weights,
        builtIn: Boolean(entry.builtIn) || BUILTIN_SCORE_PRESET_KEYS.has(name),
        createdAt,
        updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : createdAt,
    };
    return normalized;
}

function ensureScorePresetStructure(settings = getSettings()) {
    if (!settings) return {};
    let presets = settings.scorePresets;
    if (!presets || typeof presets !== 'object') {
        presets = structuredClone(DEFAULT_SCORE_PRESETS);
    }

    const merged = {};
    const baseEntries = Object.entries(DEFAULT_SCORE_PRESETS);
    baseEntries.forEach(([name, preset]) => {
        const normalized = normalizeScorePresetEntry(name, preset);
        if (normalized) {
            merged[name] = normalized;
        }
    });

    Object.entries(presets).forEach(([name, preset]) => {
        const normalized = normalizeScorePresetEntry(name, preset);
        if (normalized) {
            merged[name] = normalized;
        }
    });

    settings.scorePresets = merged;
    if (!settings.activeScorePreset || !settings.scorePresets[settings.activeScorePreset]) {
        settings.activeScorePreset = 'Balanced Baseline';
    }
    return settings.scorePresets;
}

function getScorePresetStore() {
    const settings = getSettings();
    return ensureScorePresetStructure(settings);
}

function formatScoreNumber(value, { showSign = false } = {}) {
    if (!Number.isFinite(value)) return '—';
    const isInt = Math.abs(value % 1) < 0.001;
    let rounded = isInt ? Math.round(value) : Number(value.toFixed(2));
    if (Object.is(rounded, -0)) {
        rounded = 0;
    }
    let text = isInt ? String(rounded) : rounded.toString();
    if (showSign) {
        if (rounded > 0) return `+${text}`;
        if (rounded < 0) return text;
        return '0';
    }
    return text;
}

function collectScoreWeights(profile = getActiveProfile()) {
    const weights = {};
    SCORE_WEIGHT_KEYS.forEach((key) => {
        const fallback = PROFILE_DEFAULTS[key] ?? 0;
        weights[key] = resolveNumericSetting(profile?.[key], fallback);
    });
    return weights;
}

function applyScoreWeightsToProfile(profile, weights) {
    if (!profile || !weights) return;
    SCORE_WEIGHT_KEYS.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(weights, key)) {
            const fallback = PROFILE_DEFAULTS[key] ?? 0;
            profile[key] = resolveNumericSetting(weights[key], fallback);
        }
    });
}

function getScorePresetList() {
    const store = getScorePresetStore();
    const presets = Object.values(store || {});
    return presets.sort((a, b) => {
        if (a.builtIn !== b.builtIn) return a.builtIn ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
}

function updateScorePresetNameInputPlaceholder() {
    const input = $("#cs-score-preset-name");
    if (!input.length) return;
    if (state.activeScorePresetKey) {
        input.attr('placeholder', `Name… (selected: ${state.activeScorePresetKey})`);
    } else {
        input.attr('placeholder', 'Enter a name…');
    }
}

function populateScorePresetDropdown(selectedName = null) {
    const select = $("#cs-score-preset-select");
    if (!select.length) return;
    const presets = getScorePresetList();
    select.empty().append($('<option>', { value: '', text: 'Select a scoring preset…' }));
    presets.forEach((preset) => {
        const option = $('<option>', {
            value: preset.name,
            text: preset.builtIn ? `${preset.name} (built-in)` : preset.name,
        });
        if (preset.builtIn) {
            option.attr('data-built-in', 'true');
        }
        select.append(option);
    });

    let target = selectedName;
    if (!target || !select.find(`option[value="${target.replace(/"/g, '\"')}"]`).length) {
        target = getSettings()?.activeScorePreset || '';
    }
    if (target && select.find(`option[value="${target.replace(/"/g, '\"')}"]`).length) {
        select.val(target);
        state.activeScorePresetKey = target;
    } else {
        select.val('');
        state.activeScorePresetKey = null;
    }
    updateScorePresetNameInputPlaceholder();
    renderScorePresetPreview(state.activeScorePresetKey);
}

function renderScorePresetPreview(presetName) {
    const previewContainer = $("#cs-score-preset-preview");
    const messageEl = $("#cs-score-preset-message");
    if (!previewContainer.length) return;

    const store = getScorePresetStore();
    const preset = presetName && store?.[presetName] ? store[presetName] : null;
    const currentWeights = collectScoreWeights();

    if (!preset) {
        previewContainer.html('<p class="cs-helper-text">Pick a preset to compare how it leans against your current weights.</p>');
        if (messageEl.length) {
            messageEl.text('Select a preset to preview its scoring emphasis against what you have configured right now.');
        }
        return;
    }

    const weights = preset.weights || {};
    const maxValue = SCORE_WEIGHT_KEYS.reduce((max, key) => {
        const presetVal = Math.abs(Number(weights[key] ?? 0));
        const currentVal = Math.abs(Number(currentWeights[key] ?? 0));
        return Math.max(max, presetVal, currentVal);
    }, 1);

    const table = $('<table>').addClass('cs-score-preview-table');
    const head = $('<thead>');
    head.append($('<tr>')
        .append($('<th>').text('Signal'))
        .append($('<th>').text('Preset Focus'))
        .append($('<th>').text('Your Profile'))
        .append($('<th>').text('Change')));
    table.append(head);
    const tbody = $('<tbody>');
    SCORE_WEIGHT_KEYS.forEach((key) => {
        const label = SCORE_WEIGHT_LABELS[key] || key;
        const presetVal = Number(weights[key] ?? 0);
        const currentVal = Number(currentWeights[key] ?? 0);
        const delta = presetVal - currentVal;
        const diffText = delta === 0 ? '—' : formatScoreNumber(delta, { showSign: true });
        const diffClass = delta > 0 ? 'is-positive' : delta < 0 ? 'is-negative' : 'is-neutral';
        const width = Math.min(100, Math.abs(presetVal) / maxValue * 100);

        const bar = $('<div>').addClass('cs-weight-bar');
        bar.append($('<span>').addClass('cs-weight-bar-fill').toggleClass('is-negative', presetVal < 0).css('width', `${width}%`));
        bar.append($('<span>').addClass('cs-weight-bar-value').text(formatScoreNumber(presetVal)));

        const row = $('<tr>');
        row.append($('<th>').text(label));
        row.append($('<td>').append(bar));
        row.append($('<td>').text(formatScoreNumber(currentVal)));
        row.append($('<td>').addClass(diffClass).text(diffText));
        tbody.append(row);
    });
    table.append(tbody);

    previewContainer.empty().append(table);
    if (messageEl.length) {
        const parts = [];
        if (preset.description) parts.push(preset.description);
        parts.push(preset.builtIn ? 'Built-in preset' : 'Custom preset');
        parts.push('Bars show preset weight; numbers show your current setup.');
        messageEl.text(parts.join(' • '));
    }
}

function setActiveScorePreset(name) {
    const settings = getSettings();
    if (!settings) return;
    if (name && settings.scorePresets?.[name]) {
        settings.activeScorePreset = name;
        state.activeScorePresetKey = name;
    } else {
        state.activeScorePresetKey = null;
        settings.activeScorePreset = '';
    }
    updateScorePresetNameInputPlaceholder();
}

function upsertScorePreset(name, presetData = {}) {
    if (!name) return null;
    const store = getScorePresetStore();
    const existing = store?.[name];
    const payload = {
        ...existing,
        ...presetData,
    };
    payload.builtIn = Boolean(payload.builtIn) || BUILTIN_SCORE_PRESET_KEYS.has(name);
    if (!existing || !Number.isFinite(payload.createdAt)) {
        payload.createdAt = Date.now();
    }
    payload.updatedAt = Date.now();
    const normalized = normalizeScorePresetEntry(name, payload);
    if (normalized && existing?.createdAt) {
        normalized.createdAt = existing.createdAt;
    }
    if (normalized) {
        store[name] = normalized;
    }
    return normalized;
}

function deleteScorePreset(name) {
    if (!name) return false;
    const store = getScorePresetStore();
    const preset = store?.[name];
    if (!preset || preset.builtIn) {
        return false;
    }
    delete store[name];
    if (state.activeScorePresetKey === name) {
        setActiveScorePreset('');
    }
    return true;
}

function applyScorePresetByName(name) {
    const store = getScorePresetStore();
    const preset = store?.[name];
    if (!preset) return false;
    const profile = getActiveProfile();
    if (!profile) return false;
    applyScoreWeightsToProfile(profile, preset.weights);
    syncProfileFieldsToUI(profile, SCORE_WEIGHT_KEYS);
    renderScorePresetPreview(name);
    return true;
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

function syncProfileFieldsToUI(profile, fields = []) {
    if (!profile || !Array.isArray(fields)) return;
    fields.forEach((key) => {
        const mapping = uiMapping[key];
        if (!mapping) return;
        const field = $(mapping.selector);
        if (!field.length) return;
        const value = profile[key];
        switch (mapping.type) {
            case 'checkbox':
                field.prop('checked', !!value);
                break;
            case 'textarea':
                field.val(Array.isArray(value) ? value.join('\n') : '');
                break;
            case 'csvTextarea':
                field.val(Array.isArray(value) ? value.join(', ') : '');
                break;
            default:
                field.val(value ?? '');
                break;
        }
    });
}

function applyCommandProfileUpdates(profile, fields, { persist = false } = {}) {
    syncProfileFieldsToUI(profile, Array.isArray(fields) ? fields : []);
    if (persist) {
        saveSettingsDebounced?.();
    }
}

function parseCommandFlags(args = []) {
    const cleanArgs = [];
    let persist = false;
    args.forEach((arg) => {
        const normalized = String(arg ?? '').trim().toLowerCase();
        if (['--persist', '--save', '-p'].includes(normalized)) {
            persist = true;
        } else {
            cleanArgs.push(arg);
        }
    });
    return { args: cleanArgs, persist };
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
    populateScorePresetDropdown(getSettings()?.activeScorePreset || state.activeScorePresetKey);
    refreshCoverageFromLastReport();
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
                const parsed = parseFloat(field.val());
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

function renderTesterScoreBreakdown(details) {
    const table = $('#cs-test-score-breakdown');
    if (!table.length) return;
    let tbody = table.find('tbody');
    if (!tbody.length) {
        tbody = $('<tbody>');
        table.append(tbody);
    }
    tbody.empty();

    if (!Array.isArray(details) || !details.length) {
        tbody.append($('<tr>').append($('<td>', {
            colspan: 3,
            class: 'cs-tester-list-placeholder',
            text: 'Run the tester to see weighted scores.',
        })));
        return;
    }

    const maxAbs = details.reduce((max, detail) => {
        if (!detail) return max;
        const positive = Math.max(0, (detail.priorityScore || 0) + (detail.biasBonus || 0) + (detail.rosterBonus || 0));
        const penalty = Math.max(0, detail.distancePenalty || 0);
        const total = Math.abs(detail.totalScore || 0);
        return Math.max(max, positive, penalty, total);
    }, 1);

    details.forEach((detail) => {
        if (!detail) return;
        const triggerCell = $('<td>').append(
            $('<div>').addClass('cs-score-trigger')
                .append($('<strong>').text(detail.name || '(unknown)'))
                .append($('<small>').text(`${detail.matchKind || 'unknown'} • char ${Number.isFinite(detail.charIndex) ? detail.charIndex + 1 : '?'}`))
        );

        const positive = Math.max(0, (detail.priorityScore || 0) + (detail.biasBonus || 0) + (detail.rosterBonus || 0));
        const penalty = Math.max(0, detail.distancePenalty || 0);
        const positiveWidth = Math.min(100, (positive / maxAbs) * 100);
        const penaltyWidth = Math.min(100, (penalty / maxAbs) * 100);
        const bar = $('<div>').addClass('cs-score-bar');
        if (positiveWidth > 0) {
            bar.append($('<span>').addClass('cs-score-bar-positive').css('width', `${positiveWidth}%`));
        }
        if (penaltyWidth > 0) {
            bar.append($('<span>').addClass('cs-score-bar-penalty').css('width', `${penaltyWidth}%`));
        }
        bar.append($('<span>').addClass('cs-score-bar-total').text(formatScoreNumber(detail.totalScore)));
        const totalCell = $('<td>').append(bar);

        const breakdownParts = [];
        breakdownParts.push(`priority ${formatScoreNumber(detail.priorityScore)}`);
        if (detail.biasBonus) {
            breakdownParts.push(`bias ${formatScoreNumber(detail.biasBonus, { showSign: true })}`);
        }
        if (detail.rosterBonus) {
            breakdownParts.push(`roster ${formatScoreNumber(detail.rosterBonus, { showSign: true })}`);
        }
        if (detail.distancePenalty) {
            breakdownParts.push(`distance -${formatScoreNumber(detail.distancePenalty)}`);
        }
        const breakdownCell = $('<td>').text(breakdownParts.join(' · ') || '—');

        const row = $('<tr>').append(triggerCell, totalCell, breakdownCell);
        if (detail.totalScore < 0) {
            row.addClass('cs-score-row-negative');
        }
        if (detail.inRoster) {
            row.addClass('cs-score-row-roster');
        }
        tbody.append(row);
    });
}

function renderTesterRosterTimeline(events, warnings) {
    const list = $('#cs-test-roster-timeline');
    if (!list.length) return;
    list.empty();

    if (!Array.isArray(events) || !events.length) {
        list.append($('<li>').addClass('cs-tester-list-placeholder').text('No roster activity in this sample.'));
    } else {
        events.forEach((event) => {
            if (!event) return;
            const item = $('<li>').addClass('cs-roster-event');
            if (event.type === 'join') {
                item.addClass('cs-roster-event-join');
                item.append($('<strong>').text(event.name || '(unknown)'));
                item.append($('<small>').text(`${event.matchKind || 'unknown'} • char ${Number.isFinite(event.charIndex) ? event.charIndex + 1 : '?'}`));
            } else if (event.type === 'refresh') {
                item.addClass('cs-roster-event-refresh');
                item.append($('<strong>').text(event.name || '(unknown)'));
                item.append($('<small>').text(`refreshed via ${event.matchKind || 'unknown'} @ char ${Number.isFinite(event.charIndex) ? event.charIndex + 1 : '?'}`));
            } else if (event.type === 'expiry-warning') {
                item.addClass('cs-roster-event-warning');
                const names = Array.isArray(event.names) && event.names.length ? event.names.join(', ') : '(unknown)';
                item.append($('<strong>').text('TTL warning'));
                item.append($('<small>').text(`${names} expire after this message`));
            } else {
                item.append($('<strong>').text(event.name || '(unknown)'));
            }
            list.append(item);
        });
    }

    const warningContainer = $('#cs-test-roster-warning');
    if (warningContainer.length) {
        warningContainer.empty();
        if (Array.isArray(warnings) && warnings.length) {
            warnings.forEach((warning) => {
                const message = warning?.message || 'Roster TTL warning triggered.';
                warningContainer.append($('<div>').addClass('cs-roster-warning').text(message));
            });
        } else {
            warningContainer.text('No TTL warnings triggered.');
        }
    }
}

function normalizeVerbCandidate(word) {
    let base = String(word || '').toLowerCase();
    base = base.replace(/['’]s$/u, '');
    if (base.endsWith('ing') && base.length > 4) {
        base = base.slice(0, -3);
    } else if (base.endsWith('ies') && base.length > 4) {
        base = `${base.slice(0, -3)}y`;
    } else if (base.endsWith('ed') && base.length > 3) {
        base = base.slice(0, -2);
    } else if (base.endsWith('es') && base.length > 3) {
        base = base.slice(0, -2);
    } else if (base.endsWith('s') && base.length > 3) {
        base = base.slice(0, -1);
    }
    return base;
}

function analyzeCoverageDiagnostics(text, profile = getActiveProfile()) {
    if (!text) {
        return { missingPronouns: [], missingAttributionVerbs: [], missingActionVerbs: [], totalTokens: 0 };
    }

    const normalized = normalizeStreamText(text).toLowerCase();
    const tokens = normalized.match(COVERAGE_TOKEN_REGEX) || [];
    const pronounSet = new Set((profile?.pronounVocabulary || DEFAULT_PRONOUNS).map(value => String(value).toLowerCase()));
    const attributionSet = new Set((profile?.attributionVerbs || []).map(value => String(value).toLowerCase()));
    const actionSet = new Set((profile?.actionVerbs || []).map(value => String(value).toLowerCase()));

    const missingPronouns = new Set();
    const missingAttribution = new Set();
    const missingAction = new Set();

    tokens.forEach((token) => {
        const lower = String(token || '').toLowerCase();
        if (KNOWN_PRONOUNS.has(lower) && !pronounSet.has(lower)) {
            missingPronouns.add(lower);
        }
        const base = normalizeVerbCandidate(lower);
        if (KNOWN_ATTRIBUTION_VERBS.has(base) && !attributionSet.has(base)) {
            missingAttribution.add(base);
        }
        if (KNOWN_ACTION_VERBS.has(base) && !actionSet.has(base)) {
            missingAction.add(base);
        }
    });

    return {
        missingPronouns: Array.from(missingPronouns).sort(),
        missingAttributionVerbs: Array.from(missingAttribution).sort(),
        missingActionVerbs: Array.from(missingAction).sort(),
        totalTokens: tokens.length,
    };
}

function renderCoverageDiagnostics(result) {
    const data = result || { missingPronouns: [], missingAttributionVerbs: [], missingActionVerbs: [] };
    const update = (selector, values, type) => {
        const container = $(selector);
        if (!container.length) return;
        container.empty();
        if (!Array.isArray(values) || !values.length) {
            container.append($('<span>').addClass('cs-tester-list-placeholder').text('No gaps detected.'));
            return;
        }
        values.forEach((value) => {
            const pill = $('<button>')
                .addClass('cs-coverage-pill')
                .attr('type', 'button')
                .attr('data-type', type)
                .attr('data-value', value)
                .text(value);
            container.append(pill);
        });
    };

    update('#cs-coverage-pronouns', data.missingPronouns, 'pronoun');
    update('#cs-coverage-attribution', data.missingAttributionVerbs, 'attribution');
    update('#cs-coverage-action', data.missingActionVerbs, 'action');
    state.coverageDiagnostics = data;
}

function refreshCoverageFromLastReport() {
    const text = state.lastTesterReport?.normalizedInput;
    const profile = getActiveProfile();
    if (text) {
        const coverage = analyzeCoverageDiagnostics(text, profile);
        renderCoverageDiagnostics(coverage);
        if (state.lastTesterReport) {
            state.lastTesterReport.coverage = coverage;
        }
    } else {
        renderCoverageDiagnostics(null);
    }
}

function mergeUniqueList(target = [], additions = []) {
    const list = Array.isArray(target) ? [...target] : [];
    const seen = new Set(list.map(item => String(item).toLowerCase()));
    (additions || []).forEach((item) => {
        const value = String(item || '').trim();
        if (!value) return;
        const lower = value.toLowerCase();
        if (!seen.has(lower)) {
            list.push(value);
            seen.add(lower);
        }
    });
    return list;
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

    if (Array.isArray(report.scoreDetails)) {
        lines.push('');
        lines.push('Detection Score Breakdown:');
        if (report.scoreDetails.length) {
            report.scoreDetails.slice(0, 10).forEach((detail, idx) => {
                const charPos = Number.isFinite(detail.charIndex) ? detail.charIndex + 1 : '?';
                const parts = [];
                parts.push(`priority ${formatScoreNumber(detail.priorityScore)}`);
                if (detail.biasBonus) parts.push(`bias ${formatScoreNumber(detail.biasBonus, { showSign: true })}`);
                if (detail.rosterBonus) parts.push(`roster ${formatScoreNumber(detail.rosterBonus, { showSign: true })}`);
                if (detail.distancePenalty) parts.push(`distance -${formatScoreNumber(detail.distancePenalty)}`);
                lines.push(`  ${idx + 1}. ${detail.name} (${detail.matchKind}) – total ${formatScoreNumber(detail.totalScore)} [${parts.join(', ')}] @ char ${charPos}`);
            });
            if (report.scoreDetails.length > 10) {
                lines.push(`  ... (${report.scoreDetails.length - 10} more detections)`);
            }
        } else {
            lines.push('  (none)');
        }
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

    if (Array.isArray(report.rosterTimeline)) {
        lines.push('');
        lines.push('Roster Timeline:');
        if (report.rosterTimeline.length) {
            report.rosterTimeline.forEach((event, idx) => {
                if (event.type === 'join') {
                    lines.push(`  ${idx + 1}. ${event.name} joined via ${event.matchKind || 'unknown'} (char ${Number.isFinite(event.charIndex) ? event.charIndex + 1 : '?'})`);
                } else if (event.type === 'refresh') {
                    lines.push(`  ${idx + 1}. ${event.name} refreshed (char ${Number.isFinite(event.charIndex) ? event.charIndex + 1 : '?'})`);
                } else if (event.type === 'expiry-warning') {
                    const names = Array.isArray(event.names) && event.names.length ? event.names.join(', ') : '(unknown)';
                    lines.push(`  ${idx + 1}. TTL warning for ${names}`);
                } else {
                    lines.push(`  ${idx + 1}. ${event.name || '(event)'}`);
                }
            });
        } else {
            lines.push('  (none)');
        }
    }

    if (Array.isArray(report.rosterWarnings) && report.rosterWarnings.length) {
        lines.push('');
        lines.push('Roster Warnings:');
        report.rosterWarnings.forEach((warning, idx) => {
            const message = warning?.message || 'Roster TTL warning triggered.';
            lines.push(`  ${idx + 1}. ${message}`);
        });
    }

    if (report.coverage) {
        lines.push('');
        lines.push('Vocabulary Coverage:');
        const coverage = report.coverage;
        const pronouns = coverage.missingPronouns?.length ? coverage.missingPronouns.join(', ') : 'none';
        const attribution = coverage.missingAttributionVerbs?.length ? coverage.missingAttributionVerbs.join(', ') : 'none';
        const action = coverage.missingActionVerbs?.length ? coverage.missingActionVerbs.join(', ') : 'none';
        lines.push(`  Missing pronouns: ${pronouns}`);
        lines.push(`  Missing attribution verbs: ${attribution}`);
        lines.push(`  Missing action verbs: ${action}`);
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
        return { events, finalState: null, rosterTimeline: [], rosterWarnings: [] };
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
    const rosterTimeline = [];
    const rosterWarnings = [];
    const rosterDisplayNames = new Map();
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
            const normalized = String(bestMatch.name || '').toLowerCase();
            const wasPresent = normalized ? msgState.sceneRoster.has(normalized) : false;
            if (normalized) {
                msgState.sceneRoster.add(normalized);
                rosterDisplayNames.set(normalized, bestMatch.name);
            }
            msgState.rosterTTL = rosterTTL;
            rosterTimeline.push({
                type: wasPresent ? 'refresh' : 'join',
                name: bestMatch.name,
                matchKind: bestMatch.matchKind,
                charIndex: i,
                timestamp: i * 50,
                rosterSize: msgState.sceneRoster.size,
            });
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

    if (profile.enableSceneRoster && msgState.sceneRoster.size > 0) {
        const turnsRemaining = (msgState.rosterTTL ?? rosterTTL) - 1;
        if (turnsRemaining <= 0) {
            const names = Array.from(msgState.sceneRoster || []).map((name) => rosterDisplayNames.get(name) || name);
            rosterWarnings.push({
                type: 'ttl-expiry',
                turnsRemaining: Math.max(0, turnsRemaining),
                names,
                message: `Scene roster TTL of ${rosterTTL} will clear ${names.join(', ')} before the next message. Consider increas` +
                    'ing the TTL for longer conversations.',
            });
            rosterTimeline.push({
                type: 'expiry-warning',
                turnsRemaining: Math.max(0, turnsRemaining),
                names,
                timestamp: finalState.virtualDurationMs,
            });
        }
    }

    return { events, finalState, rosterTimeline, rosterWarnings };
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
    renderTesterScoreBreakdown(null);
    renderTesterRosterTimeline(null, null);
    renderCoverageDiagnostics(null);
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
    const originalMessageKeyQueue = Array.isArray(state.messageKeyQueue) ? [...state.messageKeyQueue] : [];
    const bufKey = tempProfileName;

    const resetTesterMessageState = () => {
        const testerState = createTesterMessageState(tempProfile);
        state.perMessageStates = new Map([[bufKey, testerState]]);
        state.perMessageBuffers = new Map([[bufKey, '']]);
        state.messageKeyQueue = [bufKey];
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

    const coverage = analyzeCoverageDiagnostics(combined, tempProfile);

    if (state.compiledRegexes.vetoRegex && state.compiledRegexes.vetoRegex.test(combined)) {
        const vetoMatch = combined.match(state.compiledRegexes.vetoRegex)?.[0] || 'unknown veto phrase';
        $("#cs-test-veto-result").html(`Vetoed by: <b style="color: var(--red);">${vetoMatch}</b>`);
        allDetectionsList.html('<li class="cs-tester-list-placeholder">Message vetoed.</li>');
        const vetoEvents = [{ type: 'veto', match: vetoMatch, charIndex: combined.length - 1 }];
        renderTesterStream(streamList, vetoEvents);
        renderTesterScoreBreakdown([]);
        renderTesterRosterTimeline([], []);
        renderCoverageDiagnostics(coverage);
        state.lastTesterReport = { ...reportBase, vetoed: true, vetoMatch, events: vetoEvents, matches: [], topCharacters: [], rosterTimeline: [], rosterWarnings: [], scoreDetails: [], coverage };
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
        const topCharacters = rankSceneCharacters(allMatches, {
            rosterSet: testerRoster,
            profile: tempProfile,
            distancePenaltyWeight: resolveNumericSetting(tempProfile?.distancePenaltyWeight, PROFILE_DEFAULTS.distancePenaltyWeight),
            rosterBonus: resolveNumericSetting(tempProfile?.rosterBonus, PROFILE_DEFAULTS.rosterBonus),
            priorityMultiplier: 100,
        });
        const detailedScores = scoreMatchesDetailed(allMatches, combined.length, {
            rosterSet: testerRoster,
            profile: tempProfile,
            distancePenaltyWeight: resolveNumericSetting(tempProfile?.distancePenaltyWeight, PROFILE_DEFAULTS.distancePenaltyWeight),
            rosterBonus: resolveNumericSetting(tempProfile?.rosterBonus, PROFILE_DEFAULTS.rosterBonus),
            rosterPriorityDropoff: resolveNumericSetting(tempProfile?.rosterPriorityDropoff, PROFILE_DEFAULTS.rosterPriorityDropoff),
            priorityMultiplier: 100,
        });
        renderTesterScoreBreakdown(detailedScores);
        renderTesterRosterTimeline(simulationResult?.rosterTimeline || [], simulationResult?.rosterWarnings || []);
        renderCoverageDiagnostics(coverage);
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
            rosterTimeline: Array.isArray(simulationResult?.rosterTimeline) ? simulationResult.rosterTimeline.map(event => ({ ...event })) : [],
            rosterWarnings: Array.isArray(simulationResult?.rosterWarnings) ? simulationResult.rosterWarnings.map(warn => ({ ...warn })) : [],
            scoreDetails: detailedScores.map(detail => ({ ...detail })),
            coverage,
        };
        updateTesterCopyButton();
    }

    state.perMessageStates = originalPerMessageStates;
    state.perMessageBuffers = originalPerMessageBuffers;
    state.messageKeyQueue = originalMessageKeyQueue;
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
    $(document).on('change', '#cs-score-preset-select', function() {
        const selected = $(this).val();
        if (selected) {
            setActiveScorePreset(selected);
            renderScorePresetPreview(selected);
        } else {
            setActiveScorePreset('');
            renderScorePresetPreview(null);
        }
        $('#cs-score-preset-name').val('');
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
    $(document).on('click', '#cs-score-preset-apply', () => {
        const selected = $("#cs-score-preset-select").val();
        if (!selected) {
            showStatus('Select a scoring preset to apply.', 'error');
            return;
        }
        if (applyScorePresetByName(selected)) {
            setActiveScorePreset(selected);
            persistSettings(`Applied scoring preset "${escapeHtml(selected)}".`);
        } else {
            showStatus('Unable to apply the selected preset.', 'error');
        }
    });
    $(document).on('click', '#cs-score-preset-save', () => {
        const selected = $("#cs-score-preset-select").val();
        if (!selected) {
            showStatus('Select a preset to overwrite or use Save As to create a new one.', 'error');
            return;
        }
        const store = getScorePresetStore();
        const preset = store?.[selected];
        if (!preset) {
            showStatus('Preset not found.', 'error');
            return;
        }
        if (preset.builtIn) {
            showStatus('Built-in presets are read-only. Use Save As to create your own copy.', 'error');
            return;
        }
        const weights = collectScoreWeights();
        upsertScorePreset(selected, { weights, description: preset.description, builtIn: false, createdAt: preset.createdAt });
        populateScorePresetDropdown(selected);
        persistSettings(`Updated preset "${escapeHtml(selected)}".`);
    });
    $(document).on('click', '#cs-score-preset-saveas', () => {
        const desiredRaw = $("#cs-score-preset-name").val();
        const desired = normalizeScorePresetName(desiredRaw);
        if (!desired) {
            showStatus('Enter a name before saving a new scoring preset.', 'error');
            return;
        }
        if (BUILTIN_SCORE_PRESET_KEYS.has(desired)) {
            showStatus('That name is reserved for a built-in preset. Please choose another.', 'error');
            return;
        }
        const store = getScorePresetStore();
        if (store[desired] && !confirm(`A preset named "${desired}" already exists. Overwrite it?`)) {
            return;
        }
        const weights = collectScoreWeights();
        upsertScorePreset(desired, { weights, description: store[desired]?.description || '', builtIn: false });
        setActiveScorePreset(desired);
        populateScorePresetDropdown(desired);
        $("#cs-score-preset-name").val('');
        persistSettings(`Saved current weights as "${escapeHtml(desired)}".`);
    });
    $(document).on('click', '#cs-score-preset-rename', () => {
        const selected = $("#cs-score-preset-select").val();
        if (!selected) {
            showStatus('Select a preset to rename.', 'error');
            return;
        }
        const store = getScorePresetStore();
        const preset = store?.[selected];
        if (!preset) {
            showStatus('Preset not found.', 'error');
            return;
        }
        if (preset.builtIn) {
            showStatus('Built-in presets cannot be renamed.', 'error');
            return;
        }
        const desiredRaw = $("#cs-score-preset-name").val();
        const desired = normalizeScorePresetName(desiredRaw);
        if (!desired) {
            showStatus('Enter a new name to rename the preset.', 'error');
            return;
        }
        if (BUILTIN_SCORE_PRESET_KEYS.has(desired)) {
            showStatus('That name is reserved for a built-in preset. Please choose another.', 'error');
            return;
        }
        if (getScorePresetStore()?.[desired] && desired !== selected) {
            showStatus('Another preset already uses that name.', 'error');
            return;
        }
        if (desired === selected) {
            showStatus('Preset already uses that name.', 'info');
            return;
        }
        const clone = { ...preset, name: desired, builtIn: false };
        delete store[selected];
        const normalized = normalizeScorePresetEntry(desired, clone);
        if (normalized) {
            normalized.createdAt = preset.createdAt;
            normalized.updatedAt = Date.now();
            store[desired] = normalized;
            setActiveScorePreset(desired);
            populateScorePresetDropdown(desired);
            $("#cs-score-preset-name").val('');
            persistSettings(`Renamed preset to "${escapeHtml(desired)}".`);
        } else {
            store[selected] = preset;
            showStatus('Unable to rename preset.', 'error');
        }
    });
    $(document).on('click', '#cs-score-preset-delete', () => {
        const selected = $("#cs-score-preset-select").val();
        if (!selected) {
            showStatus('Select a preset to delete.', 'error');
            return;
        }
        const store = getScorePresetStore();
        const preset = store?.[selected];
        if (!preset) {
            showStatus('Preset not found.', 'error');
            return;
        }
        if (preset.builtIn) {
            showStatus('Built-in presets cannot be deleted.', 'error');
            return;
        }
        if (!confirm(`Delete preset "${selected}"? This cannot be undone.`)) {
            return;
        }
        if (deleteScorePreset(selected)) {
            populateScorePresetDropdown('');
            $("#cs-score-preset-name").val('');
            persistSettings(`Deleted preset "${escapeHtml(selected)}".`, 'info');
        } else {
            showStatus('Unable to delete preset.', 'error');
        }
    });
    $(document).on('click', '.cs-coverage-pill', function() {
        const profile = getActiveProfile();
        if (!profile) return;
        const type = $(this).data('type');
        const value = String($(this).data('value') || '').trim();
        if (!value) return;
        let field = null;
        if (type === 'pronoun') {
            profile.pronounVocabulary = mergeUniqueList(profile.pronounVocabulary, [value]);
            field = 'pronounVocabulary';
        } else if (type === 'attribution') {
            profile.attributionVerbs = mergeUniqueList(profile.attributionVerbs, [value]);
            field = 'attributionVerbs';
        } else if (type === 'action') {
            profile.actionVerbs = mergeUniqueList(profile.actionVerbs, [value]);
            field = 'actionVerbs';
        }
        if (field) {
            syncProfileFieldsToUI(profile, [field]);
            recompileRegexes();
            refreshCoverageFromLastReport();
            showStatus(`Added "${escapeHtml(value)}" to ${field.replace(/([A-Z])/g, ' $1').toLowerCase()}.`, 'success');
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
    $(document).on('click', '#cs-mapping-add', () => {
        const profile = getActiveProfile();
        if (profile) {
            profile.mappings.push({ name: "", folder: "" });
            renderMappings(profile);
            rebuildMappingLookup(profile);
        }
    });
    $(document).on('click', '#cs-mappings-tbody .map-remove', function() {
        const idx = parseInt($(this).closest('tr').attr('data-idx'), 10);
        const profile = getActiveProfile();
        if (profile && !isNaN(idx)) {
            profile.mappings.splice(idx, 1);
            renderMappings(profile); // Re-render to update indices
            rebuildMappingLookup(profile);
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
    const profile = getActiveProfile();
    const matches = normalizedText ? findAllMatches(normalizedText) : [];
    const stats = summarizeMatches(matches);

    state.messageStats.set(bufKey, stats);

    const ranking = rankSceneCharacters(matches, {
        rosterSet,
        profile,
        distancePenaltyWeight: resolveNumericSetting(profile?.distancePenaltyWeight, PROFILE_DEFAULTS.distancePenaltyWeight),
        rosterBonus: resolveNumericSetting(profile?.rosterBonus, PROFILE_DEFAULTS.rosterBonus),
        priorityMultiplier: 100,
    });
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

    trackMessageKey(bufKey);

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
        const { args: cleanArgs, persist } = parseCommandFlags(args || []);
        const name = String(cleanArgs?.join(' ') ?? '').trim();
        if (profile && name) {
            profile.patterns.push(name);
            recompileRegexes();
            applyCommandProfileUpdates(profile, ['patterns'], { persist });
            updateFocusLockUI();
            const message = persist
                ? `Added "<b>${escapeHtml(name)}</b>" to patterns and saved the profile.`
                : `Added "<b>${escapeHtml(name)}</b>" to patterns for this session.`;
            showStatus(message, 'success');
        } else if (profile) {
            showStatus('Please provide a character name to add.', 'error');
        }
    }, ["char"], "Adds a character to the current profile's pattern list. Append --persist to save immediately.", true);

    registerSlashCommand("cs-ignore", (args) => {
        const profile = getActiveProfile();
        const { args: cleanArgs, persist } = parseCommandFlags(args || []);
        const name = String(cleanArgs?.join(' ') ?? '').trim();
        if (profile && name) {
            profile.ignorePatterns.push(name);
            recompileRegexes();
            applyCommandProfileUpdates(profile, ['ignorePatterns'], { persist });
            const message = persist
                ? `Ignoring "<b>${escapeHtml(name)}</b>" and saved the profile.`
                : `Ignoring "<b>${escapeHtml(name)}</b>" for this session.`;
            showStatus(message, 'success');
        } else if (profile) {
            showStatus('Please provide a character name to ignore.', 'error');
        }
    }, ["char"], "Adds a character to the current profile's ignore list. Append --persist to save immediately.", true);

    registerSlashCommand("cs-map", (args) => {
        const profile = getActiveProfile();
        const { args: cleanArgs, persist } = parseCommandFlags(args || []);
        const lowered = cleanArgs.map(arg => String(arg ?? '').toLowerCase());
        const toIndex = lowered.indexOf('to');

        if (profile && toIndex > 0 && toIndex < cleanArgs.length - 1) {
            const alias = cleanArgs.slice(0, toIndex).join(' ').trim();
            const folder = cleanArgs.slice(toIndex + 1).join(' ').trim();

            if (alias && folder) {
                profile.mappings.push({ name: alias, folder: folder });
                rebuildMappingLookup(profile);
                renderMappings(profile);
                applyCommandProfileUpdates(profile, [], { persist });
                const message = persist
                    ? `Mapped "<b>${escapeHtml(alias)}</b>" to "<b>${escapeHtml(folder)}</b>" and saved the profile.`
                    : `Mapped "<b>${escapeHtml(alias)}</b>" to "<b>${escapeHtml(folder)}</b>" for this session.`;
                showStatus(message, 'success');
            } else {
                showStatus('Invalid format. Use /cs-map (alias) to (folder).', 'error');
            }
        } else {
            showStatus('Invalid format. Use /cs-map (alias) to (folder).', 'error');
        }
    }, ["alias", "to", "folder"], "Maps a character alias to a costume folder. Append --persist to save immediately.", true);
    
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
    trackMessageKey(bufKey);

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

    replaceTrackedMessageKey(oldKey, newKey);

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
    pruneMessageCaches();
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
        messageKeyQueue: [],
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

    ensureScorePresetStructure(storeSource[extensionName]);

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
        populateScorePresetDropdown();
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
