import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, event_types, eventSource } from "../../../../script.js";
import { executeSlashCommandsOnChatInput, registerSlashCommand } from "../../../slash-commands.js";
import {
    DEFAULT_ACTION_VERBS_PRESENT,
    DEFAULT_ACTION_VERBS_THIRD_PERSON,
    DEFAULT_ACTION_VERBS_PAST,
    DEFAULT_ACTION_VERBS_PAST_PARTICIPLE,
    DEFAULT_ACTION_VERBS_PRESENT_PARTICIPLE,
    DEFAULT_ATTRIBUTION_VERBS_PRESENT,
    DEFAULT_ATTRIBUTION_VERBS_THIRD_PERSON,
    DEFAULT_ATTRIBUTION_VERBS_PAST,
    DEFAULT_ATTRIBUTION_VERBS_PAST_PARTICIPLE,
    DEFAULT_ATTRIBUTION_VERBS_PRESENT_PARTICIPLE,
    EXTENDED_ACTION_VERBS_PRESENT,
    EXTENDED_ACTION_VERBS_THIRD_PERSON,
    EXTENDED_ACTION_VERBS_PAST,
    EXTENDED_ACTION_VERBS_PAST_PARTICIPLE,
    EXTENDED_ACTION_VERBS_PRESENT_PARTICIPLE,
    EXTENDED_ATTRIBUTION_VERBS_PRESENT,
    EXTENDED_ATTRIBUTION_VERBS_THIRD_PERSON,
    EXTENDED_ATTRIBUTION_VERBS_PAST,
    EXTENDED_ATTRIBUTION_VERBS_PAST_PARTICIPLE,
    EXTENDED_ATTRIBUTION_VERBS_PRESENT_PARTICIPLE,
    buildVerbSlices,
} from "./verbs.js";
import {
    compileProfileRegexes,
    collectDetections,
} from "./src/detector-core.js";
import {
    mergeDetectionsForReport,
    summarizeDetections,
} from "./src/report-utils.js";
import { loadProfiles, normalizeProfile, normalizeMappingEntry } from "./profile-utils.js";

const extensionName = "SillyTavern-CostumeSwitch-Testing";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const logPrefix = "[CostumeSwitch]";

function buildVerbList(...lists) {
    return Array.from(new Set(lists.flat().filter(Boolean)));
}

const DEFAULT_ATTRIBUTION_VERB_FORMS = buildVerbList(
    DEFAULT_ATTRIBUTION_VERBS_PRESENT,
    DEFAULT_ATTRIBUTION_VERBS_THIRD_PERSON,
    DEFAULT_ATTRIBUTION_VERBS_PAST,
    DEFAULT_ATTRIBUTION_VERBS_PAST_PARTICIPLE,
    DEFAULT_ATTRIBUTION_VERBS_PRESENT_PARTICIPLE,
);

const EXTENDED_ATTRIBUTION_VERB_FORMS = buildVerbList(
    EXTENDED_ATTRIBUTION_VERBS_PRESENT,
    EXTENDED_ATTRIBUTION_VERBS_THIRD_PERSON,
    EXTENDED_ATTRIBUTION_VERBS_PAST,
    EXTENDED_ATTRIBUTION_VERBS_PAST_PARTICIPLE,
    EXTENDED_ATTRIBUTION_VERBS_PRESENT_PARTICIPLE,
);

const DEFAULT_ACTION_VERB_FORMS = buildVerbList(
    DEFAULT_ACTION_VERBS_PRESENT,
    DEFAULT_ACTION_VERBS_THIRD_PERSON,
    DEFAULT_ACTION_VERBS_PAST,
    DEFAULT_ACTION_VERBS_PAST_PARTICIPLE,
    DEFAULT_ACTION_VERBS_PRESENT_PARTICIPLE,
);

const EXTENDED_ACTION_VERB_FORMS = buildVerbList(
    EXTENDED_ACTION_VERBS_PRESENT,
    EXTENDED_ACTION_VERBS_THIRD_PERSON,
    EXTENDED_ACTION_VERBS_PAST,
    EXTENDED_ACTION_VERBS_PAST_PARTICIPLE,
    EXTENDED_ACTION_VERBS_PRESENT_PARTICIPLE,
);

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

const AUTO_SAVE_DEBOUNCE_MS = 800;
const AUTO_SAVE_NOTICE_COOLDOWN_MS = 1800;
const AUTO_SAVE_RECOMPILE_KEYS = new Set([
    'patterns',
    'ignorePatterns',
    'vetoPatterns',
    'attributionVerbs',
    'actionVerbs',
    'pronounVocabulary',
]);
const AUTO_SAVE_FOCUS_LOCK_KEYS = new Set(['patterns']);
const AUTO_SAVE_REASON_OVERRIDES = {
    patterns: 'character patterns',
    ignorePatterns: 'ignored names',
    vetoPatterns: 'veto phrases',
    defaultCostume: 'default costume',
    debug: 'debug logging',
    globalCooldownMs: 'global cooldown',
    repeatSuppressMs: 'repeat suppression window',
    perTriggerCooldownMs: 'per-trigger cooldown',
    failedTriggerCooldownMs: 'failed trigger cooldown',
    maxBufferChars: 'buffer size',
    tokenProcessThreshold: 'token processing threshold',
    detectionBias: 'detection bias',
    detectAttribution: 'attribution detection',
    detectAction: 'action detection',
    detectVocative: 'vocative detection',
    detectPossessive: 'possessive detection',
    detectPronoun: 'pronoun detection',
    detectGeneral: 'general name detection',
    enableOutfits: 'outfit automation',
    attributionVerbs: 'attribution verbs',
    actionVerbs: 'action verbs',
    pronounVocabulary: 'pronoun vocabulary',
    enableSceneRoster: 'scene roster',
    sceneRosterTTL: 'scene roster timing',
    rosterBonus: 'roster bonus',
    rosterPriorityDropoff: 'roster drop-off',
    distancePenaltyWeight: 'distance penalty weight',
    mappings: 'character mappings',
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
    enableOutfits: false,
    detectAttribution: true,
    detectAction: true,
    detectVocative: true,
    detectPossessive: true,
    detectPronoun: true,
    detectGeneral: false,
    pronounVocabulary: [...DEFAULT_PRONOUNS],
    attributionVerbs: [...DEFAULT_ATTRIBUTION_VERB_FORMS],
    actionVerbs: [...DEFAULT_ACTION_VERB_FORMS],
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
    ...DEFAULT_ATTRIBUTION_VERB_FORMS,
    ...EXTENDED_ATTRIBUTION_VERB_FORMS,
].map(value => String(value).toLowerCase()));

const KNOWN_ACTION_VERBS = new Set([
    ...DEFAULT_ACTION_VERB_FORMS,
    ...EXTENDED_ACTION_VERB_FORMS,
].map(value => String(value).toLowerCase()));

function getVerbInflections(category = "attribution", edition = "default") {
    return buildVerbSlices({ category, edition });
}

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
    lastIssuedFolder: null,
    lastSwitchTimestamp: 0,
    lastTriggerTimes: new Map(),
    failedTriggerTimes: new Map(),
    characterOutfits: new Map(),
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
    outfitCardCollapse: new Map(),
    autoSave: {
        timer: null,
        pendingReasons: new Set(),
        requiresRecompile: false,
        requiresMappingRebuild: false,
        requiresFocusLockRefresh: false,
        lastNoticeAt: new Map(),
    },
};

let nextOutfitCardId = 1;

function ensureMappingCardId(mapping) {
    if (!mapping || typeof mapping !== "object") {
        return null;
    }

    if (!Object.prototype.hasOwnProperty.call(mapping, "__cardId")) {
        const id = `cs-outfit-card-${Date.now()}-${nextOutfitCardId++}`;
        Object.defineProperty(mapping, "__cardId", {
            value: id,
            enumerable: false,
            configurable: true,
        });
    }

    return mapping.__cardId;
}

function markMappingForInitialCollapse(mapping) {
    if (!mapping || typeof mapping !== "object") {
        return mapping;
    }

    try {
        Object.defineProperty(mapping, "__startCollapsed", {
            value: true,
            enumerable: false,
            configurable: true,
        });
    } catch (err) {
        mapping.__startCollapsed = true;
    }

    return mapping;
}

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
    const profile = getActiveProfile();
    const { compiledRegexes } = state;
    if (!profile || !combined) {
        return [];
    }

    let lastSubject = null;
    if (profile.detectPronoun && state.perMessageStates.size > 0) {
        const msgState = Array.from(state.perMessageStates.values()).pop();
        if (msgState && msgState.lastSubject) {
            lastSubject = msgState.lastSubject;
        }
    }

    return collectDetections(combined, profile, compiledRegexes, {
        priorityWeights: getPriorityWeights(profile),
        lastSubject,
    });
}

function findBestMatch(combined, precomputedMatches = null, options = {}) {
    const profile = getActiveProfile();
    if (!profile) return null;
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

    if (Number.isFinite(options?.minIndex) && options.minIndex >= 0) {
        scoringOptions.minIndex = options.minIndex;
    }

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
    const minIndex = Number.isFinite(options?.minIndex) && options.minIndex >= 0 ? options.minIndex : null;
    const scoredMatches = [];

    matches.forEach((match) => {
        const isActive = match.priority >= 3; // speaker, attribution, action
        const hasFiniteIndex = Number.isFinite(match.matchIndex);
        if (minIndex != null && hasFiniteIndex && match.matchIndex <= minIndex) {
            return;
        }
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
        scoredMatches.push({ ...match, score });
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

        const compiled = compileProfileRegexes(profile, {
            unicodeWordPattern: UNICODE_WORD_PATTERN,
            defaultPronouns: DEFAULT_PRONOUNS,
        });

        state.compiledRegexes = compiled.regexes;
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
            const folder = String(entry.defaultFolder ?? entry.folder ?? '').trim();
            map.set(normalized.toLowerCase(), folder || normalized);
        }
    }
    state.mappingLookup = map;
    return map;
}

function findMappingForName(profile, normalizedName) {
    if (!profile || !Array.isArray(profile.mappings) || !normalizedName) {
        return null;
    }

    const lowered = normalizedName.toLowerCase();
    for (const entry of profile.mappings) {
        if (!entry) continue;
        const candidate = normalizeCostumeName(entry.name);
        if (candidate && candidate.toLowerCase() === lowered) {
            return entry;
        }
    }
    return null;
}

function parseTriggerPattern(trigger) {
    if (typeof trigger !== "string") {
        return null;
    }
    const trimmed = trigger.trim();
    if (!trimmed) {
        return null;
    }

    const regexMatch = trimmed.match(/^\/((?:\\.|[^/])+?)\/([gimsuy]*)$/);
    if (regexMatch) {
        const source = regexMatch[1];
        const rawFlags = regexMatch[2] || "";
        const mergedFlags = Array.from(new Set((rawFlags + "i").split(""))).filter(flag => "gimsuy".includes(flag)).join("");
        try {
            return { type: "regex", raw: trimmed, regex: new RegExp(source, mergedFlags || "i") };
        } catch (err) {
            console.warn(`${logPrefix} Invalid outfit trigger regex: ${trimmed}`, err);
            return null;
        }
    }

    return { type: "literal", raw: trimmed, value: trimmed.toLowerCase() };
}

function evaluateOutfitTriggers(variant, context) {
    const triggers = Array.isArray(variant?.triggers) ? variant.triggers : [];
    if (triggers.length === 0) {
        return { matched: true, trigger: null, triggerType: null, matchIndex: -1, snippet: null };
    }

    const text = String(context?.text ?? "");
    const lower = text.toLowerCase();

    for (const trigger of triggers) {
        const pattern = parseTriggerPattern(trigger);
        if (!pattern) {
            continue;
        }

        if (pattern.type === "regex") {
            pattern.regex.lastIndex = 0;
            const match = pattern.regex.exec(text);
            if (match) {
                const index = Number.isFinite(match.index) ? match.index : 0;
                const length = typeof match[0] === "string" ? match[0].length : 0;
                const snippet = text.slice(Math.max(0, index - 20), Math.min(text.length, index + length + 20)).trim();
                return {
                    matched: true,
                    trigger: pattern.raw,
                    triggerType: "regex",
                    matchIndex: index,
                    snippet,
                };
            }
        } else if (pattern.type === "literal") {
            const index = lower.indexOf(pattern.value);
            if (index !== -1) {
                const snippet = text.slice(Math.max(0, index - 20), Math.min(text.length, index + pattern.value.length + 20)).trim();
                return {
                    matched: true,
                    trigger: pattern.raw,
                    triggerType: "literal",
                    matchIndex: index,
                    snippet,
                };
            }
        }
    }

    return { matched: false, trigger: null, triggerType: null, matchIndex: -1, snippet: null };
}

function normalizeAwarenessList(value) {
    if (value == null) {
        return [];
    }

    const array = Array.isArray(value) ? value : [value];
    return array
        .map(entry => normalizeCostumeName(entry))
        .map(name => name.toLowerCase())
        .filter(Boolean);
}

function evaluateAwarenessPredicates(predicates, context) {
    if (!predicates || typeof predicates !== "object") {
        return { ok: true, reason: "no-awareness", reasons: [] };
    }

    const rosterSet = context?.rosterNormalized instanceof Set
        ? context.rosterNormalized
        : buildLowercaseSet(context?.roster);

    const reasons = [];

    const requiresAll = normalizeAwarenessList(predicates.requires ?? predicates.all ?? null);
    if (requiresAll.length) {
        if (!(rosterSet && rosterSet.size)) {
            return { ok: false, reason: "requires-missing", missing: requiresAll };
        }
        const missing = requiresAll.filter(name => !rosterSet.has(name));
        if (missing.length) {
            return { ok: false, reason: "requires-missing", missing };
        }
        reasons.push({ type: "requires", values: requiresAll });
    }

    const requiresAny = normalizeAwarenessList(predicates.requiresAny ?? predicates.any ?? predicates.oneOf ?? null);
    if (requiresAny.length) {
        const present = rosterSet ? requiresAny.filter(name => rosterSet.has(name)) : [];
        if (present.length === 0) {
            return { ok: false, reason: "requires-any", missing: requiresAny };
        }
        reasons.push({ type: "requires-any", values: requiresAny, matched: present });
    }

    const excludes = normalizeAwarenessList(predicates.excludes ?? predicates.absent ?? predicates.none ?? predicates.forbid ?? null);
    if (excludes.length && rosterSet) {
        const conflicts = excludes.filter(name => rosterSet.has(name));
        if (conflicts.length) {
            return { ok: false, reason: "awareness-excludes", conflicts };
        }
        reasons.push({ type: "excludes", values: excludes });
    }

    return {
        ok: true,
        reason: reasons.length ? "awareness-match" : "no-awareness",
        reasons,
        rosterSize: rosterSet ? rosterSet.size : 0,
    };
}

function buildOutfitMatchContext(options, normalizedName, profile) {
    const context = { name: normalizedName };

    if (options && typeof options.context === "object" && options.context !== null) {
        Object.assign(context, options.context);
    }

    if (typeof options?.text === "string") {
        context.text = options.text;
    }

    if (!context.matchKind && typeof options?.matchKind === "string") {
        context.matchKind = options.matchKind;
    }

    if (!context.text && typeof options?.buffer === "string") {
        context.text = options.buffer;
    }

    const bufKey = typeof options?.bufKey === "string" ? options.bufKey : state.currentGenerationKey;
    let messageState = options?.messageState || null;
    if (!messageState && bufKey && state.perMessageStates instanceof Map) {
        messageState = state.perMessageStates.get(bufKey) || null;
    }

    if (!context.text && bufKey && state.perMessageBuffers instanceof Map) {
        context.text = state.perMessageBuffers.get(bufKey) || "";
    }

    if (messageState) {
        context.messageState = messageState;
        if (!context.roster && messageState.sceneRoster instanceof Set) {
            context.roster = messageState.sceneRoster;
        }
        if (messageState.outfitRoster instanceof Map) {
            context.outfitRoster = messageState.outfitRoster;
        }
        if (!context.lastSubject && messageState.lastSubject) {
            context.lastSubject = messageState.lastSubject;
        }
    }

    if (!context.roster && profile?.enableSceneRoster && state.topSceneRanking instanceof Map) {
        const latestRoster = state.topSceneRanking.get(state.currentGenerationKey || "") || [];
        if (Array.isArray(latestRoster) && latestRoster.length) {
            context.roster = new Set(latestRoster.map(entry => entry.normalized?.toLowerCase?.() || entry.toLowerCase?.() || entry));
        }
    }

    context.rosterNormalized = buildLowercaseSet(context.roster);
    context.text = String(context.text || "");

    return context;
}

function resolveOutfitForMatch(rawName, options = {}) {
    const profile = options?.profile || getActiveProfile();
    const normalizedName = normalizeCostumeName(rawName);
    const now = Number.isFinite(options?.now) ? options.now : Date.now();

    if (!normalizedName || !profile) {
        return {
            folder: String(options?.fallbackFolder || normalizedName || "").trim(),
            reason: profile ? "no-name" : "no-profile",
            normalizedName,
            resolvedAt: now,
            variant: null,
            trigger: null,
            awareness: { ok: true, reason: "no-awareness", reasons: [] },
            label: null,
        };
    }

    const mapping = findMappingForName(profile, normalizedName);
    const defaultFolder = String(options?.fallbackFolder || mapping?.defaultFolder || mapping?.folder || normalizedName).trim();
    const baseResult = {
        folder: defaultFolder || normalizedName,
        reason: "default-folder",
        normalizedName,
        mapping,
        variant: null,
        trigger: null,
        awareness: { ok: true, reason: "no-awareness", reasons: [] },
        label: null,
        resolvedAt: now,
    };

    if (!profile.enableOutfits || !mapping || !Array.isArray(mapping.outfits) || mapping.outfits.length === 0) {
        return baseResult;
    }

    const context = buildOutfitMatchContext(options, normalizedName, profile);
    const matchKind = typeof context.matchKind === "string" ? context.matchKind.trim().toLowerCase() : (typeof options?.matchKind === "string" ? options.matchKind.trim().toLowerCase() : "");

    for (const variant of mapping.outfits) {
        if (!variant) continue;
        const folder = typeof variant.folder === "string" ? variant.folder.trim() : "";
        if (!folder) continue;

        const rawKinds = variant.matchKinds ?? variant.matchKind ?? variant.kinds ?? variant.kind ?? null;
        const allowedKinds = Array.isArray(rawKinds) ? rawKinds : (rawKinds ? [rawKinds] : []);
        if (allowedKinds.length) {
            const loweredKinds = allowedKinds.map(value => String(value ?? "").trim().toLowerCase()).filter(Boolean);
            if (!matchKind || (loweredKinds.length && !loweredKinds.includes(matchKind))) {
                continue;
            }
        }

        const triggerResult = evaluateOutfitTriggers(variant, context);
        if (!triggerResult.matched) {
            const hasTriggers = Array.isArray(variant.triggers) && variant.triggers.length > 0;
            if (hasTriggers) {
                continue;
            }
        }

        const awarenessResult = evaluateAwarenessPredicates(variant.awareness, context);
        if (!awarenessResult.ok) {
            continue;
        }

        const label = typeof variant.label === "string" && variant.label.trim()
            ? variant.label.trim()
            : (typeof variant.slot === "string" && variant.slot.trim() ? variant.slot.trim() : null);

        return {
            folder,
            reason: triggerResult.matched ? "trigger-match" : (awarenessResult.reason !== "no-awareness" ? "awareness-match" : "variant-default"),
            normalizedName,
            mapping,
            variant,
            trigger: triggerResult.matched ? {
                pattern: triggerResult.trigger,
                type: triggerResult.triggerType,
                index: triggerResult.matchIndex,
                snippet: triggerResult.snippet,
            } : null,
            awareness: awarenessResult,
            label,
            resolvedAt: now,
        };
    }

    return baseResult;
}

function ensureCharacterOutfitCache(runtimeState) {
    const target = runtimeState && typeof runtimeState === "object" ? runtimeState : state;
    if (!(target.characterOutfits instanceof Map)) {
        target.characterOutfits = new Map();
    }
    if (target !== state) {
        return target.characterOutfits;
    }
    state.characterOutfits = target.characterOutfits;
    return target.characterOutfits;
}

function updateMessageOutfitRoster(normalizedKey, outfitInfo, opts, profile) {
    if (!normalizedKey) {
        return;
    }

    const bufKey = typeof opts?.bufKey === "string" ? opts.bufKey : state.currentGenerationKey;
    let msgState = opts?.messageState || null;
    if (!msgState && bufKey && state.perMessageStates instanceof Map) {
        msgState = state.perMessageStates.get(bufKey) || null;
    }

    if (!msgState) {
        return;
    }

    if (!(msgState.outfitRoster instanceof Map)) {
        msgState.outfitRoster = new Map();
    }

    if (!outfitInfo || !outfitInfo.folder) {
        msgState.outfitRoster.delete(normalizedKey);
        return;
    }

    msgState.outfitRoster.set(normalizedKey, {
        folder: outfitInfo.folder,
        label: outfitInfo.label || null,
        reason: outfitInfo.reason || "default-folder",
        trigger: outfitInfo.trigger?.pattern || null,
        updatedAt: Number.isFinite(outfitInfo.resolvedAt) ? outfitInfo.resolvedAt : Date.now(),
        awareness: outfitInfo.awareness?.reason || "no-awareness",
    });

    if (typeof msgState.outfitTTL === "number") {
        msgState.outfitTTL = Number(profile?.sceneRosterTTL ?? PROFILE_DEFAULTS.sceneRosterTTL);
    }
}

function summarizeOutfitDecision(outfit, { separator = ' • ', includeLabel = true, includeFolder = false } = {}) {
    if (!outfit || typeof outfit !== 'object') {
        return '';
    }

    const parts = [];
    if (includeFolder && outfit.folder) {
        parts.push(`folder: ${outfit.folder}`);
    }
    if (includeLabel && outfit.label) {
        parts.push(`label: ${outfit.label}`);
    }
    if (outfit.reason) {
        parts.push(`reason: ${outfit.reason}`);
    }
    if (outfit.trigger && typeof outfit.trigger === 'object' && outfit.trigger.pattern) {
        parts.push(`trigger: ${outfit.trigger.pattern}`);
    }
    const awareness = outfit.awareness;
    if (awareness) {
        if (typeof awareness === 'string') {
            if (awareness && awareness !== 'no-awareness') {
                parts.push(`awareness: ${awareness}`);
            }
        } else if (typeof awareness === 'object') {
            const reason = awareness.reason || '';
            const details = Array.isArray(awareness.reasons)
                ? awareness.reasons.map(entry => entry?.type || '').filter(Boolean).join(', ')
                : '';
            if (reason && reason !== 'no-awareness') {
                parts.push(`awareness: ${details ? `${reason} (${details})` : reason}`);
            }
        }
    }
    return parts.join(separator);
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
    const normalizedKey = decision.name.toLowerCase();

    const lookupKey = normalizedKey;
    const mapped = state.mappingLookup instanceof Map ? state.mappingLookup.get(lookupKey) : null;
    let mappedFolder = String(mapped ?? decision.name).trim();
    if (!mappedFolder) {
        mappedFolder = decision.name;
    }

    if (profile.enableOutfits) {
        const outfitResult = resolveOutfitForMatch(decision.name, {
            profile,
            matchKind: opts.matchKind,
            bufKey: opts.bufKey,
            messageState: opts.messageState,
            context: opts.context,
            now,
            fallbackFolder: mappedFolder,
        });
        if (outfitResult && outfitResult.folder) {
            mappedFolder = outfitResult.folder;
        }
        if (outfitResult) {
            decision.outfit = outfitResult;
        }
    }

    const currentName = normalizeCostumeName(runtimeState.lastIssuedCostume || "");
    const lastIssuedFolder = typeof runtimeState.lastIssuedFolder === "string" ? runtimeState.lastIssuedFolder.trim() : "";

    if (!opts.isLock && !profile.enableOutfits && currentName && currentName.toLowerCase() === decision.name.toLowerCase()) {
        updateMessageOutfitRoster(normalizedKey, decision.outfit, opts, profile);
        return { shouldSwitch: false, reason: 'already-active', name: decision.name, now };
    }

    if (!opts.isLock && profile.enableOutfits) {
        const outfitCache = ensureCharacterOutfitCache(runtimeState);
        const cached = outfitCache.get(normalizedKey);
        const cachedFolder = typeof cached?.folder === "string" ? cached.folder.trim() : null;
        const normalizedMapped = mappedFolder ? mappedFolder.trim() : "";
        if (cachedFolder && normalizedMapped && cachedFolder.toLowerCase() === normalizedMapped.toLowerCase()) {
            const outfitInfo = decision.outfit || { folder: mappedFolder, reason: 'outfit-unchanged', resolvedAt: now };
            outfitInfo.folder = mappedFolder;
            outfitInfo.reason = outfitInfo.reason || 'outfit-unchanged';
            outfitInfo.resolvedAt = now;
            decision.outfit = outfitInfo;
            updateMessageOutfitRoster(normalizedKey, outfitInfo, opts, profile);
            return {
                shouldSwitch: false,
                reason: 'outfit-unchanged',
                name: decision.name,
                folder: mappedFolder,
                outfit: outfitInfo,
                now,
            };
        }
        if (
            lastIssuedFolder &&
            normalizedMapped &&
            lastIssuedFolder.toLowerCase() === normalizedMapped.toLowerCase() &&
            currentName &&
            currentName.toLowerCase() === decision.name.toLowerCase()
        ) {
            updateMessageOutfitRoster(normalizedKey, decision.outfit, opts, profile);
            return { shouldSwitch: false, reason: 'already-active', name: decision.name, folder: mappedFolder, now };
        }
    }

    if (!opts.isLock && profile.globalCooldownMs > 0 && (now - (runtimeState.lastSwitchTimestamp || 0) < profile.globalCooldownMs)) {
        updateMessageOutfitRoster(normalizedKey, decision.outfit, opts, profile);
        return { shouldSwitch: false, reason: 'global-cooldown', name: decision.name, folder: mappedFolder, now };
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
            updateMessageOutfitRoster(normalizedKey, decision.outfit, opts, profile);
            return { shouldSwitch: false, reason: 'per-trigger-cooldown', name: decision.name, folder: mappedFolder, now };
        }
    }

    if (!opts.isLock && profile.failedTriggerCooldownMs > 0) {
        const lastFailed = failedTriggerTimes.get(mappedFolder) || 0;
        if (now - lastFailed < profile.failedTriggerCooldownMs) {
            updateMessageOutfitRoster(normalizedKey, decision.outfit, opts, profile);
            return { shouldSwitch: false, reason: 'failed-trigger-cooldown', name: decision.name, folder: mappedFolder, now };
        }
    }

    const outfitInfo = decision.outfit || {
        folder: mappedFolder,
        reason: profile.enableOutfits ? 'variant-default' : 'default-folder',
        resolvedAt: now,
    };
    outfitInfo.folder = mappedFolder;
    outfitInfo.resolvedAt = now;
    decision.outfit = outfitInfo;
    updateMessageOutfitRoster(normalizedKey, outfitInfo, opts, profile);

    return { shouldSwitch: true, name: decision.name, folder: mappedFolder, outfit: outfitInfo, now };
}

async function issueCostumeForName(name, opts = {}) {
    const decision = evaluateSwitchDecision(name, opts);
    const normalizedKey = decision?.name ? decision.name.toLowerCase() : null;

    if (!decision.shouldSwitch) {
        debugLog("Switch skipped for", name, "reason:", decision.reason || 'n/a');
        if (decision.reason === 'outfit-unchanged' && decision.outfit?.folder && normalizedKey) {
            const outfitCache = ensureCharacterOutfitCache(state);
            outfitCache.set(normalizedKey, {
                folder: decision.outfit.folder,
                reason: decision.outfit.reason,
                label: decision.outfit.label || null,
                updatedAt: decision.now,
            });
        }
        return;
    }

    const command = `/costume \\${decision.folder}`;
    debugLog("Executing command:", command, "kind:", opts.matchKind || 'N/A');
    try {
        await executeSlashCommandsOnChatInput(command);
        state.lastTriggerTimes.set(decision.folder, decision.now);
        state.lastIssuedCostume = decision.name;
        state.lastIssuedFolder = decision.folder;
        state.lastSwitchTimestamp = decision.now;
        const outfitCache = ensureCharacterOutfitCache(state);
        if (normalizedKey) {
            outfitCache.set(normalizedKey, {
                folder: decision.folder,
                reason: decision.outfit?.reason || 'manual',
                label: decision.outfit?.label || null,
                updatedAt: decision.now,
            });
        }
        const profile = getActiveProfile();
        updateMessageOutfitRoster(normalizedKey, decision.outfit, opts, profile);
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
    enableOutfits: { selector: '#cs-outfits-enable', type: 'checkbox' },
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
        const outfitsData = $(this).data('outfits');
        const outfits = Array.isArray(outfitsData)
            ? (typeof structuredClone === 'function' ? structuredClone(outfitsData) : outfitsData.slice())
            : [];
        const mapping = normalizeMappingEntry({ name, defaultFolder: folder, outfits });
        if (mapping.name && mapping.defaultFolder) {
            profileData.mappings.push(mapping);
        }
    });
    return profileData;
}

const OUTFIT_MATCH_KIND_OPTIONS = [
    { value: "speaker", label: "Speaker tags (Name: \"Hello\")" },
    { value: "attribution", label: "Attribution cues (\"...\" she said)" },
    { value: "action", label: "Action narration (He nodded)" },
    { value: "pronoun", label: "Pronoun resolution" },
    { value: "vocative", label: "Vocative mentions (\"Hey, Alice!\")" },
    { value: "possessive", label: "Possessive mentions (Alice's staff)" },
    { value: "name", label: "General name hits (any mention)" },
];

function cloneOutfitList(outfits) {
    if (!Array.isArray(outfits)) {
        return [];
    }

    const cloned = [];
    outfits.forEach((entry) => {
        if (entry == null) {
            return;
        }
        if (typeof entry === 'string') {
            const trimmed = entry.trim();
            if (trimmed) {
                cloned.push(trimmed);
            }
            return;
        }
        if (typeof structuredClone === 'function') {
            try {
                cloned.push(structuredClone(entry));
                return;
            } catch (err) {
                // Fall back to JSON-based cloning
            }
        }
        try {
            cloned.push(JSON.parse(JSON.stringify(entry)));
        } catch (err) {
            if (typeof entry === 'object') {
                cloned.push({ ...entry });
            }
        }
    });

    return cloned;
}

function ensureAutoSaveState() {
    if (!state.autoSave) {
        state.autoSave = {
            timer: null,
            pendingReasons: new Set(),
            requiresRecompile: false,
            requiresMappingRebuild: false,
            requiresFocusLockRefresh: false,
            lastNoticeAt: new Map(),
        };
    }
    return state.autoSave;
}

function resetAutoSaveState() {
    const auto = ensureAutoSaveState();
    if (auto.timer) {
        clearTimeout(auto.timer);
        auto.timer = null;
    }
    auto.pendingReasons.clear();
    auto.requiresRecompile = false;
    auto.requiresMappingRebuild = false;
    auto.requiresFocusLockRefresh = false;
}

function syncMappingRowsWithProfile(profile) {
    const rows = $("#cs-mappings-tbody tr");
    if (!rows.length) {
        return;
    }
    rows.each(function(index) {
        const mapping = Array.isArray(profile?.mappings) ? profile.mappings[index] : null;
        if (!mapping) {
            $(this).data('outfits', []);
            return;
        }
        const outfits = cloneOutfitList(mapping.outfits);
        $(this).data('outfits', outfits);
    });
}

function formatAutoSaveReason(key) {
    if (!key) {
        return 'changes';
    }
    if (AUTO_SAVE_REASON_OVERRIDES[key]) {
        return AUTO_SAVE_REASON_OVERRIDES[key];
    }
    if (key.startsWith('priority')) {
        return 'scoring weights';
    }
    if (key.includes('roster')) {
        return 'roster tuning';
    }
    if (key.includes('weight')) {
        return 'scoring weights';
    }
    return key.replace(/([A-Z])/g, ' $1').trim().toLowerCase();
}

function summarizeAutoSaveReasons(reasonSet) {
    const list = Array.from(reasonSet || []).filter(Boolean);
    if (!list.length) {
        return 'changes';
    }
    if (list.length === 1) {
        return list[0];
    }
    const head = list.slice(0, -1).join(', ');
    const tail = list[list.length - 1];
    return head ? `${head} and ${tail}` : tail;
}

function announceAutoSaveIntent(target, reason, message, key) {
    const auto = ensureAutoSaveState();
    const noticeKey = key
        || target?.dataset?.changeNoticeKey
        || target?.id
        || target?.name
        || (reason ? reason.replace(/\s+/g, '-') : 'auto-save');
    const now = Date.now();
    const last = auto.lastNoticeAt.get(noticeKey);
    if (last && now - last < AUTO_SAVE_NOTICE_COOLDOWN_MS) {
        return;
    }
    auto.lastNoticeAt.set(noticeKey, now);
    const noticeMessage = message
        || target?.dataset?.changeNotice
        || (reason ? `Auto-saving ${reason}…` : 'Auto-saving changes…');
    showStatus(noticeMessage, 'info', 2000);
}

function scheduleProfileAutoSave(options = {}) {
    const auto = ensureAutoSaveState();
    const reasonText = options.reason || formatAutoSaveReason(options.key);
    if (reasonText) {
        auto.pendingReasons.add(reasonText);
    }
    if (options.requiresRecompile) {
        auto.requiresRecompile = true;
    }
    if (options.requiresMappingRebuild) {
        auto.requiresMappingRebuild = true;
    }
    if (options.requiresFocusLockRefresh) {
        auto.requiresFocusLockRefresh = true;
    }
    if (options.element || options.noticeMessage || reasonText) {
        announceAutoSaveIntent(options.element, reasonText, options.noticeMessage, options.noticeKey || options.key);
    }
    if (auto.timer) {
        clearTimeout(auto.timer);
    }
    auto.timer = setTimeout(() => {
        flushScheduledProfileAutoSave({});
    }, AUTO_SAVE_DEBOUNCE_MS);
}

function flushScheduledProfileAutoSave({ overrideMessage, showStatusMessage = true, force = false } = {}) {
    const auto = ensureAutoSaveState();
    const hasPending = auto.pendingReasons.size > 0
        || auto.requiresRecompile
        || auto.requiresMappingRebuild
        || auto.requiresFocusLockRefresh;
    if (!hasPending && !force) {
        return false;
    }
    const summary = summarizeAutoSaveReasons(auto.pendingReasons);
    const message = overrideMessage !== undefined
        ? overrideMessage
        : (hasPending ? `Auto-saved ${summary}.` : null);
    return commitProfileChanges({
        message,
        showStatusMessage: showStatusMessage && Boolean(message),
        recompile: auto.requiresRecompile,
        rebuildMappings: auto.requiresMappingRebuild && !auto.requiresRecompile,
        refreshFocusLock: auto.requiresFocusLockRefresh,
    });
}

function commitProfileChanges({
    message,
    messageType = 'success',
    recompile = false,
    rebuildMappings = false,
    refreshFocusLock = false,
    showStatusMessage = true,
} = {}) {
    const profile = getActiveProfile();
    if (!profile) {
        resetAutoSaveState();
        return false;
    }
    const normalized = normalizeProfile(saveCurrentProfileData(), PROFILE_DEFAULTS);
    const mappings = Array.isArray(normalized.mappings) ? normalized.mappings : [];
    mappings.forEach(ensureMappingCardId);
    Object.assign(profile, normalized);
    profile.mappings = mappings;
    syncMappingRowsWithProfile(profile);
    if (recompile) {
        recompileRegexes();
        refreshCoverageFromLastReport();
    } else if (rebuildMappings) {
        rebuildMappingLookup(profile);
    }
    if (refreshFocusLock) {
        updateFocusLockUI();
    }
    resetAutoSaveState();
    if (showStatusMessage && message) {
        persistSettings(message, messageType);
    } else {
        saveSettingsDebounced();
    }
    return true;
}

function handleAutoSaveFieldEvent(event, key) {
    if (!event || !key) {
        return;
    }
    scheduleProfileAutoSave({
        key,
        element: event.currentTarget,
        requiresRecompile: AUTO_SAVE_RECOMPILE_KEYS.has(key),
        requiresFocusLockRefresh: AUTO_SAVE_FOCUS_LOCK_KEYS.has(key),
    });
}

function gatherVariantStringList(value) {
    const results = [];
    const visit = (entry) => {
        if (entry == null) {
            return;
        }
        if (Array.isArray(entry)) {
            entry.forEach(visit);
            return;
        }
        if (typeof entry === "string") {
            entry.split(/\r?\n|,/).forEach((part) => {
                const trimmed = part.trim();
                if (trimmed) {
                    results.push(trimmed);
                }
            });
        }
    };
    visit(value);
    return [...new Set(results)];
}

function normalizeOutfitVariant(rawVariant = {}) {
    if (rawVariant == null) {
        return { folder: '', triggers: [] };
    }

    if (typeof rawVariant === 'string') {
        return { folder: rawVariant.trim(), triggers: [] };
    }

    let variant;
    if (typeof structuredClone === 'function') {
        try {
            variant = structuredClone(rawVariant);
        } catch (err) {
            // Ignore and fall back to JSON cloning
        }
    }
    if (!variant) {
        try {
            variant = JSON.parse(JSON.stringify(rawVariant));
        } catch (err) {
            variant = { ...rawVariant };
        }
    }

    const normalized = typeof variant === 'object' && variant !== null ? variant : {};
    const folder = typeof normalized.folder === 'string' ? normalized.folder.trim() : '';
    normalized.folder = folder;

    const slot = typeof normalized.slot === 'string' ? normalized.slot.trim() : '';
    const labelSource = typeof normalized.label === 'string' ? normalized.label.trim()
        : (typeof normalized.name === 'string' ? normalized.name.trim()
            : slot);
    if (labelSource) {
        normalized.label = labelSource;
    } else {
        delete normalized.label;
    }
    if (slot) {
        normalized.slot = slot;
    } else {
        delete normalized.slot;
    }

    const uniqueTriggers = gatherVariantStringList([
        normalized.triggers,
        normalized.patterns,
        normalized.matchers,
        normalized.trigger,
        normalized.matcher,
    ]);
    normalized.triggers = uniqueTriggers;
    delete normalized.patterns;
    delete normalized.matchers;
    delete normalized.trigger;
    delete normalized.matcher;

    const matchKinds = gatherVariantStringList([
        normalized.matchKinds,
        normalized.matchKind,
        normalized.kinds,
        normalized.kind,
    ]).map((value) => value.toLowerCase());
    const uniqueMatchKinds = [...new Set(matchKinds)];
    if (uniqueMatchKinds.length) {
        normalized.matchKinds = uniqueMatchKinds;
    } else {
        delete normalized.matchKinds;
    }
    delete normalized.matchKind;
    delete normalized.kinds;
    delete normalized.kind;

    const awarenessSource = typeof normalized.awareness === 'object' && normalized.awareness !== null
        ? normalized.awareness
        : {};
    const normalizedAwareness = {};
    const requiresAll = gatherVariantStringList([
        awarenessSource.requires,
        awarenessSource.requiresAll,
        awarenessSource.all,
        normalized.requires,
        normalized.requiresAll,
        normalized.all,
    ]);
    if (requiresAll.length) {
        normalizedAwareness.requires = requiresAll;
    }
    const requiresAny = gatherVariantStringList([
        awarenessSource.requiresAny,
        awarenessSource.any,
        awarenessSource.oneOf,
        normalized.requiresAny,
        normalized.any,
        normalized.oneOf,
    ]);
    if (requiresAny.length) {
        normalizedAwareness.requiresAny = requiresAny;
    }
    const excludes = gatherVariantStringList([
        awarenessSource.excludes,
        awarenessSource.absent,
        awarenessSource.none,
        awarenessSource.forbid,
        normalized.excludes,
        normalized.absent,
        normalized.none,
        normalized.forbid,
    ]);
    if (excludes.length) {
        normalizedAwareness.excludes = excludes;
    }
    if (Object.keys(normalizedAwareness).length) {
        normalized.awareness = normalizedAwareness;
    } else {
        delete normalized.awareness;
    }
    delete normalized.requires;
    delete normalized.requiresAll;
    delete normalized.all;
    delete normalized.requiresAny;
    delete normalized.any;
    delete normalized.oneOf;
    delete normalized.excludes;
    delete normalized.absent;
    delete normalized.none;
    delete normalized.forbid;

    return normalized;
}

function extractDirectoryFromFileList(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) {
        return '';
    }
    const file = files[0];
    if (file && typeof file.webkitRelativePath === 'string' && file.webkitRelativePath) {
        const segments = file.webkitRelativePath.split('/');
        if (segments.length > 1) {
            segments.pop();
            return segments.join('/');
        }
        return file.webkitRelativePath;
    }
    if (file && typeof file.name === 'string') {
        return file.name;
    }
    return '';
}

function buildVariantFolderPath(characterName, folderPath) {
    const rawFolder = (folderPath || "").trim();
    if (!rawFolder) {
        return "";
    }
    let normalizedFolder = rawFolder.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (!normalizedFolder) {
        return "";
    }
    const rawName = (characterName || "").trim();
    if (!rawName) {
        return normalizedFolder;
    }
    const normalizedName = rawName.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (!normalizedName) {
        return normalizedFolder;
    }
    if (normalizedFolder === normalizedName || normalizedFolder.startsWith(`${normalizedName}/`)) {
        return normalizedFolder;
    }
    return `${normalizedName}/${normalizedFolder}`;
}

function getMappingRow(idx) {
    const rows = $("#cs-mappings-tbody tr");
    const row = rows.eq(idx);
    return row.length ? row : $();
}

function syncMappingRowName(idx, name) {
    const row = getMappingRow(idx);
    if (!row.length) return;
    row.find('.map-name').val(name);
}

function syncMappingRowFolder(idx, folder) {
    const row = getMappingRow(idx);
    if (!row.length) return;
    row.find('.map-folder').val(folder);
}

function syncMappingRowOutfits(idx, outfits) {
    const row = getMappingRow(idx);
    if (!row.length) return;
    row.data('outfits', cloneOutfitList(outfits));
}

function updateOutfitLabEnabledState(enabled) {
    const editor = $('#cs-outfit-editor');
    const notice = $('#cs-outfit-disabled-notice');
    const addButton = $('#cs-outfit-add-character');
    const isEnabled = Boolean(enabled);
    if (editor.length) {
        editor.toggleClass('is-disabled', !isEnabled);
        editor.attr('aria-disabled', String(!isEnabled));
    }
    if (notice.length) {
        notice.prop('hidden', isEnabled);
    }
    if (addButton.length) {
        addButton.prop('disabled', !isEnabled);
    }
}

function createOutfitVariantElement(profile, mapping, mappingIdx, variant, variantIndex) {
    const normalized = (mapping?.outfits && mapping.outfits[variantIndex] === variant)
        ? variant
        : normalizeOutfitVariant(variant);

    if (!Array.isArray(mapping.outfits)) {
        mapping.outfits = [];
    }
    mapping.outfits[variantIndex] = normalized;

    const variantEl = $('<div>')
        .addClass('cs-outfit-variant')
        .attr('data-variant-index', variantIndex)
        .data('variant', normalized);

    const markVariantDirty = (element) => {
        scheduleProfileAutoSave({
            reason: 'character mappings',
            element,
            requiresMappingRebuild: true,
        });
    };

    const header = $('<div>').addClass('cs-outfit-variant-header');
    header.append($('<h4>').text(`Variation ${variantIndex + 1}`));
    const removeButton = $('<button>', {
        type: 'button',
        class: 'menu_button interactable cs-outfit-variant-remove cs-button-danger',
    })
        .attr('data-change-notice', 'Removing this variation auto-saves your mappings.')
        .attr('data-change-notice-key', `variant-remove-${mappingIdx}`)
        .append($('<i>').addClass('fa-solid fa-trash-can'), $('<span>').text('Remove'));
    header.append(removeButton);
    variantEl.append(header);

    const grid = $('<div>').addClass('cs-outfit-variant-grid');
    const labelId = `cs-outfit-variant-label-${mappingIdx}-${variantIndex}`;
    const labelField = $('<div>').addClass('cs-field')
        .append($('<label>', { for: labelId, text: 'Label (optional)' }));
    const labelInput = $('<input>', {
        id: labelId,
        type: 'text',
        placeholder: 'Display name',
    }).addClass('text_pole cs-outfit-variant-label')
        .val(normalized.label || normalized.slot || '');
    labelField.append(labelInput);

    const folderId = `cs-outfit-variant-folder-${mappingIdx}-${variantIndex}`;
    const folderField = $('<div>').addClass('cs-field')
        .append($('<label>', { for: folderId, text: 'Folder' }));
    const folderRow = $('<div>').addClass('cs-outfit-folder-row');
    const folderInput = $('<input>', {
        id: folderId,
        type: 'text',
        placeholder: 'Enter folder path…',
    }).addClass('text_pole cs-outfit-variant-folder')
        .val(normalized.folder || '');
    const folderPicker = $('<input>', { type: 'file', hidden: true });
    folderPicker.attr({ webkitdirectory: 'true', directory: 'true', multiple: 'true' });
    const folderButton = $('<button>', {
        type: 'button',
        class: 'menu_button interactable cs-outfit-pick-folder',
    }).append($('<i>').addClass('fa-solid fa-folder-open'), $('<span>').text('Pick Folder'))
        .on('click', () => folderPicker.trigger('click'));
    folderPicker.on('change', function() {
        const folderPath = extractDirectoryFromFileList(this.files || []);
        if (folderPath) {
            const combinedPath = buildVariantFolderPath(mapping?.name, folderPath);
            folderInput.val(combinedPath);
            folderInput.trigger('input');
        }
        $(this).val('');
    });
    folderRow.append(folderInput, folderButton, folderPicker);
    folderField.append(folderRow);

    grid.append(labelField, folderField);
    variantEl.append(grid);

    const triggerId = `cs-outfit-variant-triggers-${mappingIdx}-${variantIndex}`;
    const triggerField = $('<div>').addClass('cs-field')
        .append($('<label>', { for: triggerId, text: 'Triggers' }));
    const triggerTextarea = $('<textarea>', {
        id: triggerId,
        rows: 3,
        placeholder: 'One trigger per line',
    }).addClass('text_pole cs-outfit-variant-triggers')
        .val((normalized.triggers || []).join('\n'));
    triggerField.append(triggerTextarea);
    triggerField.append($('<small>').text('Trigger keywords or /regex/ patterns that activate this outfit.'));
    variantEl.append(triggerField);

    const matchKindField = $('<div>').addClass('cs-field cs-outfit-matchkind');
    matchKindField.append($('<label>').text('Match Types (optional)'));
    const matchKindList = $('<div>').addClass('cs-outfit-matchkind-options');
    const selectedKinds = new Set((Array.isArray(normalized.matchKinds) ? normalized.matchKinds : []).map((value) => String(value).toLowerCase()));
    OUTFIT_MATCH_KIND_OPTIONS.forEach((option) => {
        const checkboxId = `cs-outfit-variant-kind-${mappingIdx}-${variantIndex}-${option.value}`;
        const optionLabel = $('<label>', { class: 'cs-outfit-matchkind-option', for: checkboxId });
        const checkbox = $('<input>', {
            type: 'checkbox',
            id: checkboxId,
            value: option.value,
        }).prop('checked', selectedKinds.has(option.value));
        const text = $('<span>').text(option.label);
        optionLabel.append(checkbox, text);
        matchKindList.append(optionLabel);
        checkbox.on('change', () => {
            const checked = matchKindList.find('input:checked').map((_, el) => el.value).get();
            if (checked.length) {
                normalized.matchKinds = checked;
            } else {
                delete normalized.matchKinds;
            }
            syncMappingRowOutfits(mappingIdx, mapping.outfits);
            markVariantDirty(checkbox[0]);
        });
    });
    matchKindField.append(matchKindList);
    matchKindField.append($('<small>').text('Limit this variant to detections from specific match types. Leave unchecked to accept any match.'));
    variantEl.append(matchKindField);

    const awarenessField = $('<div>').addClass('cs-field cs-outfit-awareness');
    awarenessField.append($('<label>').text('Scene Awareness (optional)'));
    const awarenessGrid = $('<div>').addClass('cs-outfit-awareness-grid');
    const awarenessState = typeof normalized.awareness === 'object' && normalized.awareness !== null ? normalized.awareness : {};
    const requiresId = `cs-outfit-variant-requires-${mappingIdx}-${variantIndex}`;
    const requiresField = $('<div>').addClass('cs-field cs-outfit-awareness-field')
        .append($('<label>', { for: requiresId, text: 'Requires all of…' }));
    const requiresTextarea = $('<textarea>', {
        id: requiresId,
        rows: 2,
        placeholder: 'One name per line',
    }).addClass('text_pole cs-outfit-awareness-input')
        .val(Array.isArray(awarenessState.requires) ? awarenessState.requires.join('\n') : '');
    requiresField.append(requiresTextarea);
    requiresField.append($('<small>').text('Every listed character must be active in the scene roster.'));

    const anyId = `cs-outfit-variant-any-${mappingIdx}-${variantIndex}`;
    const anyField = $('<div>').addClass('cs-field cs-outfit-awareness-field')
        .append($('<label>', { for: anyId, text: 'Requires any of…' }));
    const anyTextarea = $('<textarea>', {
        id: anyId,
        rows: 2,
        placeholder: 'One name per line',
    }).addClass('text_pole cs-outfit-awareness-input')
        .val(Array.isArray(awarenessState.requiresAny) ? awarenessState.requiresAny.join('\n') : '');
    anyField.append(anyTextarea);
    anyField.append($('<small>').text('At least one of these characters must be active.'));

    const excludesId = `cs-outfit-variant-excludes-${mappingIdx}-${variantIndex}`;
    const excludesField = $('<div>').addClass('cs-field cs-outfit-awareness-field')
        .append($('<label>', { for: excludesId, text: 'Exclude when present' }));
    const excludesTextarea = $('<textarea>', {
        id: excludesId,
        rows: 2,
        placeholder: 'One name per line',
    }).addClass('text_pole cs-outfit-awareness-input')
        .val(Array.isArray(awarenessState.excludes) ? awarenessState.excludes.join('\n') : '');
    excludesField.append(excludesTextarea);
    excludesField.append($('<small>').text('Leave blank if the variant should ignore scene roster conflicts.'));

    awarenessGrid.append(requiresField, anyField, excludesField);
    awarenessField.append(awarenessGrid);
    awarenessField.append($('<small>').text('Scene awareness relies on the Scene Roster detector setting. Names are matched case-insensitively.'));
    variantEl.append(awarenessField);

    const parseListInput = (value) => value
        .split(/\r?\n|,/)
        .map((entry) => entry.trim())
        .filter(Boolean);

    const updateAwarenessState = () => {
        const requiresList = parseListInput(requiresTextarea.val());
        const anyList = parseListInput(anyTextarea.val());
        const excludesList = parseListInput(excludesTextarea.val());
        const next = {};
        if (requiresList.length) {
            next.requires = requiresList;
        }
        if (anyList.length) {
            next.requiresAny = anyList;
        }
        if (excludesList.length) {
            next.excludes = excludesList;
        }
        if (Object.keys(next).length) {
            normalized.awareness = next;
        } else {
            delete normalized.awareness;
        }
        syncMappingRowOutfits(mappingIdx, mapping.outfits);
    };

    const handleAwarenessInput = function() {
        updateAwarenessState();
        markVariantDirty(this);
    };

    requiresTextarea.on('input', handleAwarenessInput);
    anyTextarea.on('input', handleAwarenessInput);
    excludesTextarea.on('input', handleAwarenessInput);

    labelInput.on('input', () => {
        const value = labelInput.val().trim();
        if (value) {
            normalized.label = value;
        } else {
            delete normalized.label;
        }
        syncMappingRowOutfits(mappingIdx, mapping.outfits);
        markVariantDirty(labelInput[0]);
    });

    folderInput.on('input', () => {
        normalized.folder = folderInput.val().trim();
        syncMappingRowOutfits(mappingIdx, mapping.outfits);
        markVariantDirty(folderInput[0]);
    });

    triggerTextarea.on('input', () => {
        const triggers = triggerTextarea.val()
            .split(/\r?\n/)
            .map(value => value.trim())
            .filter(Boolean);
        normalized.triggers = triggers;
        syncMappingRowOutfits(mappingIdx, mapping.outfits);
        markVariantDirty(triggerTextarea[0]);
    });

    removeButton.on('click', () => {
        announceAutoSaveIntent(removeButton[0], 'character mappings', removeButton[0].dataset.changeNotice, removeButton[0].dataset.changeNoticeKey);
        const activeProfile = profile || getActiveProfile();
        if (!activeProfile?.mappings?.[mappingIdx]) {
            return;
        }
        activeProfile.mappings[mappingIdx].outfits.splice(variantIndex, 1);
        syncMappingRowOutfits(mappingIdx, activeProfile.mappings[mappingIdx].outfits);
        variantEl.remove();
        const card = $(`.cs-outfit-card[data-idx="${mappingIdx}"]`);
        const variantContainer = card.find('.cs-outfit-variants');
        variantContainer.find('.cs-outfit-variant').each(function(index) {
            $(this).attr('data-variant-index', index);
            $(this).find('.cs-outfit-variant-header h4').text(`Variation ${index + 1}`);
        });
        if (!variantContainer.find('.cs-outfit-variant').length) {
            variantContainer.append($('<div>').addClass('cs-outfit-empty-variants').text('No variations yet. Add one to test trigger-based outfits.'));
        }
        markVariantDirty(removeButton[0]);
    });

    return variantEl;
}

function createOutfitCard(profile, mapping, idx) {
    let cardId = ensureMappingCardId(mapping);
    if (!cardId) {
        cardId = `cs-outfit-card-${Date.now()}-${nextOutfitCardId++}`;
    }

    const card = $('<article>').addClass('cs-outfit-card')
        .attr('data-idx', idx)
        .attr('data-card-id', cardId);
    const header = $('<div>').addClass('cs-outfit-card-header');
    const title = $('<div>').addClass('cs-outfit-card-title');
    title.append($('<i>').addClass('fa-solid fa-user-astronaut'));

    const nameId = `cs-outfit-name-${idx}`;
    const nameField = $('<div>').addClass('cs-field')
        .append($('<label>', { for: nameId, text: 'Character Name' }));
    const nameInput = $('<input>', {
        id: nameId,
        type: 'text',
        placeholder: 'e.g., Alice',
    }).addClass('text_pole cs-outfit-character-name')
        .val(mapping.name || '');
    nameField.append(nameInput);
    title.append(nameField);
    header.append(title);

    const controls = $('<div>').addClass('cs-outfit-card-controls');

    const bodyId = `${cardId}-body`;
    const toggleLabel = $('<span>').text('Collapse');
    const toggleButton = $('<button>', {
        type: 'button',
        class: 'menu_button interactable cs-outfit-card-toggle',
        'aria-expanded': 'true',
        'aria-controls': bodyId,
    }).append($('<i>').addClass('fa-solid fa-chevron-down'), toggleLabel);
    controls.append(toggleButton);

    const removeButton = $('<button>', {
        type: 'button',
        class: 'menu_button interactable cs-button-danger cs-outfit-remove-character',
    })
        .attr('data-change-notice', 'Removing this character saves your mappings immediately.')
        .attr('data-change-notice-key', `${cardId}-remove`)
        .append($('<i>').addClass('fa-solid fa-trash-can'), $('<span>').text('Remove Character'))
        .on('click', () => {
            announceAutoSaveIntent(removeButton[0], 'character mappings', removeButton[0].dataset.changeNotice, removeButton[0].dataset.changeNoticeKey);
            if (!profile?.mappings) return;
            state.outfitCardCollapse?.delete(cardId);
            profile.mappings.splice(idx, 1);
            renderMappings(profile);
            rebuildMappingLookup(profile);
            scheduleProfileAutoSave({
                reason: 'character mappings',
                element: removeButton[0],
                requiresMappingRebuild: true,
            });
        });
    controls.append(removeButton);
    header.append(controls);
    card.append(header);

    const body = $('<div>', { id: bodyId }).addClass('cs-outfit-card-body');

    const defaultId = `cs-outfit-default-${idx}`;
    const defaultField = $('<div>').addClass('cs-field')
        .append($('<label>', { for: defaultId, text: 'Default Folder' }));
    const defaultRow = $('<div>').addClass('cs-outfit-folder-row');
    const defaultInput = $('<input>', {
        id: defaultId,
        type: 'text',
        placeholder: 'Enter folder path…',
    }).addClass('text_pole cs-outfit-default-folder')
        .val(mapping.defaultFolder || '');
    const defaultPicker = $('<input>', { type: 'file', hidden: true });
    defaultPicker.attr({ webkitdirectory: 'true', directory: 'true', multiple: 'true' });
    const defaultButton = $('<button>', {
        type: 'button',
        class: 'menu_button interactable cs-outfit-pick-folder',
    }).append($('<i>').addClass('fa-solid fa-folder-open'), $('<span>').text('Pick Folder'))
        .on('click', () => defaultPicker.trigger('click'));
    defaultPicker.on('change', function() {
        const folderPath = extractDirectoryFromFileList(this.files || []);
        if (folderPath) {
            defaultInput.val(folderPath);
            defaultInput.trigger('input');
        }
        $(this).val('');
    });
    defaultRow.append(defaultInput, defaultButton, defaultPicker);
    defaultField.append(defaultRow);
    defaultField.append($('<small>').text('Fallback folder when no variation triggers.'));
    body.append(defaultField);

    const variantsContainer = $('<div>').addClass('cs-outfit-variants');
    if (!Array.isArray(mapping.outfits) || !mapping.outfits.length) {
        mapping.outfits = [];
        variantsContainer.append($('<div>').addClass('cs-outfit-empty-variants').text('No variations yet. Add one to test trigger-based outfits.'));
    } else {
        mapping.outfits.forEach((variant, variantIndex) => {
            variantsContainer.append(createOutfitVariantElement(profile, mapping, idx, variant, variantIndex));
        });
    }
    body.append(variantsContainer);

    const addVariantButton = $('<button>', {
        type: 'button',
        class: 'menu_button interactable cs-outfit-add-variant',
    })
        .attr('data-change-notice', 'Adding a variation auto-saves this character slot.')
        .attr('data-change-notice-key', `${cardId}-add-variant`)
        .append($('<i>').addClass('fa-solid fa-plus'), $('<span>').text('Add Outfit Variation'))
        .on('click', () => {
            announceAutoSaveIntent(addVariantButton[0], 'character mappings', addVariantButton[0].dataset.changeNotice, addVariantButton[0].dataset.changeNoticeKey);
            if (!Array.isArray(mapping.outfits)) {
                mapping.outfits = [];
            }
            const variantIndex = mapping.outfits.length;
            const newVariant = normalizeOutfitVariant({ folder: '', triggers: [] });
            mapping.outfits.push(newVariant);
            variantsContainer.find('.cs-outfit-empty-variants').remove();
            const variantEl = createOutfitVariantElement(profile, mapping, idx, newVariant, variantIndex);
            variantsContainer.append(variantEl);
            syncMappingRowOutfits(idx, mapping.outfits);
            setCollapsed(false);
            variantEl.find('.cs-outfit-variant-folder').trigger('focus');
            scheduleProfileAutoSave({
                reason: 'character mappings',
                element: addVariantButton[0],
                requiresMappingRebuild: true,
            });
        });
    body.append(addVariantButton);

    card.append(body);

    const ensureCollapseStore = () => {
        if (!(state.outfitCardCollapse instanceof Map)) {
            state.outfitCardCollapse = new Map();
        }
        return state.outfitCardCollapse;
    };

    const setCollapsed = (collapsed) => {
        const isCollapsed = Boolean(collapsed);
        card.toggleClass('is-collapsed', isCollapsed);
        body.toggleClass('is-collapsed', isCollapsed);
        if (isCollapsed) {
            body.attr('hidden', 'hidden');
            body.attr('aria-hidden', 'true');
            body.css('display', 'none');
            toggleButton.attr('aria-expanded', 'false');
            toggleButton.attr('title', 'Expand character slot');
            toggleButton.attr('aria-label', 'Expand character slot');
            toggleLabel.text('Expand');
            ensureCollapseStore().set(cardId, true);
        } else {
            body.removeAttr('hidden');
            body.attr('aria-hidden', 'false');
            body.css('display', '');
            toggleButton.attr('aria-expanded', 'true');
            toggleButton.attr('title', 'Collapse character slot');
            toggleButton.attr('aria-label', 'Collapse character slot');
            toggleLabel.text('Collapse');
            ensureCollapseStore().set(cardId, false);
        }
    };

    toggleButton.on('click', () => {
        const nextCollapsed = !card.hasClass('is-collapsed');
        setCollapsed(nextCollapsed);
    });

    nameInput.on('input', () => {
        mapping.name = nameInput.val().trim();
        syncMappingRowName(idx, nameInput.val());
        scheduleProfileAutoSave({
            reason: 'character mappings',
            element: nameInput[0],
            requiresMappingRebuild: true,
        });
    });
    nameInput.on('change', () => {
        rebuildMappingLookup(profile);
        scheduleProfileAutoSave({
            reason: 'character mappings',
            element: nameInput[0],
            requiresMappingRebuild: true,
        });
    });

    defaultInput.on('input', () => {
        const value = defaultInput.val().trim();
        mapping.defaultFolder = value;
        mapping.folder = value;
        syncMappingRowFolder(idx, defaultInput.val());
        scheduleProfileAutoSave({
            reason: 'character mappings',
            element: defaultInput[0],
            requiresMappingRebuild: true,
        });
    });
    defaultInput.on('change', () => {
        rebuildMappingLookup(profile);
        scheduleProfileAutoSave({
            reason: 'character mappings',
            element: defaultInput[0],
            requiresMappingRebuild: true,
        });
    });

    const collapseStore = ensureCollapseStore();
    let collapsed = true;
    if (collapseStore.has(cardId)) {
        collapsed = collapseStore.get(cardId) === true;
    }
    setCollapsed(collapsed);
    if (mapping && Object.prototype.hasOwnProperty.call(mapping, "__startCollapsed")) {
        try {
            delete mapping.__startCollapsed;
        } catch (err) {
            mapping.__startCollapsed = undefined;
        }
    }
    syncMappingRowOutfits(idx, mapping.outfits);

    return card;
}

function renderOutfitLab(profile) {
    const container = $('#cs-outfit-character-list');
    if (!container.length) {
        return;
    }

    container.empty();
    const mappings = Array.isArray(profile?.mappings) ? profile.mappings : [];
    if (!mappings.length) {
        const emptyText = container.attr('data-empty-text') || 'No characters configured yet.';
        container.append($('<div>').addClass('cs-outfit-empty').text(emptyText));
    } else {
        mappings.forEach((entry, idx) => {
            const normalized = normalizeMappingEntry(entry);
            if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, '__cardId') && !Object.prototype.hasOwnProperty.call(normalized, '__cardId')) {
                Object.defineProperty(normalized, '__cardId', {
                    value: entry.__cardId,
                    enumerable: false,
                    configurable: true,
                });
            }
            profile.mappings[idx] = normalized;
            container.append(createOutfitCard(profile, normalized, idx));
        });
    }

    updateOutfitLabEnabledState(profile?.enableOutfits);
}

function renderMappings(profile) {
    const tbody = $("#cs-mappings-tbody");
    tbody.empty();
    (profile.mappings || []).forEach((m, idx) => {
        const normalized = normalizeMappingEntry(m);
        profile.mappings[idx] = normalized;
        const row = $("<tr>").attr("data-idx", idx);
        const outfits = Array.isArray(normalized.outfits)
            ? (typeof structuredClone === 'function' ? structuredClone(normalized.outfits) : normalized.outfits.slice())
            : [];
        row.data('outfits', outfits);
        row.append($("<td>").append($("<input>").addClass("map-name text_pole").val(normalized.name || "")));
        row.append($("<td>").append($("<input>").addClass("map-folder text_pole").val(normalized.defaultFolder || normalized.folder || "")));
        row.append($("<td>").append($("<button>").addClass("map-remove menu_button interactable").html('<i class="fa-solid fa-trash-can"></i>')));
        tbody.append(row);
    });
    renderOutfitLab(profile);
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
        'outfit-unchanged': 'already wearing the selected outfit',
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

    const mergedDetections = mergeDetectionsForReport(report);
    const detectionLookup = new Map(
        mergedDetections.map(entry => [String(entry.name || '').toLowerCase(), entry.name])
    );
    lines.push('Detections:');
    if (mergedDetections.length) {
        mergedDetections.forEach((m, idx) => {
            const charPos = Number.isFinite(m.matchIndex) ? m.matchIndex + 1 : '?';
            const priorityLabel = Number.isFinite(m.priority) ? m.priority : 'n/a';
            lines.push(`  ${idx + 1}. ${m.name} – ${m.matchKind || 'unknown'} @ char ${charPos} (priority ${priorityLabel})`);
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
                const outfitSummary = summarizeOutfitDecision(event.outfit, { separator: '; ', includeFolder: false });
                const outfitNote = outfitSummary ? ` [${outfitSummary}]` : '';
                lines.push(`  ${idx + 1}. SWITCH → ${event.folder} (name: ${event.name}${detail}, char ${charPos}${score})${outfitNote}`);
            } else if (event.type === 'veto') {
                const charPos = Number.isFinite(event.charIndex) ? event.charIndex + 1 : '?';
                lines.push(`  ${idx + 1}. VETO – matched "${event.match}" at char ${charPos}`);
            } else {
                const reason = describeSkipReason(event.reason);
                const outfitSummary = summarizeOutfitDecision(event.outfit, { separator: '; ', includeFolder: false });
                const outfitNote = outfitSummary ? ` [${outfitSummary}]` : '';
                lines.push(`  ${idx + 1}. SKIP – ${event.name} (${event.matchKind}) because ${reason}${outfitNote}`);
            }
        });
    } else {
        lines.push('  (none)');
    }

    const detectionSummary = summarizeDetections(mergedDetections);
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
        const outfitSummary = summarizeOutfitDecision(last.outfit, { separator: '; ', includeFolder: false });
        const outfitNote = outfitSummary ? ` [${outfitSummary}]` : '';
        lines.push(`  Last switch: ${folderName} (trigger: ${last.name}${detail}, char ${charPos}${score})${outfitNote}`);
    } else {
        lines.push('  Last switch: (none)');
    }
    if (switchSummary.topScores.length) {
        lines.push('  Top switch scores:');
        switchSummary.topScores.forEach((event, idx) => {
            const charPos = Number.isFinite(event.charIndex) ? event.charIndex + 1 : '?';
            const detail = event.matchKind ? ` via ${event.matchKind}` : '';
            const folderName = event.folder || event.name || '(unknown)';
            const outfitSummary = summarizeOutfitDecision(event.outfit, { separator: '; ', includeFolder: false });
            const outfitNote = outfitSummary ? ` [${outfitSummary}]` : '';
            lines.push(`    ${idx + 1}. ${folderName} – ${event.score} (trigger: ${event.name}${detail}, char ${charPos})${outfitNote}`);
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
                const original = detectionLookup.get(String(name || '').toLowerCase());
                return original || name;
            })
            : [];
        lines.push('');
        lines.push('Final Stream State:');
        lines.push(`  Scene roster (${rosterNames.length}): ${rosterNames.length ? rosterNames.join(', ') : '(empty)'}`);
        lines.push(`  Last accepted name: ${report.finalState.lastAcceptedName || '(none)'}`);
        lines.push(`  Last subject: ${report.finalState.lastSubject || '(none)'}`);
        if (Array.isArray(report.finalState.outfitRoster)) {
            const outfits = report.finalState.outfitRoster.map(([name, info]) => {
                const summary = summarizeOutfitDecision(info, { separator: '; ', includeFolder: false });
                return summary ? `${name} [${summary}]` : name;
            });
            lines.push(`  Outfit roster (${outfits.length}): ${outfits.length ? outfits.join('; ') : '(empty)'}`);
        }
        if (Number.isFinite(report.finalState.outfitTTL)) {
            lines.push(`  Outfit TTL: ${report.finalState.outfitTTL}`);
        }
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

function adjustWindowForTrim(msgState, trimmedChars, combinedLength) {
    if (!msgState) {
        return;
    }

    if (!Number.isFinite(msgState.processedLength)) {
        msgState.processedLength = 0;
    }

    if (Number.isFinite(trimmedChars) && trimmedChars > 0) {
        if (Number.isFinite(msgState.lastAcceptedIndex) && msgState.lastAcceptedIndex >= 0) {
            msgState.lastAcceptedIndex = Math.max(-1, msgState.lastAcceptedIndex - trimmedChars);
        }
        msgState.processedLength = Math.max(0, msgState.processedLength - trimmedChars);
    }

    if (Number.isFinite(combinedLength)) {
        msgState.processedLength = Math.min(msgState.processedLength, combinedLength);
    }
}

function createTesterMessageState(profile) {
    return {
        lastAcceptedName: null,
        lastAcceptedTs: 0,
        vetoed: false,
        lastSubject: null,
        sceneRoster: new Set(),
        rosterTTL: profile.sceneRosterTTL ?? PROFILE_DEFAULTS.sceneRosterTTL,
        outfitRoster: new Map(),
        outfitTTL: profile.sceneRosterTTL ?? PROFILE_DEFAULTS.sceneRosterTTL,
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
        lastIssuedFolder: null,
        lastSwitchTimestamp: 0,
        lastTriggerTimes: new Map(),
        failedTriggerTimes: new Map(),
        characterOutfits: new Map(),
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
        const appended = buffer + combined[i];
        buffer = appended.slice(-maxBuffer);
        const trimmedChars = appended.length - buffer.length;
        adjustWindowForTrim(msgState, trimmedChars, buffer.length);
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
            msgState.outfitTTL = rosterTTL;
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

        const decision = evaluateSwitchDecision(bestMatch.name, {
            matchKind: bestMatch.matchKind,
            bufKey,
            messageState: msgState,
            context: { text: buffer, matchKind: bestMatch.matchKind, roster: msgState.sceneRoster },
        }, simulationState, virtualNow);
        if (decision.shouldSwitch) {
            events.push({
                type: 'switch',
                name: bestMatch.name,
                folder: decision.folder,
                matchKind: bestMatch.matchKind,
                score: Math.round(bestMatch.score ?? 0),
                charIndex: i,
                outfit: decision.outfit ? {
                    folder: decision.outfit.folder,
                    label: decision.outfit.label || null,
                    reason: decision.outfit.reason || null,
                    trigger: decision.outfit.trigger || null,
                    awareness: decision.outfit.awareness || null,
                } : null,
            });
            simulationState.lastIssuedCostume = decision.name;
            simulationState.lastIssuedFolder = decision.folder;
            simulationState.lastSwitchTimestamp = decision.now;
            simulationState.lastTriggerTimes.set(decision.folder, decision.now);
            const cache = ensureCharacterOutfitCache(simulationState);
            cache.set(decision.name.toLowerCase(), {
                folder: decision.folder,
                reason: decision.outfit?.reason || 'tester',
                label: decision.outfit?.label || null,
                updatedAt: decision.now,
            });
        } else {
            events.push({
                type: 'skipped',
                name: bestMatch.name,
                matchKind: bestMatch.matchKind,
                reason: decision.reason || 'unknown',
                outfit: decision.outfit ? {
                    folder: decision.outfit.folder,
                    label: decision.outfit.label || null,
                    reason: decision.outfit.reason || null,
                    trigger: decision.outfit.trigger || null,
                    awareness: decision.outfit.awareness || null,
                } : null,
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
        outfitRoster: Array.from(msgState.outfitRoster || []),
        outfitTTL: msgState.outfitTTL,
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
            const details = `${event.name}${event.matchKind ? ' via ' + event.matchKind : ''}, char #${event.charIndex + 1}${Number.isFinite(event.score) ? ', score ' + event.score : ''}`;
            const outfitInfo = summarizeOutfitDecision(event.outfit);
            const extra = outfitInfo ? `<br><span class="cs-tester-outfit-detail">${escapeHtml(outfitInfo)}</span>` : '';
            item.addClass('cs-tester-log-switch').html(`<b>Switch → ${escapeHtml(event.folder)}</b><small> (${escapeHtml(details)})${extra}</small>`);
        } else if (event.type === 'veto') {
            item.addClass('cs-tester-log-veto').html(`<b>Veto Triggered</b><small> (${event.match})</small>`);
        } else {
            const skipDetails = `${event.matchKind}, ${describeSkipReason(event.reason)}`;
            const outfitInfo = summarizeOutfitDecision(event.outfit);
            const extra = outfitInfo ? `<br><span class="cs-tester-outfit-detail">${escapeHtml(outfitInfo)}</span>` : '';
            item.addClass('cs-tester-log-skip').html(`<span>${escapeHtml(event.name)}</span><small> (${escapeHtml(skipDetails)})${extra}</small>`);
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
    Object.entries(uiMapping).forEach(([key, mapping]) => {
        const selector = mapping?.selector;
        if (!selector) {
            return;
        }
        $(document).on('change', selector, (event) => handleAutoSaveFieldEvent(event, key));
        if (['text', 'textarea', 'csvTextarea', 'number', 'range'].includes(mapping.type)) {
            $(document).on('input', selector, (event) => handleAutoSaveFieldEvent(event, key));
        }
    });
    $(document).on('focusin mouseenter', '[data-change-notice]', function() {
        if (this?.disabled) {
            return;
        }
        announceAutoSaveIntent(this, null, this.dataset.changeNotice, this.dataset.changeNoticeKey);
    });

    $(document).on('change', '#cs-enable', function() {
        const enabled = $(this).prop('checked');
        announceAutoSaveIntent(this, null, `Extension will ${enabled ? 'enable' : 'disable'} immediately.`, 'cs-enable');
        settings.enabled = enabled;
        persistSettings('Extension ' + (enabled ? 'Enabled' : 'Disabled'), 'info');
    });
    $(document).on('click', '#cs-save', () => {
        const button = document.getElementById('cs-save');
        if (button) {
            announceAutoSaveIntent(button, null, button.dataset.changeNotice || 'Saving all changes…', 'cs-save');
        }
        commitProfileChanges({
            message: 'Profile saved.',
            recompile: true,
            refreshFocusLock: true,
        });
    });
    $(document).on('change', '#cs-profile-select', function() {
        announceAutoSaveIntent(this, null, this?.dataset?.changeNotice || 'Switching profiles will auto-save pending edits.', 'cs-profile-select');
        flushScheduledProfileAutoSave({ overrideMessage: null, showStatusMessage: false });
        loadProfile($(this).val());
    });
    $(document).on('click', '#cs-profile-save', () => {
        const button = document.getElementById('cs-profile-save');
        if (button) {
            announceAutoSaveIntent(button, null, button.dataset.changeNotice || 'Saving profile immediately.', 'cs-profile-save');
        }
        commitProfileChanges({
            message: 'Profile saved.',
            recompile: true,
            refreshFocusLock: true,
        });
    });
    $(document).on('click', '#cs-profile-saveas', () => {
        const desiredName = normalizeProfileNameInput($("#cs-profile-name").val());
        if (!desiredName) { showStatus('Enter a name to save a new profile.', 'error'); return; }
        if (settings.profiles[desiredName]) { showStatus('A profile with that name already exists.', 'error'); return; }
        flushScheduledProfileAutoSave({ overrideMessage: null, showStatusMessage: false });
        const button = document.getElementById('cs-profile-saveas');
        if (button) {
            announceAutoSaveIntent(button, null, button.dataset.changeNotice, 'cs-profile-saveas');
        }
        const profileData = normalizeProfile(saveCurrentProfileData(), PROFILE_DEFAULTS);
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
        flushScheduledProfileAutoSave({ overrideMessage: null, showStatusMessage: false });
        const button = document.getElementById('cs-profile-rename');
        if (button) {
            announceAutoSaveIntent(button, null, button.dataset.changeNotice, 'cs-profile-rename');
        }
        settings.profiles[newName] = settings.profiles[oldName];
        delete settings.profiles[oldName];
        settings.activeProfile = newName;
        populateProfileDropdown();
        loadProfile(newName);
        $("#cs-profile-name").val('');
        persistSettings(`Renamed profile to "${escapeHtml(newName)}".`, 'info');
    });
    $(document).on('click', '#cs-profile-new', () => {
        flushScheduledProfileAutoSave({ overrideMessage: null, showStatusMessage: false });
        const button = document.getElementById('cs-profile-new');
        if (button) {
            announceAutoSaveIntent(button, null, button.dataset.changeNotice, 'cs-profile-new');
        }
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
        flushScheduledProfileAutoSave({ overrideMessage: null, showStatusMessage: false });
        const button = document.getElementById('cs-profile-duplicate');
        if (button) {
            announceAutoSaveIntent(button, null, button.dataset.changeNotice, 'cs-profile-duplicate');
        }
        const baseName = normalizeProfileNameInput($("#cs-profile-name").val()) || `${settings.activeProfile} Copy`;
        const uniqueName = getUniqueProfileName(baseName);
        settings.profiles[uniqueName] = normalizeProfile(structuredClone(activeProfile), PROFILE_DEFAULTS);
        settings.activeProfile = uniqueName;
        populateProfileDropdown();
        loadProfile(uniqueName);
        $("#cs-profile-name").val('');
        persistSettings(`Duplicated profile as "${escapeHtml(uniqueName)}".`, 'info');
    });
    $(document).on('click', '#cs-profile-delete', () => {
        if (Object.keys(settings.profiles).length <= 1) { showStatus("Cannot delete the last profile.", 'error'); return; }
        flushScheduledProfileAutoSave({ overrideMessage: null, showStatusMessage: false });
        const button = document.getElementById('cs-profile-delete');
        if (button) {
            announceAutoSaveIntent(button, null, button.dataset.changeNotice, 'cs-profile-delete');
        }
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
        flushScheduledProfileAutoSave({ overrideMessage: null, showStatusMessage: false });
        const button = document.getElementById('cs-profile-export');
        if (button) {
            announceAutoSaveIntent(button, null, button.dataset.changeNotice, 'cs-profile-export');
        }
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify({name: settings.activeProfile, data: getActiveProfile()}, null, 2));
        const dl = document.createElement('a');
        dl.setAttribute("href", dataStr);
        dl.setAttribute("download", `${settings.activeProfile}_costume_profile.json`);
        document.body.appendChild(dl);
        dl.click();
        dl.remove();
        showStatus("Profile exported.", 'info');
    });
    $(document).on('click', '#cs-profile-import', () => {
        flushScheduledProfileAutoSave({ overrideMessage: null, showStatusMessage: false });
        const button = document.getElementById('cs-profile-import');
        if (button) {
            announceAutoSaveIntent(button, null, button.dataset.changeNotice, 'cs-profile-import');
        }
        $('#cs-profile-file-input').click();
    });
    $(document).on('change', '#cs-profile-file-input', function(event) {
        const file = event.target.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const content = JSON.parse(e.target.result);
                if (!content.name || !content.data) throw new Error("Invalid profile format.");
                let profileName = content.name;
                if (settings.profiles[profileName]) profileName = `${profileName} (Imported) ${Date.now()}`;
                settings.profiles[profileName] = normalizeProfile(content.data, PROFILE_DEFAULTS);
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
        flushScheduledProfileAutoSave({ overrideMessage: null, showStatusMessage: false });
        const button = document.getElementById('cs-preset-load');
        if (button) {
            announceAutoSaveIntent(button, null, button.dataset.changeNotice, 'cs-preset-load');
        }
        if (confirm(`This will apply the "${preset.name}" preset to your current profile ("${settings.activeProfile}").\n\nYour other settings like character patterns and mappings will be kept. Continue?`)) {
            const currentProfile = getActiveProfile();
            Object.assign(currentProfile, preset.settings);
            loadProfile(settings.activeProfile);
            commitProfileChanges({
                message: `"${preset.name}" preset loaded.`,
                recompile: true,
                refreshFocusLock: true,
            });
        }
    });
    $(document).on('click', '#cs-score-preset-apply', () => {
        const selected = $("#cs-score-preset-select").val();
        if (!selected) {
            showStatus('Select a scoring preset to apply.', 'error');
            return;
        }
        flushScheduledProfileAutoSave({ overrideMessage: null, showStatusMessage: false });
        const button = document.getElementById('cs-score-preset-apply');
        if (button) {
            announceAutoSaveIntent(button, null, button.dataset.changeNotice, 'cs-score-preset-apply');
        }
        if (applyScorePresetByName(selected)) {
            setActiveScorePreset(selected);
            commitProfileChanges({
                message: `Applied scoring preset "${escapeHtml(selected)}".`,
            });
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
        flushScheduledProfileAutoSave({ overrideMessage: null, showStatusMessage: false });
        const button = document.getElementById('cs-score-preset-save');
        if (button) {
            announceAutoSaveIntent(button, null, button.dataset.changeNotice, 'cs-score-preset-save');
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
        flushScheduledProfileAutoSave({ overrideMessage: null, showStatusMessage: false });
        const button = document.getElementById('cs-score-preset-saveas');
        if (button) {
            announceAutoSaveIntent(button, null, button.dataset.changeNotice, 'cs-score-preset-saveas');
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
        flushScheduledProfileAutoSave({ overrideMessage: null, showStatusMessage: false });
        const button = document.getElementById('cs-score-preset-rename');
        if (button) {
            announceAutoSaveIntent(button, null, button.dataset.changeNotice, 'cs-score-preset-rename');
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
        flushScheduledProfileAutoSave({ overrideMessage: null, showStatusMessage: false });
        const button = document.getElementById('cs-score-preset-delete');
        if (button) {
            announceAutoSaveIntent(button, null, button.dataset.changeNotice, 'cs-score-preset-delete');
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
            scheduleProfileAutoSave({
                key: field,
                element: this,
                requiresRecompile: AUTO_SAVE_RECOMPILE_KEYS.has(field),
            });
        }
    });
    $(document).on('click', '#cs-focus-lock-toggle', async () => {
        flushScheduledProfileAutoSave({ overrideMessage: null, showStatusMessage: false });
        const button = document.getElementById('cs-focus-lock-toggle');
        if (button) {
            announceAutoSaveIntent(button, null, button.dataset.changeNotice, 'cs-focus-lock-toggle');
        }
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
            const button = document.getElementById('cs-mapping-add');
            if (button) {
                announceAutoSaveIntent(button, null, button.dataset.changeNotice, 'cs-mapping-add');
            }
            profile.mappings.push(markMappingForInitialCollapse(normalizeMappingEntry({ name: "", defaultFolder: "", outfits: [] })));
            renderMappings(profile);
            rebuildMappingLookup(profile);
        }
    });
    $(document).on('click', '#cs-mappings-tbody .map-remove', function() {
        const idx = parseInt($(this).closest('tr').attr('data-idx'), 10);
        const profile = getActiveProfile();
        if (profile && !isNaN(idx)) {
            const mapping = profile.mappings?.[idx];
            if (mapping && Object.prototype.hasOwnProperty.call(mapping, '__cardId')) {
                state.outfitCardCollapse?.delete(mapping.__cardId);
            }
            profile.mappings.splice(idx, 1);
            renderMappings(profile); // Re-render to update indices
            rebuildMappingLookup(profile);
            scheduleProfileAutoSave({
                reason: 'character mappings',
                element: this,
                requiresMappingRebuild: true,
            });
        }
    });
    $(document).on('change', '#cs-outfits-enable', function() {
        const profile = getActiveProfile();
        const enabled = $(this).prop('checked');
        if (profile) {
            profile.enableOutfits = enabled;
        }
        updateOutfitLabEnabledState(enabled);
    });
    $(document).on('click', '#cs-outfit-add-character', () => {
        const profile = getActiveProfile();
        if (!profile) {
            return;
        }
        const button = document.getElementById('cs-outfit-add-character');
        if (button) {
            announceAutoSaveIntent(button, 'character mappings', button.dataset.changeNotice, button.dataset.changeNoticeKey || 'cs-outfit-add-character');
        }
        profile.mappings.push(markMappingForInitialCollapse(normalizeMappingEntry({ name: '', defaultFolder: '', outfits: [] })));
        renderMappings(profile);
        rebuildMappingLookup(profile);
        const newCard = $('#cs-outfit-character-list .cs-outfit-card').last();
        if (newCard.length) {
            const toggle = newCard.find('.cs-outfit-card-toggle');
            if (toggle.length) {
                toggle.trigger('focus');
            } else {
                newCard.find('.cs-outfit-character-name').trigger('focus');
            }
        }
        scheduleProfileAutoSave({
            reason: 'character mappings',
            element: button || null,
            requiresMappingRebuild: true,
        });
    });
    $(document).on('input', '#cs-mappings-tbody .map-name', function() {
        const idx = parseInt($(this).closest('tr').attr('data-idx'), 10);
        if (Number.isNaN(idx)) {
            return;
        }
        const value = String($(this).val() ?? '');
        const profile = getActiveProfile();
        if (profile?.mappings?.[idx]) {
            profile.mappings[idx].name = value.trim();
        }
        $(`.cs-outfit-card[data-idx="${idx}"]`).find('.cs-outfit-character-name').val(value);
        scheduleProfileAutoSave({
            reason: 'character mappings',
            element: this,
            requiresMappingRebuild: true,
        });
    });
    $(document).on('change', '#cs-mappings-tbody .map-name', function() {
        const profile = getActiveProfile();
        if (profile) {
            rebuildMappingLookup(profile);
        }
        scheduleProfileAutoSave({
            reason: 'character mappings',
            element: this,
            requiresMappingRebuild: true,
        });
    });
    $(document).on('input', '#cs-mappings-tbody .map-folder', function() {
        const idx = parseInt($(this).closest('tr').attr('data-idx'), 10);
        if (Number.isNaN(idx)) {
            return;
        }
        const value = String($(this).val() ?? '');
        const profile = getActiveProfile();
        if (profile?.mappings?.[idx]) {
            profile.mappings[idx].defaultFolder = value.trim();
            profile.mappings[idx].folder = value.trim();
        }
        $(`.cs-outfit-card[data-idx="${idx}"]`).find('.cs-outfit-default-folder').val(value);
        scheduleProfileAutoSave({
            reason: 'character mappings',
            element: this,
            requiresMappingRebuild: true,
        });
    });
    $(document).on('change', '#cs-mappings-tbody .map-folder', function() {
        const profile = getActiveProfile();
        if (profile) {
            rebuildMappingLookup(profile);
        }
        scheduleProfileAutoSave({
            reason: 'character mappings',
            element: this,
            requiresMappingRebuild: true,
        });
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
                profile.mappings.push(markMappingForInitialCollapse(normalizeMappingEntry({ name: alias, defaultFolder: folder })));
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
        outfitRoster: new Map(oldState?.outfitRoster || []),
        rosterTTL: profile.sceneRosterTTL,
        outfitTTL: profile.sceneRosterTTL,
        processedLength: 0,
        lastAcceptedIndex: -1,
    };

    if (newState.sceneRoster.size > 0) {
        newState.rosterTTL--;
        if (newState.rosterTTL <= 0) {
            debugLog("Scene roster TTL expired, clearing roster.");
            newState.sceneRoster.clear();
        }
    }

    if (newState.outfitRoster.size > 0) {
        newState.outfitTTL--;
        if (newState.outfitTTL <= 0) {
            const expired = Array.from(newState.outfitRoster.keys());
            debugLog("Outfit roster TTL expired, clearing tracked outfits:", expired.join(', '));
            newState.outfitRoster.clear();
            const cache = ensureCharacterOutfitCache(state);
            expired.forEach(key => cache.delete(key));
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
        const normalizedToken = normalizeStreamText(tokenText);
        const appended = prev + normalizedToken;
        const maxBuffer = resolveMaxBufferChars(profile);
        const combined = appended.slice(-maxBuffer);
        const trimmedChars = appended.length - combined.length;
        adjustWindowForTrim(msgState, trimmedChars, combined.length);
        state.perMessageBuffers.set(bufKey, combined);

        const rosterSet = msgState?.sceneRoster instanceof Set ? msgState.sceneRoster : null;
        const analytics = updateMessageAnalytics(bufKey, combined, { rosterSet, assumeNormalized: true });

        if (combined.length < msgState.processedLength + profile.tokenProcessThreshold) {
            return;
        }

        msgState.processedLength = combined.length;
        const bestMatch = findBestMatch(combined, analytics?.matches, { minIndex: msgState.lastAcceptedIndex });
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
                msgState.outfitTTL = profile.sceneRosterTTL;
            }
            if (matchKind !== 'pronoun') {
                msgState.lastSubject = matchedName;
            }

            if (msgState.lastAcceptedName?.toLowerCase() === matchedName.toLowerCase() && (now - msgState.lastAcceptedTs < suppressMs)) {
                return;
            }

            msgState.lastAcceptedName = matchedName;
            msgState.lastAcceptedTs = now;
            if (Number.isFinite(bestMatch.matchIndex)) {
                msgState.lastAcceptedIndex = bestMatch.matchIndex;
            }
            issueCostumeForName(matchedName, {
                matchKind,
                bufKey,
                messageState: msgState,
                context: { text: combined, matchKind, roster: msgState.sceneRoster },
                match: bestMatch,
            });
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
        lastIssuedFolder: null,
        lastSwitchTimestamp: 0,
        lastTriggerTimes: new Map(),
        failedTriggerTimes: new Map(),
        characterOutfits: new Map(),
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

export {
    resolveOutfitForMatch,
    evaluateSwitchDecision,
    rebuildMappingLookup,
    summarizeOutfitDecision,
    state,
    extensionName,
    getVerbInflections,
    getWinner,
    findBestMatch,
    adjustWindowForTrim,
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
    storeSource[extensionName].profiles = loadProfiles(storeSource[extensionName].profiles, PROFILE_DEFAULTS);

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

if (typeof window !== "undefined" && typeof jQuery === "function") {
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
}
