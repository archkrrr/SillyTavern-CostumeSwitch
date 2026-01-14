import { extension_settings, getContext, renderExtensionTemplateAsync } from "../../../extensions.js";
import { callGenericPopup, POPUP_TYPE } from "../../../popup.js";
import {
    saveSettingsDebounced,
    saveChatDebounced,
    event_types,
    eventSource,
    system_message_types,
} from "../../../../script.js";
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
import { getTokenCountAsync } from "./tokenizers.js";
import {
    compileProfileRegexes,
    collectDetections,
} from "./src/detector-core.js";
import { collectProfilePreprocessorScripts, applyPreprocessorScripts } from "./src/core/script-preprocessor.js";
import { createNamePreprocessor } from "./src/core/name-preprocessor.js";
import {
    mergeDetectionsForReport,
    summarizeDetections,
    summarizeSkipReasonsForReport,
} from "./src/report-utils.js";
import {
    applySceneRosterUpdate,
    resetSceneState,
    replaceLiveTesterOutputs,
    clearLiveTesterOutputs,
    getCurrentSceneSnapshot,
    getLiveTesterOutputsSnapshot,
    deriveSceneRosterState,
} from "./src/core/state.js";
import { registerSillyTavernIntegration, unregisterSillyTavernIntegration } from "./src/systems/integration/sillytavern.js";
import {
    loadProfiles,
    normalizeProfile,
    normalizeMappingEntry,
    mappingHasIdentity,
    prepareMappingsForSave,
    normalizePatternSlot,
    preparePatternSlotsForSave,
    flattenPatternSlots,
    reconcilePatternSlotReferences,
    normalizeScriptCollections,
} from "./profile-utils.js";
import {
    setScenePanelContainer,
    setScenePanelContent,
    setSceneCollapseToggle,
    setSceneSectionsContainer,
    setSceneToolbar,
    setSceneRosterList,
    setSceneActiveCards,
    setSceneLiveLog,
    setSceneFooterButton,
    setSceneRosterSection,
    setSceneActiveSection,
    setSceneLiveLogSection,
    setSceneStatusText,
    setSceneCoverageSection,
    setSceneCoveragePronouns,
    setSceneCoverageAttribution,
    setSceneCoverageAction,
    getScenePanelContainer,
    getSceneCollapseToggle,
    getSceneSectionsContainer,
    getSceneRosterList,
    getSceneActiveCards,
    getSceneLiveLog,
} from "./src/ui/scenePanelState.js";
import { renderScenePanel, createScenePanelRefreshHandler } from "./src/ui/render/panel.js";
import { formatRelativeTime } from "./src/ui/render/utils.js";
import { registerAutoSaveGuards } from "./src/ui/autoSaveGuards.js";

const extensionName = "SillyTavern-CostumeSwitch-Testing";
const extensionTemplateNamespace = `third-party/${extensionName}`;
const extensionFolderPath = `scripts/extensions/${extensionTemplateNamespace}`;
const logPrefix = "[CharacterVisuals]";
const INCREMENTAL_SCAN_PADDING = 8;
const STREAM_BUFFER_SAFETY_CHARS = 120000;
const STREAM_QUEUE_FLUSH_MS = 120;
const STREAM_QUEUE_MAX_CHARS = 2400;
const STREAMING_DETECTION_INTERVAL_MS = 250;
const STREAM_SNAPSHOT_INTERVAL_MS = 1000;
const NO_EFFECTIVE_PATTERNS_MESSAGE = "All detection patterns were filtered out by ignored names. No detectors can run until you restore at least one allowed pattern.";
const FOCUS_LOCK_NOTICE_INTERVAL = 2500;
const MESSAGE_OUTCOME_STORAGE_KEY = "cs_scene_outcomes";
const SCENE_CONTROL_POPUP_TITLE = "Character Visuals";
let scenePanelPopupState = null;

function createFocusLockNotice() {
    return { at: 0, character: null, displayName: null, message: null, event: null };
}

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

function getExtensionsMenuContainer() {
    const selectors = ["#extensionsMenu", "#extensions-menu", "#extensionsList", "#extensionsMenuContainer", "#extensions_menu"];
    for (const selector of selectors) {
        const $container = $(selector).first();
        if ($container.length) {
            return $container;
        }
    }
    return null;
}

function restoreScenePanelFromPopup() {
    if (!scenePanelPopupState) {
        return;
    }
    const { panel, parent, nextSibling, observer, panelSettings, wasEnabled } = scenePanelPopupState;
    if (observer) {
        observer.disconnect();
    }
    if (panel) {
        panel.classList.remove("cs-scene-panel--popup");
        panel.removeAttribute("data-cs-popup");
        if (parent) {
            if (nextSibling && nextSibling.parentElement === parent) {
                parent.insertBefore(panel, nextSibling);
            } else {
                parent.appendChild(panel);
            }
        }
    }
    if (panelSettings && wasEnabled === false) {
        panelSettings.enabled = false;
        updateScenePanelSettingControls(panelSettings);
    }
    scenePanelPopupState = null;
    requestScenePanelRender("popup-close", { immediate: true });
}

async function openSceneControlCenterPopup() {
    if (scenePanelPopupState?.panel) {
        return;
    }
    await mountScenePanelTemplate();
    const panel = document.getElementById("cs-scene-panel");
    if (!panel) {
        console.warn(`${logPrefix} Scene panel is unavailable; unable to open popup.`);
        return;
    }
    const settings = getSettings?.();
    const panelSettings = settings ? ensureScenePanelSettings(settings) : null;
    const wasEnabled = panelSettings ? panelSettings.enabled !== false : true;
    if (panelSettings && !wasEnabled) {
        panelSettings.enabled = true;
        updateScenePanelSettingControls(panelSettings);
        requestScenePanelRender("popup-force-enable", { immediate: true });
    }
    const parent = panel.parentElement;
    const nextSibling = panel.nextElementSibling;
    const dialog = $("<div class=\"cs-scene-panel-popup\" aria-live=\"polite\"></div>");
    panel.classList.add("cs-scene-panel--popup");
    panel.setAttribute("data-cs-popup", "true");
    dialog.append(panel);
    setScenePanelCollapsed(false);
    requestScenePanelRender("popup-open", { immediate: true });
    const observer = new MutationObserver(() => {
        if (!dialog[0]?.isConnected) {
            restoreScenePanelFromPopup();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scenePanelPopupState = {
        panel,
        parent,
        nextSibling,
        observer,
        panelSettings,
        wasEnabled,
    };
    callGenericPopup(dialog, POPUP_TYPE.TEXT, SCENE_CONTROL_POPUP_TITLE, {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        transparent: true,
        okButton: 'Close',
    });
}

function addSceneControlCenterMenuButton() {
    if ($("#cs_scene_panel_menu_button").length) {
        return;
    }
    const $container = getExtensionsMenuContainer();
    if (!$container) {
        console.warn(`${logPrefix} Could not find an extensions menu container to attach the Scene Control Center popup.`);
        return;
    }
    const buttonHtml = `
        <div id="cs_scene_panel_menu_button" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-masks-theater extensionsMenuExtensionButton"></div>
            <div class="flex1">Character Visuals</div>
        </div>
    `;
    $container.append(buttonHtml);
    $("#cs_scene_panel_menu_button").on("click", openSceneControlCenterPopup);
}

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
    'scriptCollections',
    'scanLowercaseFallbackTokens',
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
    detectionBias: 'detection bias',
    detectAttribution: 'attribution detection',
    detectAction: 'action detection',
    detectVocative: 'vocative detection',
    detectPossessive: 'possessive detection',
    detectPronoun: 'pronoun detection',
    detectGeneral: 'general name detection',
    scanLowercaseFallbackTokens: 'lowercase fallback scanning',
    scriptCollections: 'regex preprocessor',
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
    patternSlots: [],
    patterns: [],
    ignorePatterns: [],
    vetoPatterns: ["OOC:", "(OOC)"],
    scriptCollections: [],
    defaultCostume: "",
    debug: false,
    globalCooldownMs: 1200,
    perTriggerCooldownMs: 250,
    failedTriggerCooldownMs: 10000,
    maxBufferChars: 5000,
    repeatSuppressMs: 800,
    mappings: [],
    enableOutfits: true,
    detectAttribution: true,
    detectAction: true,
    detectVocative: true,
    detectPossessive: true,
    detectPronoun: true,
    detectGeneral: false,
    scanDialogueActions: false,
    scanLowercaseFallbackTokens: false,
    pronounVocabulary: [...DEFAULT_PRONOUNS],
    attributionVerbs: [...DEFAULT_ATTRIBUTION_VERB_FORMS],
    actionVerbs: [...DEFAULT_ACTION_VERB_FORMS],
    detectionBias: 0,
    enableSceneRoster: true,
    sceneRosterTTL: 5,
    translateNames: false,
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

const DEFAULT_SCENE_PANEL_SECTIONS = Object.freeze({
    roster: true,
    activeCharacters: true,
    liveLog: true,
    coverage: true,
});

const DEFAULT_SCENE_PANEL_SETTINGS = Object.freeze({
    enabled: true,
    autoOpenOnStream: true,
    autoOpenOnResults: true,
    showRosterAvatars: true,
    autoPinActive: true,
    sections: DEFAULT_SCENE_PANEL_SECTIONS,
});

const SCRIPT_COLLECTION_KEYS = Object.freeze(["global", "preset", "scoped"]);
const SCRIPT_COLLECTION_LABELS = Object.freeze({
    global: "Global",
    preset: "Preset",
    scoped: "Scoped",
});

const SCENE_PANEL_SECTION_LABELS = Object.freeze({
    roster: "Scene roster",
    activeCharacters: "Active characters",
    liveLog: "Live log",
    coverage: "Coverage suggestions",
});

const DEFAULTS = {
    enabled: true,
    profiles: {
        'Default': structuredClone(PROFILE_DEFAULTS),
    },
    activeProfile: 'Default',
    scorePresets: structuredClone(DEFAULT_SCORE_PRESETS),
    activeScorePreset: 'Balanced Baseline',
    focusLock: { character: null },
    scenePanel: {
        ...DEFAULT_SCENE_PANEL_SETTINGS,
        sections: { ...DEFAULT_SCENE_PANEL_SECTIONS },
    },
};

function ensureScenePanelSettings(settings) {
    const defaults = DEFAULTS.scenePanel;
    if (!settings || typeof settings !== "object") {
        return {
            ...defaults,
            sections: { ...DEFAULT_SCENE_PANEL_SECTIONS },
        };
    }
    const incoming = settings.scenePanel;
    let normalized;
    if (typeof incoming !== "object" || incoming === null) {
        normalized = {
            ...defaults,
            sections: { ...DEFAULT_SCENE_PANEL_SECTIONS },
        };
    } else {
        const sections = typeof incoming.sections === "object" && incoming.sections !== null
            ? incoming.sections
            : {};
        normalized = {
            ...defaults,
            ...incoming,
            sections: {
                ...DEFAULT_SCENE_PANEL_SECTIONS,
                ...sections,
            },
        };
    }

    normalized.enabled = normalized.enabled !== false;
    normalized.autoOpenOnStream = normalized.autoOpenOnStream !== false;
    normalized.autoOpenOnResults = normalized.autoOpenOnResults !== false;
    normalized.showRosterAvatars = normalized.showRosterAvatars !== false;
    normalized.autoPinActive = normalized.autoPinActive !== false;
    normalized.sections.roster = normalized.sections.roster !== false;
    normalized.sections.activeCharacters = normalized.sections.activeCharacters !== false;
    normalized.sections.liveLog = normalized.sections.liveLog !== false;
    normalized.sections.coverage = normalized.sections.coverage !== false;

    settings.scenePanel = {
        ...normalized,
        sections: { ...normalized.sections },
    };

    return settings.scenePanel;
}

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
    messageMatches: new Map(),
    eventHandlers: {},
    integrationHandlers: null,
    compiledRegexes: {},
    statusTimer: null,
    testerTimers: [],
    lastTesterReport: null,
    lastPreprocessedText: "",
    lastPreprocessorScripts: [],
    lastDetectionCount: 0,
    recentDecisionEvents: [],
    lastVetoMatch: null,
    buildMeta: null,
    topSceneRanking: new Map(),
    topSceneRankingUpdatedAt: new Map(),
    latestTopRanking: { bufKey: null, ranking: [], fullRanking: [], updatedAt: 0 },
    currentGenerationKey: null,
    currentGenerationRole: null,
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
    draftMappingIds: new Set(),
    draftPatternIds: new Set(),
    autoSaveCleanup: null,
    focusLockNotice: createFocusLockNotice(),
    patternSearchQuery: "",
    lastSceneSwipeId: null,
    lastSceneDigest: null,
    pendingStreamBuffers: new Map(),
    pendingStreamRoles: new Map(),
    pendingStreamTimer: null,
    streamSnapshotTimer: null,
    streamingDetectionTimer: null,
    streamingDetectionKey: null,
    streamingDetectionRole: null,
    streamingDetectionLastAt: 0,
    streamingDetectionLastKey: null,
    streamingDetectionLastLength: null,
};

let nextOutfitCardId = 1;
let nextPatternSlotId = 1;

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

function ensurePatternSlotId(slot) {
    if (!slot || typeof slot !== "object") {
        return null;
    }

    if (!Object.prototype.hasOwnProperty.call(slot, "__slotId")) {
        const id = `cs-pattern-slot-${Date.now()}-${nextPatternSlotId++}`;
        Object.defineProperty(slot, "__slotId", {
            value: id,
            enumerable: false,
            configurable: true,
        });
    }

    return slot.__slotId;
}

function collectProfilePatternList(profile) {
    const result = [];
    const seen = new Set();

    const add = (value) => {
        const trimmed = String(value ?? "").trim();
        if (!trimmed || seen.has(trimmed)) {
            return;
        }
        seen.add(trimmed);
        result.push(trimmed);
    };

    if (profile && Array.isArray(profile.patternSlots)) {
        flattenPatternSlots(profile.patternSlots).forEach(add);
    }

    if (profile && Array.isArray(profile.patterns)) {
        profile.patterns.forEach(add);
    }

    return result;
}

function gatherSlotPatternList(slot) {
    if (!slot) {
        return [];
    }

    const normalized = normalizePatternSlot(slot);
    const values = [];
    if (normalized.name) {
        values.push(normalized.name);
    }
    if (Array.isArray(normalized.aliases)) {
        values.push(...normalized.aliases);
    }
    if (Array.isArray(normalized.patterns)) {
        values.push(...normalized.patterns);
    }
    return values.map((value) => String(value ?? "").trim()).filter(Boolean);
}

function doesPatternSlotMatchQuery(slot, query) {
    if (!slot || !query) {
        return true;
    }

    const normalizedQuery = String(query ?? "").toLowerCase();
    if (!normalizedQuery) {
        return true;
    }

    const values = [];
    const addValue = (value) => {
        if (value == null) {
            return;
        }
        const text = String(value).trim().toLowerCase();
        if (text) {
            values.push(text);
        }
    };

    addValue(slot.name);
    if (Array.isArray(slot.aliases)) {
        slot.aliases.forEach(addValue);
    }
    if (Array.isArray(slot.patterns)) {
        slot.patterns.forEach(addValue);
    }
    addValue(slot.folder);

    return values.some((value) => value.includes(normalizedQuery));
}

function updateProfilePatternCache(profile) {
    if (!profile || typeof profile !== "object") {
        return [];
    }

    if (!Array.isArray(profile.patternSlots)) {
        profile.patternSlots = [];
    }

    profile.patterns = flattenPatternSlots(profile.patternSlots);
    return profile.patterns;
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
        state.messageMatches?.delete(oldest);
        if (state.topSceneRanking instanceof Map) {
            state.topSceneRanking.delete(oldest);
        }
        if (state.topSceneRankingUpdatedAt instanceof Map) {
            state.topSceneRankingUpdatedAt.delete(oldest);
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

const PRONOUN_SUPPRESS_REASONS = new Set([
    "already-active",
    "outfit-unchanged",
    "per-trigger-cooldown",
    "failed-trigger-cooldown",
]);

function shouldLogMatchEvent(matchKind, reason) {
    if (matchKind !== "pronoun") {
        return true;
    }
    const normalizedReason = String(reason ?? "").toLowerCase();
    return !PRONOUN_SUPPRESS_REASONS.has(normalizedReason);
}

function buildAvailableOutfitSet(profile, messageState = null) {
    if (!profile?.enableOutfits) {
        return new Set();
    }

    const available = new Set();
    if (state.mappingLookup instanceof Map) {
        state.mappingLookup.forEach((_, key) => {
            if (key) {
                available.add(key);
            }
        });
    }

    const roster = messageState?.outfitRoster instanceof Map ? messageState.outfitRoster : null;
    if (roster) {
        roster.forEach((_, key) => {
            if (key) {
                available.add(key);
            }
        });
    }

    return available;
}

function filterMatchesByAvailability(matches, profile, options = {}) {
    if (!Array.isArray(matches)) {
        return { matches, filteredOut: [] };
    }

    const available = buildAvailableOutfitSet(profile, options.messageState);
    if (!available.size) {
        return { matches, filteredOut: [] };
    }

    const filteredOut = [];
    const kept = [];
    // FIX #7: Do not filter out matches based on outfit availability.
    // We want to detect ALL characters for Roster purposes, even if they don't have a costume folder.
    // issueCostumeForName will handle the "no folder" case gracefully (Switch Skipped).
    matches.forEach((match) => {
        kept.push(match);
    });

    return { matches: kept, filteredOut };
}

function findAllMatches(combined, options = {}) {
    const profile = getActiveProfile();
    const { compiledRegexes } = state;
    state.lastDetectionCount = 0;
    if (!profile || !combined) {
        return [];
    }

    const conditioned = conditionDetectionInput(combined, { sampleThreshold: 500 });
    const trimmedLeading = Number.isFinite(conditioned.trimmedLeading) ? Math.max(0, conditioned.trimmedLeading) : 0;
    const effectiveText = conditioned.text;

    let lastSubject = null;
    if (profile.detectPronoun && state.perMessageStates.size > 0) {
        const msgState = Array.from(state.perMessageStates.values()).pop();
        if (msgState) {
            if (msgState.lastSubject && msgState.lastSubjectNormalized) {
                lastSubject = msgState.lastSubject;
            } else if (msgState.pendingSubject && msgState.pendingSubjectNormalized) {
                lastSubject = msgState.pendingSubject;
            }
        }
    }

    const detectionOptions = {
        priorityWeights: getPriorityWeights(profile),
        lastSubject,
        scanDialogueActions: Boolean(profile.scanDialogueActions),
    };

    if (Number.isFinite(options?.startIndex) && options.startIndex >= 0) {
        detectionOptions.startIndex = Math.floor(options.startIndex);
    }

    if (Number.isFinite(options?.minIndex) && options.minIndex >= 0) {
        detectionOptions.minIndex = Math.floor(options.minIndex);
    }

    if (Number.isFinite(options?.bufferOffset) && options.bufferOffset >= 0) {
        detectionOptions.bufferOffset = Math.floor(options.bufferOffset);
    }

    if (typeof options?.quoteState === "object" && options.quoteState) {
        detectionOptions.quoteState = options.quoteState;
    }

    if (Number.isFinite(options?.lastIndex)) {
        detectionOptions.lastIndex = Math.floor(options.lastIndex);
    }

    if (trimmedLeading > 0) {
        if (Number.isFinite(detectionOptions.startIndex)) {
            detectionOptions.startIndex = Math.max(0, detectionOptions.startIndex - trimmedLeading);
        }
        if (Number.isFinite(detectionOptions.minIndex)) {
            detectionOptions.minIndex = Math.max(0, detectionOptions.minIndex - trimmedLeading);
        }
        detectionOptions.bufferOffset = (detectionOptions.bufferOffset || 0) + trimmedLeading;
    }

    const matches = collectDetections(effectiveText, profile, compiledRegexes, {
        ...detectionOptions,
        originalText: combined,
    });

    const { matches: availableMatches, filteredOut } = filterMatchesByAvailability(matches, profile, {
        messageState: options?.messageState || null,
    });
    availableMatches.originalText = matches.originalText;
    availableMatches.preprocessedText = matches.preprocessedText;
    availableMatches.preprocessorScripts = matches.preprocessorScripts;
    availableMatches.tokenizerId = matches.tokenizerId;
    availableMatches.tokenCount = matches.tokenCount;
    availableMatches.tokenOffsets = matches.tokenOffsets;
    availableMatches.tokenCountPromise = matches.tokenCountPromise;
    availableMatches.startTokenIndex = matches.startTokenIndex;
    availableMatches.minTokenIndex = matches.minTokenIndex;
    availableMatches.minTokenIndex = matches.minTokenIndex;
    availableMatches.vetoMatch = matches.vetoMatch;
    availableMatches.vetoPhrase = matches.vetoPhrase;
    availableMatches.filteredOut = filteredOut;


    const processed = typeof matches?.preprocessedText === "string"
        ? matches.preprocessedText
        : effectiveText;
    state.lastPreprocessedText = processed;
    state.lastPreprocessorScripts = clonePreprocessorScripts(matches?.preprocessorScripts || []);
    state.lastDetectionCount = Array.isArray(availableMatches) ? availableMatches.length : 0;
    return availableMatches;
}

function findBestMatch(combined, precomputedMatches = null, options = {}) {
    const profile = getActiveProfile();
    if (!profile) return null;
    const matchOptions = options && typeof options === 'object' ? { ...options } : {};
    const allMatches = Array.isArray(precomputedMatches)
        ? precomputedMatches
        : findAllMatches(combined, matchOptions);
    if (Array.isArray(precomputedMatches) && typeof precomputedMatches.preprocessedText === "string") {
        state.lastPreprocessedText = precomputedMatches.preprocessedText;
    }
    if (allMatches.length === 0) return null;

    const messageState = matchOptions?.messageState || null;
    const pendingSubject = typeof messageState?.pendingSubjectNormalized === "string"
        ? messageState.pendingSubjectNormalized.trim()
        : "";
    const confirmedSubject = typeof messageState?.lastSubjectNormalized === "string"
        ? messageState.lastSubjectNormalized.trim()
        : "";
    let resolvedMatches = allMatches;
    if (pendingSubject && !confirmedSubject) {
        const nonPronounMatches = allMatches.filter((match) => match?.matchKind !== "pronoun");
        if (nonPronounMatches.length > 0) {
            resolvedMatches = nonPronounMatches;
            if (resolvedMatches && typeof resolvedMatches === "object") {
                resolvedMatches.originalText = allMatches.originalText;
                resolvedMatches.preprocessedText = allMatches.preprocessedText;
                resolvedMatches.preprocessorScripts = allMatches.preprocessorScripts;
                resolvedMatches.tokenizerId = allMatches.tokenizerId;
                resolvedMatches.tokenCount = allMatches.tokenCount;
                resolvedMatches.tokenOffsets = allMatches.tokenOffsets;
                resolvedMatches.tokenCountPromise = allMatches.tokenCountPromise;
                resolvedMatches.startTokenIndex = allMatches.startTokenIndex;
                resolvedMatches.minTokenIndex = allMatches.minTokenIndex;
                resolvedMatches.filteredOut = allMatches.filteredOut;
            }
        }
    }

    let rosterSet = null;
    if (profile.enableSceneRoster) {
        const msgState = Array.from(state.perMessageStates.values()).pop();
        if (msgState && msgState.sceneRoster.size > 0) {
            rosterSet = msgState.sceneRoster;
        }
    }

    // Enforce chronological processing:
    // 1. Sort matches by position.
    // 2. Find the earliest valid match (after minIndex).
    // 3. Only consider matches within a small window of that first match.
    // This prevents future matches (with high Roster Bonus) from skipping over current matches.
    const sortedMatches = Array.isArray(resolvedMatches) ? [...resolvedMatches] : [];
    sortedMatches.sort((a, b) => {
        const aIdx = Number.isFinite(a.matchIndex) ? a.matchIndex : Number.POSITIVE_INFINITY;
        const bIdx = Number.isFinite(b.matchIndex) ? b.matchIndex : Number.POSITIVE_INFINITY;
        return aIdx - bIdx;
    });

    // DEBUG: Trace chronological logic
    if (sortedMatches.length > 0) {
        debugLog(`[FIX-DEBUG] Sorted matches: ${sortedMatches.map(m => `${m.name}@${m.matchIndex}`).join(', ')}`);
        debugLog(`[FIX-DEBUG] MinIndex: ${options?.minIndex}`);
    }

    // Reassign sorted array back to resolvedMatches AND PRESERVE PROPERTIES
    const originalProperties = { ...resolvedMatches };

    // Filter candidates
    const minIndex = (Number.isFinite(options?.minIndex) && options.minIndex >= 0) ? options.minIndex : -1;
    const firstValidMatch = sortedMatches.find(m => {
        const end = (m.matchIndex || 0) + (m.matchLength || 0) - 1;
        return end > minIndex;
    });

    let candidates = resolvedMatches; // Default to all if no valid match found (let getWinner handle empty/invalid)

    if (firstValidMatch) {
        const CHRONOLOGICAL_WINDOW = 100; // Look ahead 100 chars max
        const scanThreshold = firstValidMatch.matchIndex + CHRONOLOGICAL_WINDOW;

        candidates = sortedMatches.filter(m => {
            const end = (m.matchIndex || 0) + (m.matchLength || 0) - 1;
            // Must be valid (after minIndex)
            if (end <= minIndex) return false;
            // Must be within window
            return m.matchIndex <= scanThreshold;
        });

        debugLog(`[FIX-DEBUG] First Valid: ${firstValidMatch.name}@${firstValidMatch.matchIndex}. Threshold: ${scanThreshold}`);
        debugLog(`[FIX-DEBUG] Candidates: ${candidates.map(m => `${m.name}@${m.matchIndex}`).join(', ')}`);

        // Restore array properties needed for scoringOptions
        // (tokenCount, minTokenIndex, tokenizerId - referenced in lines 1212-1216)
        if (resolvedMatches) {
            if (Number.isFinite(resolvedMatches.tokenCount)) candidates.tokenCount = resolvedMatches.tokenCount;
            if (Number.isFinite(resolvedMatches.minTokenIndex)) candidates.minTokenIndex = resolvedMatches.minTokenIndex;
            if (resolvedMatches.tokenizerId) candidates.tokenizerId = resolvedMatches.tokenizerId;
        }
    } else {
        debugLog(`[FIX-DEBUG] No valid matches found after minIndex.`);
        // If we have matches but NONE are valid (all behind minIndex),
        // passing them to getWinner will just result in "no winner".
        // But let's pass the sorted list anyway just in case.
        candidates = sortedMatches;
        if (resolvedMatches) {
            if (Number.isFinite(resolvedMatches.tokenCount)) candidates.tokenCount = resolvedMatches.tokenCount;
            if (Number.isFinite(resolvedMatches.minTokenIndex)) candidates.minTokenIndex = resolvedMatches.minTokenIndex;
            if (resolvedMatches.tokenizerId) candidates.tokenizerId = resolvedMatches.tokenizerId;
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

    if (Number.isFinite(resolvedMatches?.tokenCount)) {
        scoringOptions.tokenLength = resolvedMatches.tokenCount;
    }

    if (Number.isFinite(resolvedMatches?.minTokenIndex)) {
        scoringOptions.minTokenIndex = resolvedMatches.minTokenIndex;
    }

    return getWinner(candidates, profile.detectionBias, combined.length, scoringOptions);
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
    const fallbackTokenLength = Number.isFinite(matches?.tokenCount) ? matches.tokenCount : null;
    const tokenLength = Number.isFinite(options?.tokenLength) ? options.tokenLength : fallbackTokenLength;
    const minTokenIndex = Number.isFinite(options?.minTokenIndex)
        ? options.minTokenIndex
        : Number.isFinite(matches?.minTokenIndex)
            ? matches.minTokenIndex
            : null;
    const useTokenDistance = Number.isFinite(tokenLength) && tokenLength >= 0;
    const scoredMatches = [];

    matches.forEach((match) => {
        const isActive = match.priority >= 3; // speaker, attribution, action
        const hasFiniteIndex = Number.isFinite(match.matchIndex);
        const matchLength = Number.isFinite(match.matchLength) && match.matchLength > 0
            ? Math.floor(match.matchLength)
            : 1;
        const matchEndIndex = hasFiniteIndex
            ? match.matchIndex + matchLength - 1
            : null;
        const matchTokenIndex = Number.isFinite(match.tokenIndex)
            ? Math.floor(match.tokenIndex)
            : null;
        const matchTokenLength = Number.isFinite(match.tokenLength) && match.tokenLength > 0
            ? Math.floor(match.tokenLength)
            : null;
        const tokenEndIndex = matchTokenIndex != null
            ? matchTokenIndex + (matchTokenLength != null ? matchTokenLength - 1 : 0)
            : null;
        if (minIndex != null
            && hasFiniteIndex
            && matchEndIndex != null
            && matchEndIndex <= minIndex) {
            return;
        }
        let distanceFromEnd = 0;
        if (useTokenDistance && matchTokenIndex != null) {
            distanceFromEnd = Math.max(0, tokenLength - matchTokenIndex);
        } else if (Number.isFinite(textLength) && hasFiniteIndex) {
            distanceFromEnd = Math.max(0, textLength - match.matchIndex);
        }
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
        scoredMatches.push({
            ...match,
            score,
            tokenIndex: matchTokenIndex,
            tokenLength: matchTokenLength,
        });
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
    const fallbackTokenLength = Number.isFinite(matches?.tokenCount) ? matches.tokenCount : null;
    const tokenLength = Number.isFinite(options?.tokenLength) ? options.tokenLength : fallbackTokenLength;
    const useTokenMetrics = Number.isFinite(tokenLength) && tokenLength >= 0;
    const summary = new Map();

    matches.forEach((match, idx) => {
        if (!match || !match.name) return;
        const canonical = typeof match.name === "string" ? match.name.trim() : "";
        const normalized = normalizeCostumeName(canonical);
        if (!normalized) return;

        const rawName = typeof match.rawName === "string" ? match.rawName.trim() : "";
        const displayName = canonical || normalized;
        const key = normalized.toLowerCase();
        let entry = summary.get(key);
        if (!entry) {
            entry = {
                name: displayName,
                rawName: rawName || displayName,
                normalized,
                count: 0,
                bestPriority: -Infinity,
                earliest: Number.POSITIVE_INFINITY,
                latest: Number.NEGATIVE_INFINITY,
                earliestToken: Number.POSITIVE_INFINITY,
                latestToken: Number.NEGATIVE_INFINITY,
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
        const tokenIndex = Number.isFinite(match.tokenIndex) ? Math.floor(match.tokenIndex) : null;
        if (index < entry.earliest) {
            entry.earliest = index;
            entry.firstMatchKind = match.matchKind || entry.firstMatchKind || null;
        }
        if (index > entry.latest) {
            entry.latest = index;
        }
        if (tokenIndex != null) {
            if (tokenIndex < entry.earliestToken) {
                entry.earliestToken = tokenIndex;
            }
            if (tokenIndex > entry.latestToken) {
                entry.latestToken = tokenIndex;
            }
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
        const earliestToken = Number.isFinite(entry.earliestToken) ? entry.earliestToken : Number.POSITIVE_INFINITY;
        const distanceBasis = useTokenMetrics && Number.isFinite(earliestToken)
            ? earliestToken
            : earliest;
        const rosterBonus = entry.inSceneRoster ? rosterBonusWeight : 0;
        const earliestPenalty = distanceBasis * distancePenaltyWeight;
        const score = entry.count * countWeight + priorityScore * priorityMultiplier + rosterBonus - earliestPenalty;
        return {
            name: entry.name,
            normalized: entry.normalized,
            count: entry.count,
            bestPriority: priorityScore,
            earliest: Number.isFinite(entry.earliest) ? entry.earliest : null,
            latest: Number.isFinite(entry.latest) ? entry.latest : null,
            earliestToken: Number.isFinite(entry.earliestToken) ? entry.earliestToken : null,
            latestToken: Number.isFinite(entry.latestToken) ? entry.latestToken : null,
            inSceneRoster: Boolean(entry.inSceneRoster),
            firstMatchKind: entry.firstMatchKind || null,
            rawName: entry.rawName,
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
    const fallbackTokenLength = Number.isFinite(matches?.tokenCount) ? matches.tokenCount : null;
    const tokenLength = Number.isFinite(options?.tokenLength) ? options.tokenLength : fallbackTokenLength;
    const useTokenDistance = Number.isFinite(tokenLength) && tokenLength >= 0;

    const scored = matches.map((match, idx) => {
        const priority = Number(match?.priority) || 0;
        const matchIndex = Number.isFinite(match?.matchIndex) ? match.matchIndex : idx;
        const matchTokenIndex = Number.isFinite(match?.tokenIndex) ? Math.floor(match.tokenIndex) : null;
        const distanceFromEnd = useTokenDistance && matchTokenIndex != null
            ? Math.max(0, tokenLength - matchTokenIndex)
            : Number.isFinite(textLength)
                ? Math.max(0, textLength - matchIndex)
                : 0;
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
            rawName: match?.rawName || match?.name || '(unknown)',
            matchKind: match?.matchKind || 'unknown',
            priority,
            priorityScore,
            biasBonus,
            rosterBonus: rosterBonusApplied,
            distancePenalty,
            totalScore,
            matchIndex,
            charIndex: matchIndex,
            tokenIndex: matchTokenIndex,
            tokenDistance: useTokenDistance && matchTokenIndex != null ? distanceFromEnd : null,
            inRoster,
            nameResolution: match?.nameResolution || null,
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

function updateSessionTopCharacters(bufKey, ranking, timestamp = Date.now()) {
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
    session.lastUpdated = timestamp;

    state.latestTopRanking = {
        bufKey: bufKey || null,
        ranking: topRanking,
        fullRanking: Array.isArray(ranking) ? ranking : [],
        updatedAt: timestamp,
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

    if (state.topSceneRankingUpdatedAt instanceof Map) {
        state.topSceneRankingUpdatedAt.clear();
    } else {
        state.topSceneRankingUpdatedAt = new Map();
    }

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
// SCENE PANEL RENDERING
// ======================================================================
const SCENE_PANEL_RENDER_DEBOUNCE_MS = 80;
const SCENE_PANEL_NEBULA_CLOUD_BLUEPRINTS = [
    {
        sizeRatio: 1.44,
        left: 30,
        top: 60,
        duration: 52,
        delay: 0,
        opacity: 0.36,
        blur: 42,
        rotationStart: "-18deg",
        rotationMid: "4deg",
        rotationEnd: "26deg",
        scaleStart: 0.92,
        scaleMid: 1.18,
        scaleEnd: 0.9,
        colorPrimary: "rgba(126, 196, 248, 0.32)",
        colorSecondary: "rgba(214, 156, 242, 0.24)",
    },
    {
        sizeRatio: 1.12,
        left: 64,
        top: 46,
        duration: 46,
        delay: -12.5,
        opacity: 0.32,
        blur: 36,
        rotationStart: "14deg",
        rotationMid: "36deg",
        rotationEnd: "58deg",
        scaleStart: 0.88,
        scaleMid: 1.1,
        scaleEnd: 0.94,
        colorPrimary: "rgba(108, 232, 198, 0.26)",
        colorSecondary: "rgba(110, 184, 246, 0.28)",
    },
    {
        sizeRatio: 0.94,
        left: 22,
        top: 38,
        duration: 38,
        delay: -7.5,
        opacity: 0.34,
        blur: 28,
        rotationStart: "-8deg",
        rotationMid: "18deg",
        rotationEnd: "32deg",
        scaleStart: 0.9,
        scaleMid: 1.16,
        scaleEnd: 0.96,
        colorPrimary: "rgba(226, 166, 242, 0.26)",
        colorSecondary: "rgba(104, 188, 242, 0.26)",
    },
];
const SCENE_PANEL_NEBULA_STAR_BLUEPRINTS = [
    { sizeRatio: 0.06, left: 18, top: 34, duration: 14, delay: -4, opacity: 0.66 },
    { sizeRatio: 0.08, left: 46, top: 28, duration: 18, delay: -9, opacity: 0.58 },
    { sizeRatio: 0.05, left: 64, top: 62, duration: 16, delay: -6, opacity: 0.62 },
    { sizeRatio: 0.07, left: 74, top: 38, duration: 20, delay: -10, opacity: 0.54 },
    { sizeRatio: 0.05, left: 36, top: 58, duration: 17, delay: -3.2, opacity: 0.6 },
    { sizeRatio: 0.04, left: 54, top: 72, duration: 22, delay: -12.6, opacity: 0.5 },
];
let scenePanelRenderTimer = null;
let scenePanelRenderPending = false;
let scenePanelRenderLastReason = "update";
let scenePanelRenderLastSource = "scene";
let lastCollectedScenePanelState = null;
let scenePanelUiWired = false;
let scenePanelLayerMode = null;
let scenePanelLayerReturnFocus = null;
let scenePanelUpdateCueTimer = null;

function isScenePanelCollapsed() {
    const container = getScenePanelContainer?.();
    if (!container) {
        return false;
    }
    if (typeof container.attr === "function") {
        const attr = container.attr("data-cs-collapsed");
        return attr === "true";
    }
    if (container?.[0]) {
        const attr = container[0].getAttribute("data-cs-collapsed");
        return attr === "true";
    }
    return false;
}

function setScenePanelCollapsed(collapsed) {
    const container = getScenePanelContainer?.();
    if (container && typeof container.attr === "function") {
        container.attr("data-cs-collapsed", collapsed ? "true" : "false");
    } else if (container?.[0]) {
        container[0].setAttribute("data-cs-collapsed", collapsed ? "true" : "false");
    }
    const toggle = getSceneCollapseToggle?.();
    if (toggle && typeof toggle.attr === "function") {
        toggle.attr("aria-expanded", collapsed ? "false" : "true");
        toggle.attr("title", collapsed ? "Expand scene roster" : "Collapse scene roster");
    } else if (toggle?.[0]) {
        toggle[0].setAttribute("aria-expanded", collapsed ? "false" : "true");
        toggle[0].setAttribute("title", collapsed ? "Expand scene roster" : "Collapse scene roster");
    }
    if (!collapsed) {
        const element = toggle?.[0] || toggle;
        if (element?.classList) {
            element.classList.remove("cs-scene-panel__collapse-toggle--notify");
        }
        if (scenePanelUpdateCueTimer) {
            clearTimeout(scenePanelUpdateCueTimer);
            scenePanelUpdateCueTimer = null;
        }
    }
    requestScenePanelRender("collapse", { immediate: true });
}

function toggleScenePanelCollapsed() {
    setScenePanelCollapsed(!isScenePanelCollapsed());
}

function triggerScenePanelUpdateCue() {
    if (!isScenePanelCollapsed()) {
        return;
    }
    const toggle = getSceneCollapseToggle?.();
    const element = toggle?.[0] || toggle;
    if (!element || !element.classList) {
        return;
    }
    element.classList.remove("cs-scene-panel__collapse-toggle--notify");
    // Force reflow to restart animation when updates happen rapidly.
    void element.offsetWidth; // eslint-disable-line no-void
    element.classList.add("cs-scene-panel__collapse-toggle--notify");
    const cleanup = () => {
        element.classList.remove("cs-scene-panel__collapse-toggle--notify");
        element.removeEventListener("animationend", cleanup);
        if (scenePanelUpdateCueTimer) {
            clearTimeout(scenePanelUpdateCueTimer);
            scenePanelUpdateCueTimer = null;
        }
    };
    element.addEventListener("animationend", cleanup);
    if (scenePanelUpdateCueTimer) {
        clearTimeout(scenePanelUpdateCueTimer);
    }
    scenePanelUpdateCueTimer = setTimeout(cleanup, 2500);
}

function maybeAutoExpandScenePanel(reason = "result") {
    if (typeof document === "undefined") {
        return;
    }
    const settings = getSettings?.();
    const panelSettings = ensureScenePanelSettings(settings || {});
    const shouldAutoOpen = reason === "stream"
        ? panelSettings.autoOpenOnStream
        : panelSettings.autoOpenOnResults;

    if (!shouldAutoOpen) {
        return;
    }

    if (!panelSettings.enabled) {
        panelSettings.enabled = true;
        updateScenePanelSettingControls(panelSettings);
        setScenePanelCollapsed(false);
        requestScenePanelRender("auto-open-enable", { immediate: true });
        persistSettings(null, "info");
        return;
    }
    if (!isScenePanelCollapsed()) {
        return;
    }
    setScenePanelCollapsed(false);
}

function getRankingUpdatedAtForKey(bufKey) {
    const normalizedKey = normalizeMessageKey(bufKey);
    if (!normalizedKey) {
        return null;
    }
    if (!(state.topSceneRankingUpdatedAt instanceof Map)) {
        return null;
    }
    const timestamp = state.topSceneRankingUpdatedAt.get(normalizedKey);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function computeAnalyticsUpdatedAt({
    events = [],
    rankingUpdatedAt = null,
    scene = null,
    membership = null,
    testers = null,
} = {}) {
    const candidates = [];
    const addCandidate = (value) => {
        if (Number.isFinite(value)) {
            candidates.push(value);
        }
    };

    if (Array.isArray(events)) {
        events.forEach((event) => {
            if (event && typeof event === "object") {
                addCandidate(event.timestamp);
            }
        });
    }

    if (scene && typeof scene === "object") {
        addCandidate(scene.updatedAt);
        if (scene.lastEvent && typeof scene.lastEvent === "object") {
            addCandidate(scene.lastEvent.timestamp);
        }
    }

    if (membership && typeof membership === "object") {
        addCandidate(membership.updatedAt);
    }

    if (testers && typeof testers === "object") {
        addCandidate(testers.updatedAt);
        if (Array.isArray(testers.entries)) {
            testers.entries.forEach((entry) => {
                if (!entry || typeof entry !== "object") {
                    return;
                }
                addCandidate(entry.updatedAt);
                if (entry.lastEvent && typeof entry.lastEvent === "object") {
                    addCandidate(entry.lastEvent.timestamp);
                }
            });
        }
    }

    addCandidate(rankingUpdatedAt);

    if (!candidates.length) {
        return 0;
    }

    return Math.max(...candidates);
}

function resolveSceneMessageState(sceneSnapshot) {
    const states = state.perMessageStates instanceof Map ? state.perMessageStates : null;
    if (!states) {
        return { sceneSnapshot, messageState: null };
    }
    const streamingKey = normalizeMessageKey(state.currentGenerationKey);
    if (streamingKey && states.has(streamingKey)) {
        return {
            sceneSnapshot: {
                ...sceneSnapshot,
                key: streamingKey,
                messageId: Number.isFinite(sceneSnapshot?.messageId)
                    ? sceneSnapshot.messageId
                    : extractMessageIdFromKey(streamingKey),
            },
            messageState: states.get(streamingKey),
        };
    }
    const snapshotKey = normalizeMessageKey(sceneSnapshot?.key);
    if (snapshotKey && states.has(snapshotKey)) {
        return {
            sceneSnapshot: { ...sceneSnapshot, key: snapshotKey },
            messageState: states.get(snapshotKey),
        };
    }
    const sessionKey = normalizeMessageKey(ensureSessionData()?.lastMessageKey);
    if (!snapshotKey && sessionKey && states.has(sessionKey)) {
        return {
            sceneSnapshot: {
                ...sceneSnapshot,
                key: sessionKey,
                messageId: Number.isFinite(sceneSnapshot?.messageId)
                    ? sceneSnapshot.messageId
                    : extractMessageIdFromKey(sessionKey),
            },
            messageState: states.get(sessionKey),
        };
    }
    return { sceneSnapshot, messageState: null };
}

function collectScenePanelState(options = {}) {
    if (options?.source === "tester" && lastCollectedScenePanelState) {
        return lastCollectedScenePanelState;
    }
    const settings = getSettings?.();
    const panelSettings = ensureScenePanelSettings(settings || {});
    const now = Date.now();
    let sceneSnapshot = getCurrentSceneSnapshot();
    const testersSnapshot = getLiveTesterOutputsSnapshot();
    const resolvedScene = resolveSceneMessageState(sceneSnapshot);
    sceneSnapshot = resolvedScene.sceneSnapshot;
    const messageState = resolvedScene.messageState;
    const derivedScene = deriveSceneRosterState({
        messageState,
        sceneSnapshot,
        testerSnapshot: testersSnapshot,
        now,
    });
    const scene = {
        key: derivedScene.key,
        messageId: derivedScene.messageId,
        roster: derivedScene.roster,
        lastEvent: derivedScene.lastEvent,
        updatedAt: derivedScene.updatedAt,
    };
    const displayNames = derivedScene.displayNames;
    const testers = testersSnapshot;
    const ranking = getLastTopCharacters(4);

    const streamingKey = state.currentGenerationKey
        ? normalizeMessageKey(state.currentGenerationKey)
        : null;

    const getBufferForKey = (key) => {
        if (!key || !(state.perMessageBuffers instanceof Map)) {
            return "";
        }
        return state.perMessageBuffers.get(key) || "";
    };

    const streamingBuffer = streamingKey ? getBufferForKey(streamingKey) : "";
    const hasStreamingBuffer = Boolean(streamingBuffer.trim().length);

    let hasStreamingEvents = false;
    if (streamingKey && Array.isArray(state.recentDecisionEvents)) {
        hasStreamingEvents = state.recentDecisionEvents.some((event) => {
            if (!event || !event.messageKey) {
                return false;
            }
            const normalizedEventKey = normalizeMessageKey(event.messageKey);
            return normalizedEventKey === streamingKey;
        });
    }

    const shouldUseStreamingKey = Boolean(streamingKey && (hasStreamingBuffer || hasStreamingEvents));

    let activeKey = shouldUseStreamingKey
        ? streamingKey
        : getLastStatsMessageKey();
    if (typeof activeKey === "string" && activeKey.startsWith("tester:")) {
        activeKey = null;
    }

    const buffer = shouldUseStreamingKey
        ? streamingBuffer
        : getBufferForKey(activeKey);

    const stats = activeKey && state.messageStats instanceof Map
        ? state.messageStats.get(activeKey) || null
        : null;
    const matches = activeKey
        ? getCachedMatchesForBuffer(activeKey, buffer.length)
        : [];
    const rankingForMessage = activeKey && state.topSceneRanking instanceof Map
        ? state.topSceneRanking.get(activeKey) || []
        : [];

    const events = Array.isArray(state.recentDecisionEvents)
        ? state.recentDecisionEvents.filter((event) => {
            if (!event) {
                return false;
            }
            if (!event.messageKey) {
                return true;
            }
            if (!activeKey) {
                return !event.messageKey.startsWith("tester:");
            }
            const normalizedEventKey = normalizeMessageKey(event.messageKey);
            if (normalizedEventKey && normalizedEventKey.startsWith("tester:")) {
                return false;
            }
            return normalizedEventKey === activeKey;
        })
        : [];

    const eventsByCharacter = new Map();
    const MAX_RANKING_EVENTS = 2;
    events.forEach((event) => {
        if (!event || typeof event !== "object") {
            return;
        }
        const normalizedName = normalizeRosterKey(event.normalized || event.name);
        if (!normalizedName) {
            return;
        }
        const list = eventsByCharacter.get(normalizedName) || [];
        list.push(event);
        eventsByCharacter.set(normalizedName, list);
    });

    const latestRankingUpdatedAt = Number.isFinite(state.latestTopRanking?.updatedAt)
        ? state.latestTopRanking.updatedAt
        : null;
    const activeRankingUpdatedAt = ranking.length
        ? latestRankingUpdatedAt
        : getRankingUpdatedAtForKey(activeKey) ?? latestRankingUpdatedAt;

    const updatedAt = computeAnalyticsUpdatedAt({
        events,
        rankingUpdatedAt: activeRankingUpdatedAt,
        scene,
        membership: null,
        testers,
    });

    // FIX #9: Coverage calculation moved to buildSceneLogCopy (Async) for accurate token counts.

    const rankingSource = ranking.length ? ranking : rankingForMessage.slice(0, 4);
    const preparedRanking = rankingSource.map((entry) => {
        if (!entry || typeof entry !== "object") {
            return entry;
        }
        const normalizedName = normalizeRosterKey(entry.normalized || entry.name);
        const characterEvents = normalizedName ? eventsByCharacter.get(normalizedName) : null;
        const trimmedEvents = characterEvents && characterEvents.length
            ? characterEvents.slice(-MAX_RANKING_EVENTS)
            : [];
        return {
            ...entry,
            events: trimmedEvents,
        };
    });

    const panelState = {
        scene,
        membership: null,
        settings: panelSettings,
        ranking: preparedRanking,
        displayNames,
        analytics: {
            messageKey: activeKey,
            buffer,
            stats,
            ranking: rankingForMessage,
            events,
            matches,
            tokenCount: Number.isFinite(matches?.tokenCount) ? matches.tokenCount : null,
            minTokenIndex: Number.isFinite(matches?.minTokenIndex) ? matches.minTokenIndex : null,
            tokenizerId: matches?.tokenizerId || null,
            updatedAt,
        },
        now,
        isStreaming: Boolean(state.currentGenerationKey && shouldUseStreamingKey),
        collapsed: isScenePanelCollapsed(),
        testers,
    };
    lastCollectedScenePanelState = panelState;
    return panelState;
}

function performScenePanelRender(options = {}) {
    if (typeof document === "undefined") {
        return;
    }
    if (options?.source === "tester") {
        return;
    }
    const container = getScenePanelContainer?.();
    if (!container || (typeof container.length === "number" && container.length === 0)) {
        return;
    }
    const panelState = collectScenePanelState(options);
    renderScenePanel(panelState, options);
}

function requestScenePanelRender(reason = "update", { immediate = false, source = "scene" } = {}) {
    if (typeof document === "undefined") {
        return;
    }
    if (source === "tester") {
        return;
    }
    const container = getScenePanelContainer?.();
    if (!container || (typeof container.length === "number" && container.length === 0)) {
        return;
    }
    scenePanelRenderLastReason = reason;
    scenePanelRenderLastSource = source;
    const shouldImmediate = immediate || reason === "mount" || reason === "collapse";
    if (reason !== "collapse" && reason !== "mount") {
        triggerScenePanelUpdateCue();
    }
    const options = { reason, source };
    if (shouldImmediate) {
        if (scenePanelRenderTimer) {
            clearTimeout(scenePanelRenderTimer);
            scenePanelRenderTimer = null;
        }
        scenePanelRenderPending = false;
        performScenePanelRender(options);
        return;
    }
    if (scenePanelRenderTimer) {
        scenePanelRenderPending = true;
        return;
    }
    scenePanelRenderPending = false;
    scenePanelRenderTimer = setTimeout(() => {
        scenePanelRenderTimer = null;
        performScenePanelRender({
            reason: scenePanelRenderLastReason,
            source: scenePanelRenderLastSource,
        });
        if (scenePanelRenderPending) {
            scenePanelRenderPending = false;
            requestScenePanelRender("follow-up", { source: scenePanelRenderLastSource });
        }
    }, SCENE_PANEL_RENDER_DEBOUNCE_MS);
}

function initializeScenePanelAmbient() {
    if (typeof document === "undefined") {
        return;
    }

    const ambient = document.querySelector("#cs-scene-panel [data-scene-panel=\"ambient\"]");
    if (!ambient || ambient.dataset.nebulaInitialized === "true") {
        return;
    }

    ambient.dataset.nebulaInitialized = "true";
    ambient.textContent = "";

    const host = ambient.parentElement || ambient;

    const clouds = [];
    for (const blueprint of SCENE_PANEL_NEBULA_CLOUD_BLUEPRINTS) {
        const layer = document.createElement("div");
        if (!layer) {
            continue;
        }
        layer.className = "nebula-cloud";
        layer.dataset.sizeRatio = String(blueprint.sizeRatio);
        layer.style.setProperty("--cloud-left", `${blueprint.left}%`);
        layer.style.setProperty("--cloud-top", `${blueprint.top}%`);
        layer.style.setProperty("--cloud-duration", `${blueprint.duration}s`);
        layer.style.setProperty("--cloud-delay", `${blueprint.delay}s`);
        layer.style.setProperty("--cloud-opacity", `${blueprint.opacity}`);
        layer.style.setProperty("--cloud-blur", `${blueprint.blur}px`);
        layer.style.setProperty("--cloud-rotation-start", blueprint.rotationStart);
        layer.style.setProperty("--cloud-rotation-mid", blueprint.rotationMid);
        layer.style.setProperty("--cloud-rotation-end", blueprint.rotationEnd);
        layer.style.setProperty("--cloud-scale-start", `${blueprint.scaleStart}`);
        layer.style.setProperty("--cloud-scale-mid", `${blueprint.scaleMid}`);
        layer.style.setProperty("--cloud-scale-end", `${blueprint.scaleEnd}`);
        layer.style.setProperty("--cloud-color-primary", blueprint.colorPrimary);
        layer.style.setProperty("--cloud-color-secondary", blueprint.colorSecondary);
        ambient.appendChild(layer);
        clouds.push({ element: layer, blueprint });
    }

    const stars = [];
    for (const blueprint of SCENE_PANEL_NEBULA_STAR_BLUEPRINTS) {
        const star = document.createElement("div");
        if (!star) {
            continue;
        }
        star.className = "nebula-star";
        star.dataset.sizeRatio = String(blueprint.sizeRatio);
        star.style.setProperty("--star-left", `${blueprint.left}%`);
        star.style.setProperty("--star-top", `${blueprint.top}%`);
        star.style.setProperty("--star-duration", `${blueprint.duration}s`);
        star.style.setProperty("--star-delay", `${blueprint.delay}s`);
        star.style.setProperty("--star-opacity", `${blueprint.opacity}`);
        ambient.appendChild(star);
        stars.push({ element: star, blueprint });
    }

    const updateDimensions = () => {
        if (!host || typeof host.getBoundingClientRect !== "function") {
            return;
        }
        const { width, height } = host.getBoundingClientRect();
        const reference = Math.max(width, height, 1);

        for (const entry of clouds) {
            if (!entry?.element) {
                continue;
            }
            const baseSize = reference * entry.blueprint.sizeRatio;
            entry.element.style.setProperty("--cloud-size", `${baseSize}px`);
        }

        for (const entry of stars) {
            if (!entry?.element) {
                continue;
            }
            const baseSize = reference * entry.blueprint.sizeRatio;
            entry.element.style.setProperty("--star-size", `${baseSize}px`);
        }
    };

    updateDimensions();

    if (typeof ResizeObserver === "function" && host) {
        const observer = new ResizeObserver(updateDimensions);
        observer.observe(host);
    } else if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
        window.addEventListener("resize", updateDimensions, { passive: true });
    }
}

function initializeScenePanelUI() {
    if (scenePanelUiWired) {
        return;
    }
    const toggle = getSceneCollapseToggle?.();
    if (toggle && typeof toggle.on === "function") {
        toggle.on("click", () => toggleScenePanelCollapsed());
    } else if (toggle?.[0]) {
        toggle[0].addEventListener("click", toggleScenePanelCollapsed);
    }
    const container = getScenePanelContainer?.();
    if (container) {
        if (typeof container.attr === "function") {
            if (container.attr("data-cs-collapsed") == null) {
                container.attr("data-cs-collapsed", "false");
            }
        } else if (container?.[0] && !container[0].hasAttribute("data-cs-collapsed")) {
            container[0].setAttribute("data-cs-collapsed", "false");
        }
    }
    initializeScenePanelAmbient();
    scenePanelUiWired = true;
}

function getScenePanelLayerElement() {
    if (typeof document === "undefined") {
        return null;
    }
    return document.getElementById("cs-scene-panel-layer");
}

function getScenePanelLayerBodyElement() {
    const layer = getScenePanelLayerElement();
    if (!layer) {
        return null;
    }
    return layer.querySelector('[data-scene-panel="sheet-body"]');
}

function getScenePanelLayerTitleElement() {
    const layer = getScenePanelLayerElement();
    if (!layer) {
        return null;
    }
    return layer.querySelector('[data-scene-panel="layer-title"]');
}

function getScenePanelLayerDescriptionElement() {
    const layer = getScenePanelLayerElement();
    if (!layer) {
        return null;
    }
    return layer.querySelector('[data-scene-panel="layer-description"]');
}

function openScenePanelLayer({ title, description, mode } = {}) {
    if (typeof document === "undefined") {
        return null;
    }
    const layer = getScenePanelLayerElement();
    if (!layer) {
        return null;
    }
    scenePanelLayerMode = mode || null;
    const titleEl = getScenePanelLayerTitleElement();
    if (titleEl && typeof title === "string") {
        titleEl.textContent = title;
    }
    const descriptionEl = getScenePanelLayerDescriptionElement();
    if (descriptionEl && typeof description === "string") {
        descriptionEl.textContent = description;
    }
    layer.hidden = false;
    layer.setAttribute("aria-hidden", "false");
    if (typeof document.activeElement !== "undefined") {
        scenePanelLayerReturnFocus = document.activeElement;
    }
    const closeButton = layer.querySelector('[data-scene-panel="close-layer"]');
    setTimeout(() => {
        if (closeButton && typeof closeButton.focus === "function") {
            closeButton.focus();
        }
    }, 0);
    rerenderScenePanelLayer();
    return layer;
}

function closeScenePanelLayer({ restoreFocus = true } = {}) {
    const layer = getScenePanelLayerElement();
    if (layer) {
        layer.setAttribute("aria-hidden", "true");
        layer.hidden = true;
    }
    const focusTarget = scenePanelLayerReturnFocus;
    scenePanelLayerMode = null;
    scenePanelLayerReturnFocus = null;
    if (restoreFocus && focusTarget && typeof focusTarget.focus === "function") {
        try {
            focusTarget.focus();
        } catch (err) {
        }
    }
}

function isScenePanelLayerOpen() {
    const layer = getScenePanelLayerElement();
    return Boolean(layer && !layer.hidden);
}

function rerenderScenePanelLayer() {
    if (!scenePanelLayerMode) {
        return;
    }
    if (scenePanelLayerMode === "roster") {
        renderSceneRosterManagerLayer();
        return;
    }
    if (scenePanelLayerMode === "log") {
        renderSceneLogLayer();
        return;
    }
    if (scenePanelLayerMode === "settings") {
        renderSceneSettingsLayer();
    }
}

function formatRosterManagerMeta(member, now) {
    const parts = [];
    if (member.active) {
        parts.push("Active now");
    } else if (Number.isFinite(member.lastSeenAt)) {
        parts.push(`Seen ${formatRelativeTime(member.lastSeenAt, now) || "recently"}`);
    } else {
        parts.push("Inactive");
    }
    if (Number.isFinite(member.joinedAt)) {
        const joined = formatRelativeTime(member.joinedAt, now);
        if (joined) {
            parts.push(`Joined ${joined}`);
        }
    }
    return parts.join(" • ");
}

function renderSceneRosterManagerLayer() {
    const body = getScenePanelLayerBodyElement();
    if (!body) {
        return;
    }
    body.textContent = "";
    const sceneSnapshot = typeof getCurrentSceneSnapshot === "function"
        ? getCurrentSceneSnapshot()
        : null;
    const members = Array.isArray(sceneSnapshot?.roster) ? sceneSnapshot.roster.slice() : [];
    const now = Date.now();
    members.sort((a, b) => {
        if ((a?.active ? 1 : 0) !== (b?.active ? 1 : 0)) {
            return a?.active ? -1 : 1;
        }
        const aSeen = Number.isFinite(a?.lastSeenAt) ? a.lastSeenAt : 0;
        const bSeen = Number.isFinite(b?.lastSeenAt) ? b.lastSeenAt : 0;
        return bSeen - aSeen;
    });
    const activeCount = members.filter((member) => member?.active).length;
    const summary = document.createElement("div");
    summary.className = "cs-scene-manager__summary";
    summary.textContent = `Active: ${activeCount} • Tracked: ${members.length}`;
    body.appendChild(summary);
    if (!members.length) {
        const empty = document.createElement("div");
        empty.className = "cs-scene-manager__empty";
        empty.textContent = "No characters are currently tracked. Add a name to prime the roster.";
        body.appendChild(empty);
    } else {
        const list = document.createElement("ul");
        list.className = "cs-scene-manager__list";
        members.forEach((member) => {
            if (!member) {
                return;
            }
            const item = document.createElement("li");
            item.className = "cs-scene-manager__row";
            item.dataset.character = member.normalized || member.name || "";
            const identity = document.createElement("div");
            identity.className = "cs-scene-manager__identity";
            const name = document.createElement("span");
            name.className = "cs-scene-manager__name";
            name.textContent = member.name || member.normalized || "Unknown";
            identity.appendChild(name);
            const meta = document.createElement("span");
            meta.className = "cs-scene-manager__meta";
            meta.textContent = formatRosterManagerMeta(member, now);
            identity.appendChild(meta);
            item.appendChild(identity);
            const actions = document.createElement("div");
            actions.className = "cs-scene-manager__actions";
            const toggle = document.createElement("button");
            toggle.type = "button";
            toggle.className = "cs-scene-manager__toggle";
            toggle.dataset.action = "toggle-active";
            toggle.dataset.name = member.name || member.normalized || "";
            toggle.textContent = member.active ? "Mark inactive" : "Reactivate";
            actions.appendChild(toggle);
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "cs-scene-manager__remove";
            remove.dataset.action = "remove-member";
            remove.dataset.name = member.name || member.normalized || "";
            remove.textContent = "Remove";
            actions.appendChild(remove);
            item.appendChild(actions);
            list.appendChild(item);
        });
        body.appendChild(list);
    }
    const form = document.createElement("form");
    form.className = "cs-scene-manager__form";
    form.id = "cs-scene-manager-form";
    form.dataset.scenePanel = "manager-form";
    const input = document.createElement("input");
    input.type = "text";
    input.name = "character";
    input.placeholder = "Add character name…";
    input.autocomplete = "off";
    input.className = "cs-scene-manager__input";
    form.appendChild(input);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "cs-scene-manager__submit";
    submit.textContent = "Add to roster";
    form.appendChild(submit);
    body.appendChild(form);
}

function renderSceneLogLayer() {
    const body = getScenePanelLayerBodyElement();
    if (!body) {
        return;
    }
    body.textContent = "";
    const panelState = collectScenePanelState();
    const analytics = panelState?.analytics || {};
    const events = Array.isArray(analytics.events) ? analytics.events.slice(-50) : [];
    const now = Number.isFinite(panelState?.now) ? panelState.now : Date.now();
    const summary = document.createElement("div");
    summary.className = "cs-scene-manager__summary";
    const updatedCopy = formatRelativeTime(analytics.updatedAt, now) || "just now";
    const charCount = typeof analytics.buffer === "string" ? analytics.buffer.length : 0;
    summary.textContent = `Last updated ${updatedCopy} • Buffer ${charCount} chars • Events ${events.length}`;
    body.appendChild(summary);
    const stats = analytics.stats instanceof Map ? analytics.stats : null;
    if (stats && stats.size) {
        const statsList = document.createElement("ul");
        statsList.className = "cs-scene-log__stats";
        Array.from(stats.entries()).slice(0, 8).forEach(([normalized, count]) => {
            const item = document.createElement("li");
            const name = panelState.displayNames?.get(normalized) || normalized;
            item.textContent = `${name} × ${count}`;
            statsList.appendChild(item);
        });
        body.appendChild(statsList);
    }
    if (!events.length) {
        const empty = document.createElement("div");
        empty.className = "cs-scene-manager__empty";
        empty.textContent = panelState?.isStreaming
            ? "Awaiting detections for this message…"
            : "No live diagnostics recorded yet.";
        body.appendChild(empty);
        return;
    }
    const list = document.createElement("div");
    list.className = "cs-scene-layer__events";
    events.forEach((entry) => {
        if (!entry || typeof entry !== "object") {
            return;
        }
        const wrapper = document.createElement("div");
        wrapper.className = "cs-scene-log__event";
        if (entry.type) {
            wrapper.dataset.eventType = entry.type;
        }
        const title = document.createElement("div");
        title.className = "cs-scene-log__event-title";
        if (entry.type === "switch") {
            const folder = entry.outfit?.folder ? ` → ${entry.outfit.folder}` : "";
            title.textContent = `Switch${folder}`;
        } else if (entry.type === "skipped") {
            const reason = describeSkipReason(entry.reason);
            const name = entry.name ? ` ${entry.name}` : "";
            title.textContent = `Skipped${name} · ${reason}`;
        } else if (entry.type === "veto") {
            title.textContent = `Veto · ${entry.match || "unknown"}`;
        } else {
            title.textContent = entry.type || "Event";
        }
        wrapper.appendChild(title);
        const metaParts = [];
        if (entry.name && entry.type !== "skipped") {
            metaParts.push(entry.name);
        }
        if (entry.matchKind) {
            metaParts.push(entry.matchKind);
        }
        if (Number.isFinite(entry.charIndex)) {
            metaParts.push(`#${entry.charIndex + 1}`);
        }
        if (entry.outfit?.label) {
            metaParts.push(entry.outfit.label);
        }
        const when = formatRelativeTime(entry.timestamp, now);
        if (when) {
            metaParts.push(when);
        }
        if (metaParts.length) {
            const meta = document.createElement("div");
            meta.className = "cs-scene-log__event-meta";
            meta.textContent = metaParts.join(" • ");
            wrapper.appendChild(meta);
        }
        list.appendChild(wrapper);
    });
    body.appendChild(list);
}

function renderSceneSettingsLayer() {
    const body = getScenePanelLayerBodyElement();
    if (!body) {
        return;
    }
    body.textContent = "";
    const settings = ensureScenePanelSettings(getSettings?.() || {});
    const sections = settings.sections || {};

    const container = document.createElement("div");
    container.className = "cs-scene-settings";

    const intro = document.createElement("p");
    intro.className = "cs-scene-settings__intro";
    intro.textContent = "Tune the scene panel layout without leaving chat. Changes save automatically.";
    container.appendChild(intro);

    const createToggle = ({ id, label, description, checked, onChange }) => {
        const wrapper = document.createElement("label");
        wrapper.className = "cs-scene-settings__toggle";
        wrapper.setAttribute("for", id);
        const input = document.createElement("input");
        input.id = id;
        input.type = "checkbox";
        input.className = "cs-scene-settings__checkbox";
        input.checked = Boolean(checked);
        input.addEventListener("change", (event) => {
            try {
                onChange(Boolean(event.target?.checked));
            } catch (err) {
                console.warn(`${logPrefix} Failed to update scene panel setting from in-panel controls.`, err);
            }
        });
        wrapper.appendChild(input);
        const copy = document.createElement("div");
        copy.className = "cs-scene-settings__toggle-copy";
        const title = document.createElement("span");
        title.className = "cs-scene-settings__toggle-label";
        title.textContent = label;
        copy.appendChild(title);
        if (description) {
            const detail = document.createElement("span");
            detail.className = "cs-scene-settings__toggle-description";
            detail.textContent = description;
            copy.appendChild(detail);
        }
        wrapper.appendChild(copy);
        return wrapper;
    };

    const behaviorGroup = document.createElement("div");
    behaviorGroup.className = "cs-scene-settings__group";
    const behaviorTitle = document.createElement("h5");
    behaviorTitle.className = "cs-scene-settings__group-title";
    behaviorTitle.textContent = "Auto-open behavior";
    behaviorGroup.appendChild(behaviorTitle);
    behaviorGroup.appendChild(createToggle({
        id: "cs-scene-settings-auto-stream",
        label: "Open when streaming starts",
        description: "Expand the side panel whenever a new generation begins streaming.",
        checked: settings.autoOpenOnStream,
        onChange: (checked) => applyScenePanelAutoOpenOnStreamSetting(checked),
    }));
    behaviorGroup.appendChild(createToggle({
        id: "cs-scene-settings-auto-results",
        label: "Open for new results",
        description: "Pop the panel open whenever detection results arrive.",
        checked: settings.autoOpenOnResults,
        onChange: (checked) => applyScenePanelAutoOpenResultsSetting(checked),
    }));
    container.appendChild(behaviorGroup);

    const contentGroup = document.createElement("div");
    contentGroup.className = "cs-scene-settings__group";
    const contentTitle = document.createElement("h5");
    contentTitle.className = "cs-scene-settings__group-title";
    contentTitle.textContent = "Panel content";
    contentGroup.appendChild(contentTitle);
    contentGroup.appendChild(createToggle({
        id: "cs-scene-settings-section-roster",
        label: "Show roster section",
        description: "Keep the roster list visible next to chat.",
        checked: sections.roster !== false,
        onChange: (checked) => applyScenePanelSectionSetting("roster", checked),
    }));
    contentGroup.appendChild(createToggle({
        id: "cs-scene-settings-section-active",
        label: "Show active characters section",
        description: "Display focus lock controls and current participants.",
        checked: sections.activeCharacters !== false,
        onChange: (checked) => applyScenePanelSectionSetting("activeCharacters", checked),
    }));
    contentGroup.appendChild(createToggle({
        id: "cs-scene-settings-section-log",
        label: "Show live log section",
        description: "Include the live detection event feed inside the panel.",
        checked: sections.liveLog !== false,
        onChange: (checked) => applyScenePanelSectionSetting("liveLog", checked),
    }));
    contentGroup.appendChild(createToggle({
        id: "cs-scene-settings-section-coverage",
        label: "Show coverage suggestions",
        description: "Surface vocabulary gaps directly alongside the roster.",
        checked: sections.coverage !== false,
        onChange: (checked) => applyScenePanelSectionSetting("coverage", checked),
    }));
    contentGroup.appendChild(createToggle({
        id: "cs-scene-settings-auto-pin",
        label: "Auto-pin top active character",
        description: "Keep the most recent match highlighted for quick review.",
        checked: settings.autoPinActive !== false,
        onChange: (checked) => applyScenePanelAutoPinSetting(checked),
    }));
    contentGroup.appendChild(createToggle({
        id: "cs-scene-settings-show-avatars",
        label: "Show roster avatars",
        description: "Use character thumbnails in the roster when available.",
        checked: settings.showRosterAvatars,
        onChange: (checked) => applyScenePanelShowAvatarsSetting(checked),
    }));
    container.appendChild(contentGroup);

    const openFullSettings = document.createElement("button");
    openFullSettings.id = "cs-scene-panel-settings-open-extension";
    openFullSettings.type = "button";
    openFullSettings.className = "cs-scene-panel__text-button cs-scene-settings__link";
    openFullSettings.textContent = "Open full extension settings";
    container.appendChild(openFullSettings);

    body.appendChild(container);
}

function syncSceneRosterFromMembership({ message } = {}) {
    const now = Date.now();
    let sceneSnapshot = typeof getCurrentSceneSnapshot === "function"
        ? getCurrentSceneSnapshot()
        : null;
    const testersSnapshot = typeof getLiveTesterOutputsSnapshot === "function"
        ? getLiveTesterOutputsSnapshot()
        : null;
    const resolvedScene = resolveSceneMessageState(sceneSnapshot);
    sceneSnapshot = resolvedScene.sceneSnapshot;
    const messageState = resolvedScene.messageState;
    const derived = deriveSceneRosterState({
        messageState,
        sceneSnapshot,
        testerSnapshot: testersSnapshot,
        now,
    });
    applySceneRosterUpdate({
        key: derived.key,
        messageId: derived.messageId,
        roster: derived.roster,
        displayNames: derived.displayNames,
        lastMatch: derived.lastEvent,
        updatedAt: now,
        turnsByMember: messageState?.rosterTurns,
        turnsRemaining: messageState?.defaultRosterTTL,
    });
    requestScenePanelRender("roster-manager", { immediate: true });
    if (message) {
        showStatus(message, "success");
    }
}

async function buildSceneLogCopy(panelState = collectScenePanelState()) {
    if (!panelState || typeof panelState !== "object") {
        return "No live events recorded yet.";
    }
    const analytics = panelState.analytics || {};

    // FIX #9: Calculate accurate coverage stats on demand (async)
    const bufferForCoverage = typeof analytics.buffer === "string" ? analytics.buffer : "";
    let coverage = panelState.coverage;
    if (!coverage) {
        if (bufferForCoverage && bufferForCoverage.trim().length > 0) {
            const profile = getActiveProfile();
            coverage = await analyzeCoverageDiagnostics(bufferForCoverage, profile);
        } else {
            const fallback = state.lastTesterReport?.coverage || state.coverageDiagnostics;
            coverage = cloneCoverageDiagnostics(fallback);
        }
    }
    const events = Array.isArray(analytics.events) ? analytics.events : [];
    const matches = Array.isArray(analytics.matches) ? analytics.matches : [];
    const stats = analytics.stats instanceof Map ? analytics.stats : null;
    const ranking = Array.isArray(analytics.ranking) ? analytics.ranking : [];
    const rosterEntries = Array.isArray(panelState.scene?.roster) ? panelState.scene.roster : [];
    const lines = [];

    lines.push("Scene Panel Report");
    const updatedAt = Number.isFinite(analytics.updatedAt) ? analytics.updatedAt : null;
    if (updatedAt) {
        lines.push(`Updated: ${new Date(updatedAt).toLocaleString()}`);
    }
    if (analytics.messageKey) {
        lines.push(`Message key: ${analytics.messageKey}`);
    }
    lines.push("");

    const buffer = typeof analytics.buffer === "string" ? analytics.buffer : "";
    lines.push("Analyzed Buffer:");
    lines.push(buffer ? buffer : "(empty)");
    lines.push("");

    const now = Number.isFinite(panelState.now) ? panelState.now : Date.now();
    const activeMembers = rosterEntries.map((entry) => ({
        name: entry.name || entry.normalized || "Unknown",
        active: entry.active !== false,
        joinedAt: Number.isFinite(entry.joinedAt) ? entry.joinedAt : null,
        lastSeenAt: Number.isFinite(entry.lastSeenAt) ? entry.lastSeenAt : null,
        turnsRemaining: Number.isFinite(entry.turnsRemaining) ? Math.max(0, entry.turnsRemaining) : null,
    }));
    const inactiveMembers = rosterEntries
        .filter((member) => member && member.active === false)
        .map((member) => ({
            name: member.name || member.normalized || "Unknown",
            lastLeftAt: Number.isFinite(member.lastLeftAt) ? member.lastLeftAt : null,
        }));

    lines.push(`Scene Roster (${activeMembers.length}):`);
    if (activeMembers.length) {
        activeMembers.forEach((entry, idx) => {
            const joined = entry.joinedAt ? formatRelativeTime(entry.joinedAt, now) : null;
            const seen = entry.lastSeenAt ? formatRelativeTime(entry.lastSeenAt, now) : null;
            const ttl = entry.turnsRemaining != null
                ? `${entry.turnsRemaining} message${entry.turnsRemaining === 1 ? "" : "s"} left`
                : "TTL unknown";
            const metaParts = [];
            if (joined) metaParts.push(`joined ${joined}`);
            if (seen) metaParts.push(`seen ${seen}`);
            metaParts.push(ttl);
            lines.push(`  ${idx + 1}. ${entry.name} – ${metaParts.join(", ")}`);
        });
    } else {
        lines.push("  (empty)");
    }
    if (inactiveMembers.length) {
        lines.push("");
        lines.push(`Inactive members (${inactiveMembers.length}):`);
        inactiveMembers.forEach((entry, idx) => {
            const left = entry.lastLeftAt ? formatRelativeTime(entry.lastLeftAt, now) : "time unknown";
            lines.push(`  ${idx + 1}. ${entry.name} – left ${left}`);
        });
    }
    lines.push("");

    const mergedDetections = mergeDetectionsForReport({ matches, events });
    const detectionSummary = summarizeDetections(mergedDetections);
    lines.push("Detection Summary:");
    if (detectionSummary.length) {
        detectionSummary.forEach((item) => {
            const kindBreakdown = Object.entries(item.kinds)
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .map(([kind, count]) => `${kind}:${count}`)
                .join(", ");
            const priorityInfo = item.highestPriority != null ? `, highest priority ${item.highestPriority}` : "";
            const rangeInfo = item.earliest != null
                ? item.latest != null && item.latest !== item.earliest
                    ? `, chars ${item.earliest}-${item.latest}`
                    : `, char ${item.earliest}`
                : "";
            lines.push(`  - ${item.name}: ${item.total} detections (${kindBreakdown || "none"}${priorityInfo}${rangeInfo})`);
        });
    } else {
        lines.push("  (none)");
    }
    lines.push("");

    lines.push("Switch & Event Timeline:");
    if (events.length) {
        events.forEach((event, idx) => {
            const timestamp = Number.isFinite(event.timestamp)
                ? new Date(event.timestamp).toLocaleString()
                : "Timestamp unavailable";
            const charPos = Number.isFinite(event.charIndex) ? event.charIndex + 1 : "?";
            if (event.type === "switch") {
                const detail = event.matchKind ? ` via ${event.matchKind}` : "";
                const score = Number.isFinite(event.score) ? `, score ${event.score}` : "";
                const outfitSummary = summarizeOutfitDecision(event.outfit, { separator: "; ", includeFolder: false });
                const outfitNote = outfitSummary ? ` [${outfitSummary}]` : "";
                lines.push(`  ${idx + 1}. [${timestamp}] SWITCH → ${event.folder || event.name}${detail} @ char ${charPos}${score}${outfitNote}`);
            } else if (event.type === "veto") {
                lines.push(`  ${idx + 1}. [${timestamp}] VETO – matched "${event.match}" @ char ${charPos}`);
            } else {
                const reason = describeSkipReason(event.reason);
                const outfitSummary = summarizeOutfitDecision(event.outfit, { separator: "; ", includeFolder: false });
                const outfitNote = outfitSummary ? ` [${outfitSummary}]` : "";
                lines.push(`  ${idx + 1}. [${timestamp}] SKIP – ${event.name} (${event.matchKind || "unknown"}) because ${reason}${outfitNote}`);
            }
        });
    } else {
        lines.push("  (no recorded events)");
    }
    lines.push("");

    const switchSummary = summarizeSwitchesForReport(events);
    lines.push("Switch Summary:");
    lines.push(`  Total switches: ${switchSummary.total}`);
    if (switchSummary.uniqueCount > 0) {
        lines.push(`  Unique costumes: ${switchSummary.uniqueCount} (${switchSummary.uniqueFolders.join(", ")})`);
    } else {
        lines.push("  Unique costumes: 0");
    }
    if (switchSummary.lastSwitch) {
        const last = switchSummary.lastSwitch;
        const charPos = Number.isFinite(last.charIndex) ? last.charIndex + 1 : "?";
        const detail = last.matchKind ? ` via ${last.matchKind}` : "";
        const score = Number.isFinite(last.score) ? `, score ${last.score}` : "";
        const outfitSummary = summarizeOutfitDecision(last.outfit, { separator: "; ", includeFolder: false });
        const outfitNote = outfitSummary ? ` [${outfitSummary}]` : "";
        lines.push(`  Last switch: ${last.folder || last.name || "(unknown)"}${detail} @ char ${charPos}${score}${outfitNote}`);
    } else {
        lines.push("  Last switch: (none)");
    }
    if (switchSummary.topScores.length) {
        lines.push("  Top switch scores:");
        switchSummary.topScores.forEach((event, idx) => {
            const charPos = Number.isFinite(event.charIndex) ? event.charIndex + 1 : "?";
            const detail = event.matchKind ? ` via ${event.matchKind}` : "";
            const outfitSummary = summarizeOutfitDecision(event.outfit, { separator: "; ", includeFolder: false });
            const outfitNote = outfitSummary ? ` [${outfitSummary}]` : "";
            lines.push(`    ${idx + 1}. ${event.folder || event.name || "(unknown)"} – ${event.score} (trigger: ${event.name}${detail}, char ${charPos})${outfitNote}`);
        });
    }
    lines.push("");

    const skipSummary = summarizeSkipReasonsForReport(events);
    lines.push("Skip Reasons:");
    if (skipSummary.length) {
        skipSummary.forEach((item) => {
            lines.push(`  - ${describeSkipReason(item.code)} (${item.code}): ${item.count}`);
        });
    } else {
        lines.push("  (none)");
    }
    lines.push("");

    if (stats && typeof stats.forEach === "function") {
        const statEntries = Array.from(stats.entries ? stats.entries() : stats);
        statEntries.sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), undefined, { sensitivity: "base" }));
        lines.push("Detection Counts:");
        if (statEntries.length) {
            statEntries.forEach(([name, count]) => {
                lines.push(`  - ${name}: ${count}`);
            });
        } else {
            lines.push("  (none)");
        }
        lines.push("");
    }

    if (ranking.length) {
        lines.push("Top Characters:");
        ranking.slice(0, 4).forEach((entry, idx) => {
            const rosterTag = entry.inSceneRoster ? " [scene roster]" : "";
            const scorePart = Number.isFinite(entry.score) ? ` (score ${entry.score})` : "";
            lines.push(`  ${idx + 1}. ${entry.name} – ${entry.count ?? 0} detections${rosterTag}${scorePart}`);
        });
        lines.push("");
    }

    // DEBUG EXTENSION: Inject detailed diagnostics for user debugging
    lines.push("");
    lines.push("Debug Info:");
    const profile = getActiveProfile();
    const regexSrc = state.compiledRegexes?.nameRegex?.source || "N/A";
    lines.push(`Name Regex: ${regexSrc}`);
    try {
        const slotsStr = profile?.patternSlots ? JSON.stringify(profile.patternSlots) : "N/A";
        lines.push(`Pattern Slots: ${slotsStr}`);
    } catch (e) {
        lines.push(`Pattern Slots: (error) ${e.message}`);
    }

    return lines.join("\n");
}

async function copyScenePanelLog() {
    if (typeof document === "undefined") {
        return false;
    }
    const text = await buildSceneLogCopy();
    if (!text) {
        return false;
    }
    try {
        if (navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (err) {
    }
    try {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "absolute";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
        return true;
    } catch (err) {
        return false;
    }
}

function handleScenePanelManageRoster(event) {
    event?.preventDefault?.();
    openScenePanelLayer({
        mode: "roster",
        title: "Manage scene roster",
        description: "Prime, reactivate, or remove characters from the live roster.",
    });
}

function handleScenePanelClearRoster(event) {
    event?.preventDefault?.();
    if (!confirm("Clear the entire scene roster?")) {
        return;
    }
    const { messageState } = resolveSceneManagerState();
    if (messageState.sceneRoster instanceof Set) {
        messageState.sceneRoster.clear();
    }
    if (messageState.rosterTurns instanceof Map) {
        messageState.rosterTurns.clear();
    }
    if (messageState.removedRoster instanceof Set) {
        messageState.removedRoster.clear();
    }
    syncSceneRosterFromMembership({ message: "Scene roster cleared." });
    rerenderScenePanelLayer();
}

const handleScenePanelRefresh = createScenePanelRefreshHandler({
    restoreLatestSceneOutcome,
    requestScenePanelRender,
    rerenderScenePanelLayer,
    showStatus,
    getCurrentSceneSnapshot,
    getLatestStoredSceneTimestamp,
});

async function handleScenePanelFocusToggle(event) {
    event?.preventDefault?.();
    const settings = getSettings?.();
    if (!settings) {
        return;
    }
    const lockedName = String(settings?.focusLock?.character ?? "").trim();
    if (lockedName) {
        settings.focusLock.character = null;
        await manualReset();
        updateFocusLockUI();
        persistSettings("Focus lock removed.", "info");
        showStatus("Focus lock removed.", "info");
        requestScenePanelRender("focus-lock", { immediate: true });
        return;
    }
    const panelState = collectScenePanelState();
    const ranking = Array.isArray(panelState?.ranking) ? panelState.ranking : [];
    const sceneRoster = Array.isArray(panelState?.scene?.roster) ? panelState.scene.roster : [];
    let candidate = ranking.find((entry) => entry?.name) || sceneRoster.find((entry) => entry && (entry.name || typeof entry === "string"));
    if (candidate && typeof candidate === "object") {
        candidate = candidate.name || candidate.normalized || null;
    }
    if (typeof candidate !== "string" || !candidate.trim()) {
        showStatus("No recent characters to focus lock.", "info");
        return;
    }
    const target = candidate.trim();
    settings.focusLock.character = target;
    await issueCostumeForName(target, { isLock: true });
    updateFocusLockUI();
    persistSettings(`Focus lock set to "${escapeHtml(target)}".`, "info");
    showStatus(`Focus lock set to ${target}.`, "success");
    requestScenePanelRender("focus-lock", { immediate: true });
}

function handleScenePanelExpandLog(event) {
    event?.preventDefault?.();
    openScenePanelLayer({
        mode: "log",
        title: "Live result log",
        description: "Review the latest detection events and diagnostics.",
    });
}

async function handleScenePanelCopyLog(event) {
    event?.preventDefault?.();
    const success = await copyScenePanelLog();
    if (success) {
        showStatus("Live log copied to clipboard.", "success");
    } else {
        showStatus("Unable to copy the live log.", "error");
    }
}

function openExtensionSettingsView() {
    let opened = false;
    try {
        const ctx = typeof getContext === "function"
            ? getContext()
            : window?.SillyTavern?.getContext?.();
        if (ctx?.ui?.openExtensionSettings) {
            ctx.ui.openExtensionSettings(extensionName);
            opened = true;
        } else if (ctx?.openExtensionSettings) {
            ctx.openExtensionSettings(extensionName);
            opened = true;
        }
    } catch (err) {
    }
    if (typeof document !== "undefined") {
        const menuButton = document.querySelector('[data-menu="extensions"]');
        if (menuButton) {
            menuButton.dispatchEvent(new Event("click", { bubbles: true }));
            opened = true;
        }
        const container = document.getElementById("costume-switcher-settings");
        if (container) {
            container.scrollIntoView({ behavior: "smooth", block: "start" });
            opened = true;
        }
    }
    return opened;
}

function handleScenePanelOpenSettings(event) {
    event?.preventDefault?.();
    openScenePanelLayer({
        mode: "settings",
        title: "Scene roster settings",
        description: "Adjust auto-open behavior and choose which sections appear in the side panel.",
    });
}

function handleSceneManagerSubmit(event) {
    event?.preventDefault?.();
    const form = event?.currentTarget;
    const input = form?.querySelector(".cs-scene-manager__input");
    const name = String(input?.value || "").trim();
    if (!name) {
        showStatus("Enter a character name to add.", "info");
        return;
    }
    const { messageState } = resolveSceneManagerState();
    const normalized = normalizeRosterKey(name);
    if (!normalized) {
        showStatus("Unable to add that name to the roster.", "error");
        return;
    }
    if (!(messageState.sceneRoster instanceof Set)) {
        messageState.sceneRoster = new Set();
    }
    messageState.sceneRoster.add(normalized);
    if (messageState.removedRoster instanceof Set) {
        messageState.removedRoster.delete(normalized);
    }
    const defaultTTL = sanitizeRosterTurnValue(messageState.defaultRosterTTL);
    if (!(messageState.rosterTurns instanceof Map)) {
        messageState.rosterTurns = new Map();
    }
    if (defaultTTL != null) {
        messageState.rosterTurns.set(normalized, defaultTTL);
    } else {
        messageState.rosterTurns.delete(normalized);
    }
    if (input) {
        input.value = "";
    }
    syncSceneRosterFromMembership({ message: `${escapeHtml(name)} added to the scene roster.` });
    rerenderScenePanelLayer();
}

function handleSceneManagerToggle(event) {
    event?.preventDefault?.();
    const button = event?.currentTarget;
    const name = String(button?.dataset?.name || "").trim();
    if (!name) {
        return;
    }
    const { messageState } = resolveSceneManagerState();
    const normalized = normalizeRosterKey(name);
    if (!normalized) {
        return;
    }
    if (!(messageState.sceneRoster instanceof Set)) {
        messageState.sceneRoster = new Set();
    }
    const isActive = messageState.sceneRoster.has(normalized);
    const nextActive = !isActive;
    if (nextActive) {
        messageState.sceneRoster.add(normalized);
        if (messageState.removedRoster instanceof Set) {
            messageState.removedRoster.delete(normalized);
        }
        const defaultTTL = sanitizeRosterTurnValue(messageState.defaultRosterTTL);
        if (!(messageState.rosterTurns instanceof Map)) {
            messageState.rosterTurns = new Map();
        }
        if (defaultTTL != null) {
            messageState.rosterTurns.set(normalized, defaultTTL);
        }
    } else {
        messageState.sceneRoster.delete(normalized);
        if (messageState.rosterTurns instanceof Map) {
            messageState.rosterTurns.delete(normalized);
        }
    }
    syncSceneRosterFromMembership({
        message: nextActive
            ? `${escapeHtml(name)} reactivated.`
            : `${escapeHtml(name)} marked inactive.`,
    });
    rerenderScenePanelLayer();
}

function handleSceneManagerRemove(event) {
    event?.preventDefault?.();
    const button = event?.currentTarget;
    const name = String(button?.dataset?.name || "").trim();
    if (!name) {
        return;
    }
    if (!confirm(`Remove ${name} from the scene roster?`)) {
        return;
    }
    const { messageState } = resolveSceneManagerState();
    const normalized = normalizeRosterKey(name);
    if (normalized) {
        if (messageState.sceneRoster instanceof Set) {
            messageState.sceneRoster.delete(normalized);
        }
        if (messageState.rosterTurns instanceof Map) {
            messageState.rosterTurns.delete(normalized);
        }
        if (!(messageState.removedRoster instanceof Set)) {
            messageState.removedRoster = new Set();
        }
        messageState.removedRoster.add(normalized);
    }
    syncSceneRosterFromMembership({ message: `${escapeHtml(name)} removed from the scene roster.` });
    rerenderScenePanelLayer();
}


// ======================================================================
// UTILITY & HELPER FUNCTIONS
// ======================================================================
function resolveSceneManagerState() {
    const sceneSnapshot = typeof getCurrentSceneSnapshot === "function"
        ? getCurrentSceneSnapshot()
        : null;
    const normalizedSceneKey = sceneSnapshot?.key ? normalizeMessageKey(sceneSnapshot.key) : null;
    if (!(state.perMessageStates instanceof Map)) {
        state.perMessageStates = new Map();
    }
    let messageKey = normalizedSceneKey;
    let messageState = messageKey ? state.perMessageStates.get(messageKey) || null : null;
    if (!messageState && state.perMessageStates.size > 0) {
        const lastEntry = Array.from(state.perMessageStates.entries()).pop();
        if (lastEntry) {
            [messageKey, messageState] = lastEntry;
        }
    }
    if (!messageState) {
        messageKey = normalizedSceneKey || `manual:${Date.now()}`;
        messageState = {
            sceneRoster: new Set(),
            rosterTurns: new Map(),
            defaultRosterTTL: null,
            removedRoster: new Set(),
        };
        state.perMessageStates.set(messageKey, messageState);
    } else {
        if (!(messageState.sceneRoster instanceof Set)) {
            messageState.sceneRoster = new Set(messageState.sceneRoster || []);
        }
        if (!(messageState.rosterTurns instanceof Map)) {
            messageState.rosterTurns = new Map(messageState.rosterTurns || []);
        }
        if (!(messageState.removedRoster instanceof Set)) {
            messageState.removedRoster = new Set(messageState.removedRoster || []);
        }
    }
    return { sceneSnapshot, messageState, messageKey };
}

function escapeHtml(str) {
    if (typeof document === "undefined" || typeof document.createElement !== "function") {
        const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
        return String(str ?? "").replace(/[&<>"']/g, (ch) => map[ch] || ch);
    }
    const p = document.createElement("p");
    p.textContent = str;
    return p.innerHTML;
}
function normalizeStreamText(s) { return s ? String(s).replace(/[\uFEFF\u200B\u200C\u200D]/g, "").replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"').replace(/(\*\*|__|~~|`{1,3})/g, "").replace(/\u00A0/g, " ") : ""; }
function escapeRegex(text) {
    return String(text ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function resolveMessageSpeakerName(message) {
    if (!message || typeof message !== "object") {
        return "";
    }
    if (message.is_user || isSystemOrNarratorMessage(message)) {
        return "";
    }
    const name = typeof message.name === "string" ? message.name.trim() : "";
    return name;
}
function shouldPrefixSpeaker(text, speaker) {
    if (!text || !speaker) {
        return false;
    }
    const trimmed = text.trimStart();
    if (!trimmed) {
        return false;
    }
    const escaped = escapeRegex(speaker);
    const prefixPattern = new RegExp(`^(?:[>\\]]\\s*)?${escaped}\\s*[:：\\-—]`, "i");
    if (prefixPattern.test(trimmed)) {
        return false;
    }
    const leadingNamePattern = new RegExp(`^${escaped}\\b`, "i");
    return !leadingNamePattern.test(trimmed);
}
function applySpeakerPrefix(text, speaker) {
    if (typeof text !== "string") {
        return "";
    }
    if (!speaker) {
        return text;
    }
    if (!shouldPrefixSpeaker(text, speaker)) {
        return text;
    }
    return `${speaker}: ${text}`;
}
function substituteParamsSafe(text) {
    const fn = typeof globalThis.substituteParams === "function" ? globalThis.substituteParams : null;
    return fn ? fn(text) : text;
}
function conditionDetectionInput(text, options = {}) {
    const normalized = normalizeStreamText(text);
    const substituted = substituteParamsSafe(normalized);
    const cleaned = substituted.replace(/[*"]/g, "");
    const sampleThreshold = Number.isFinite(options.sampleThreshold) && options.sampleThreshold > 0
        ? Math.floor(options.sampleThreshold)
        : 500;

    if (cleaned.length <= sampleThreshold) {
        return { text: cleaned.trim(), trimmedLeading: 0 };
    }

    const trimmedLeading = cleaned.length - sampleThreshold;
    return {
        text: cleaned.slice(-sampleThreshold).trim(),
        trimmedLeading,
    };
}
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

function normalizeCostumeFolder(folder) {
    if (folder == null) {
        return "";
    }
    const trimmed = String(folder).trim();
    if (!trimmed) {
        return "";
    }
    const sanitized = trimmed.replace(/[\\/]+$/, "");
    return sanitized;
}
function normalizeRosterKey(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.trim().toLowerCase();
}

function sanitizeRosterTurnValue(value) {
    if (!Number.isFinite(value)) {
        return null;
    }
    const rounded = Math.floor(value);
    if (!Number.isFinite(rounded)) {
        return null;
    }
    return Math.max(0, rounded);
}

function toRosterTurnEntries(turns) {
    if (!(turns instanceof Map)) {
        return [];
    }
    const entries = [];
    turns.forEach((value, key) => {
        const normalized = normalizeRosterKey(key);
        const turnsRemaining = sanitizeRosterTurnValue(value);
        if (!normalized || turnsRemaining == null) {
            return;
        }
        entries.push([normalized, turnsRemaining]);
    });
    return entries;
}

function fromRosterTurnEntries(entries) {
    const map = new Map();
    if (!Array.isArray(entries)) {
        return map;
    }
    entries.forEach((entry) => {
        if (!Array.isArray(entry) || entry.length < 2) {
            return;
        }
        const normalized = normalizeRosterKey(entry[0]);
        const turnsRemaining = sanitizeRosterTurnValue(entry[1]);
        if (!normalized || turnsRemaining == null) {
            return;
        }
        map.set(normalized, turnsRemaining);
    });
    return map;
}

function cloneRosterTurns(source) {
    if (!(source instanceof Map)) {
        return new Map();
    }
    return fromRosterTurnEntries(Array.from(source.entries()));
}
function toDisplayNameEntries(displayNames) {
    if (!(displayNames instanceof Map)) {
        return [];
    }
    return Array.from(displayNames.entries()).filter(([key]) => typeof key === "string" && key.trim().length);
}
function fromDisplayNameEntries(entries) {
    if (!Array.isArray(entries)) {
        return new Map();
    }
    const map = new Map();
    entries.forEach(([key, value]) => {
        const normalized = normalizeRosterKey(key);
        if (!normalized) {
            return;
        }
        map.set(normalized, typeof value === "string" && value.trim() ? value.trim() : key);
    });
    return map;
}
function toStatsEntries(stats) {
    if (!(stats instanceof Map)) {
        return [];
    }
    return Array.from(stats.entries()).filter(([key]) => typeof key === "string" && key.trim().length);
}
function fromStatsEntries(entries) {
    if (!Array.isArray(entries)) {
        return new Map();
    }
    return new Map(entries.filter(([key]) => typeof key === "string" && key.trim().length));
}
function cloneDecisionEvent(event) {
    if (!event || typeof event !== "object") {
        return null;
    }
    return {
        ...event,
        outfit: event.outfit ? { ...event.outfit } : null,
    };
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

function buildFocusLockSkipEvent(name) {
    const displayName = String(name ?? "").trim() || "(focus lock)";
    return {
        type: "skipped",
        name: displayName,
        matchKind: "focus-lock",
        reason: "focus-lock",
        charIndex: null,
        outfit: null,
    };
}

function notifyFocusLockActive(name) {
    const trimmedName = String(name ?? "").trim();
    const normalized = trimmedName.toLowerCase();
    const previous = state.focusLockNotice || createFocusLockNotice();
    const event = buildFocusLockSkipEvent(trimmedName);
    const now = Date.now();
    const shouldAnnounce = !previous.character
        || previous.character !== normalized
        || (now - (previous.at || 0) > FOCUS_LOCK_NOTICE_INTERVAL);

    if (shouldAnnounce) {
        const debugParts = ["Focus lock active; skipping stream processing."];
        if (trimmedName) {
            debugParts.push(`Locked to ${trimmedName}.`);
        }
        debugLog(...debugParts);

        const message = trimmedName
            ? `Focus lock active for <b>${escapeHtml(trimmedName)}</b>. Detection paused.`
            : "Focus lock active. Detection paused.";

        try {
            showStatus(message, "info", 2500);
        } catch (err) {
            // Ignore DOM rendering errors in non-browser environments.
        }

        state.focusLockNotice = {
            at: now,
            character: normalized || null,
            displayName: event.name,
            message,
            event,
        };
    } else {
        state.focusLockNotice = {
            ...previous,
            character: normalized || null,
            displayName: event.name,
            event,
        };
    }

    return event;
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

        state.compiledRegexes = { ...compiled.regexes, effectivePatterns: compiled.effectivePatterns };
        rebuildMappingLookup(profile);

        if (!Array.isArray(compiled.effectivePatterns) || compiled.effectivePatterns.length === 0) {
            const message = NO_EFFECTIVE_PATTERNS_MESSAGE;
            $("#cs-error").prop("hidden", false).find(".cs-status-text").text(message);
            showStatus(message, "error", 5000);
        } else {
            $("#cs-error").prop("hidden", true).find(".cs-status-text").text("");
        }
    } catch (e) {
        $("#cs-error").prop("hidden", false).find(".cs-status-text").text(`Pattern compile error: ${String(e)}`);
        showStatus(`Pattern compile error: ${String(e)}`, "error", 5000);
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
            const folder = normalizeCostumeFolder(entry.defaultFolder ?? entry.folder ?? "");
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

    const rawKey = typeof options?.bufKey === "string" ? options.bufKey : state.currentGenerationKey;
    const bufKey = rawKey ? (normalizeMessageKey(rawKey) || rawKey) : rawKey;
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
    const rawInput = typeof options?.rawName === "string" && options.rawName.trim()
        ? options.rawName.trim()
        : rawName;
    const baseTranslate = Boolean(options?.translateNames ?? profile?.translateNames ?? false);
    const candidates = Array.isArray(profile?.mappings)
        ? profile.mappings.map(entry => entry?.name).filter(Boolean)
        : [];
    const basePreprocessor = createNamePreprocessor({
        candidates,
        translate: baseTranslate,
    });
    let resolution = options?.nameResolution || null;
    if (!resolution) {
        resolution = basePreprocessor(rawName, { priority: options?.priority ?? null });
    }
    let canonicalName = resolution?.canonical || rawName;
    let normalizedName = normalizeCostumeName(canonicalName);
    const now = Number.isFinite(options?.now) ? options.now : Date.now();

    if (!normalizedName || !profile) {
        const fallbackFolder = normalizeCostumeFolder(options?.fallbackFolder ?? normalizedName ?? "");
        return {
            folder: fallbackFolder,
            reason: profile ? "no-name" : "no-profile",
            normalizedName,
            rawName: rawInput,
            canonicalName,
            nameResolution: resolution,
            resolvedAt: now,
            variant: null,
            trigger: null,
            awareness: { ok: true, reason: "no-awareness", reasons: [] },
            label: null,
        };
    }

    let mapping = findMappingForName(profile, normalizedName);
    if (mapping && mapping.translateNames != null) {
        const overrideTranslate = Boolean(mapping.translateNames);
        const overridePreprocessor = createNamePreprocessor({
            candidates,
            translate: overrideTranslate,
        });
        const remapped = overridePreprocessor(rawName, { priority: options?.priority ?? null });
        if (remapped && remapped.canonical) {
            canonicalName = remapped.canonical;
            normalizedName = normalizeCostumeName(canonicalName);
            resolution = {
                ...remapped,
                translateNames: overrideTranslate,
            };
            const remappedEntry = findMappingForName(profile, normalizedName);
            if (remappedEntry) {
                mapping = remappedEntry;
            }
        }
    }
    const defaultFolder = normalizeCostumeFolder(options?.fallbackFolder || mapping?.defaultFolder || mapping?.folder || normalizedName) || normalizedName;
    const baseResult = {
        folder: defaultFolder || normalizedName,
        reason: "default-folder",
        normalizedName,
        rawName: rawInput,
        canonicalName,
        mapping,
        variant: null,
        trigger: null,
        awareness: { ok: true, reason: "no-awareness", reasons: [] },
        label: null,
        resolvedAt: now,
        nameResolution: resolution,
    };

    if (!profile.enableOutfits || !mapping || !Array.isArray(mapping.outfits) || mapping.outfits.length === 0) {
        return baseResult;
    }

    const context = buildOutfitMatchContext(options, normalizedName, profile);
    const matchKind = typeof context.matchKind === "string" ? context.matchKind.trim().toLowerCase() : (typeof options?.matchKind === "string" ? options.matchKind.trim().toLowerCase() : "");

    const matches = [];
    mapping.outfits.forEach((variant, index) => {
        if (!variant) {
            return;
        }
        const folder = normalizeCostumeFolder(variant.folder);
        if (!folder) {
            return;
        }

        const rawKinds = variant.matchKinds ?? variant.matchKind ?? variant.kinds ?? variant.kind ?? null;
        const allowedKinds = Array.isArray(rawKinds) ? rawKinds : (rawKinds ? [rawKinds] : []);
        const loweredKinds = allowedKinds
            .map(value => String(value ?? "").trim().toLowerCase())
            .filter(Boolean);
        if (loweredKinds.length) {
            if (!matchKind || !loweredKinds.includes(matchKind)) {
                return;
            }
        }

        const triggerResult = evaluateOutfitTriggers(variant, context);
        if (!triggerResult.matched) {
            const hasTriggers = Array.isArray(variant.triggers) && variant.triggers.length > 0;
            if (hasTriggers) {
                return;
            }
        }

        const awarenessResult = evaluateAwarenessPredicates(variant.awareness, context);
        if (!awarenessResult.ok) {
            return;
        }

        const label = typeof variant.label === "string" && variant.label.trim()
            ? variant.label.trim()
            : (typeof variant.slot === "string" && variant.slot.trim() ? variant.slot.trim() : null);

        const triggerCount = Array.isArray(variant.triggers) ? variant.triggers.length : 0;
        const triggerWeight = triggerResult.matched && triggerCount > 0 ? Math.max(triggerCount, 1) : 0;

        const awarenessConfig = variant.awareness && typeof variant.awareness === "object" ? variant.awareness : {};
        const awarenessWeight = [
            Array.isArray(awarenessConfig.requires) ? awarenessConfig.requires.length : 0,
            Array.isArray(awarenessConfig.requiresAny) ? awarenessConfig.requiresAny.length : 0,
            Array.isArray(awarenessConfig.excludes) ? awarenessConfig.excludes.length : 0,
        ].reduce((total, value) => total + value, 0);

        const priorityValue = Number(variant.priority);
        const priority = Number.isFinite(priorityValue) ? priorityValue : 0;

        const result = {
            folder,
            reason: triggerResult.matched ? "trigger-match" : (awarenessResult.reason !== "no-awareness" ? "awareness-match" : "variant-default"),
            normalizedName,
            rawName: rawInput,
            canonicalName,
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
            nameResolution: resolution,
        };

        matches.push({
            priority,
            triggerWeight,
            awarenessWeight,
            matchKindWeight: loweredKinds.length,
            index,
            result,
        });
    });

    if (!matches.length) {
        return baseResult;
    }

    matches.sort((a, b) => {
        if (b.priority !== a.priority) {
            return b.priority - a.priority;
        }
        if (b.triggerWeight !== a.triggerWeight) {
            return b.triggerWeight - a.triggerWeight;
        }
        if (b.awarenessWeight !== a.awarenessWeight) {
            return b.awarenessWeight - a.awarenessWeight;
        }
        if (b.matchKindWeight !== a.matchKindWeight) {
            return b.matchKindWeight - a.matchKindWeight;
        }
        return a.index - b.index;
    });

    return matches[0].result;
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

    const rawKey = typeof opts?.bufKey === "string" ? opts.bufKey : state.currentGenerationKey;
    const bufKey = rawKey ? (normalizeMessageKey(rawKey) || rawKey) : rawKey;
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

    const suppliedRaw = typeof opts.rawName === "string" ? opts.rawName.trim() : "";
    decision.rawName = suppliedRaw || rawName;
    decision.nameResolution = opts.nameResolution || null;
    decision.name = normalizeCostumeName(rawName);
    const normalizedKey = decision.name.toLowerCase();

    const lookupKey = normalizedKey;
    const mapped = state.mappingLookup instanceof Map ? state.mappingLookup.get(lookupKey) : null;
    let mappedFolder = String(mapped ?? decision.name).trim();
    mappedFolder = normalizeCostumeFolder(mappedFolder) || decision.name;
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
            rawName: decision.rawName,
            nameResolution: decision.nameResolution,
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
        // FIX #8: Only return 'outfit-unchanged' if the character matches the current active character.
        // Otherwise, if we are switching characters (e.g. Miku -> Nia) and Nia is already wearing default,
        // we MUST still switch to bring Nia to screen.
        if (cachedFolder && normalizedMapped &&
            cachedFolder.toLowerCase() === normalizedMapped.toLowerCase() &&
            currentName.toLowerCase() === decision.name.toLowerCase()
        ) {
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
    const charIndex = Number.isFinite(opts?.messageState?.lastAcceptedIndex)
        ? opts.messageState.lastAcceptedIndex
        : Number.isFinite(opts?.match?.matchIndex)
            ? opts.match.matchIndex
            : null;

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

        if (!shouldLogMatchEvent(opts.matchKind || null, decision.reason)) {
            return;
        }

        recordDecisionEvent({
            type: 'skipped',
            name: decision.name || name,
            matchKind: opts.matchKind || null,
            reason: decision.reason || 'unknown',
            charIndex,
            timestamp: decision.now,
            outfit: decision.outfit ? {
                folder: decision.outfit.folder,
                label: decision.outfit.label || null,
                reason: decision.outfit.reason || null,
                trigger: decision.outfit.trigger || null,
                awareness: decision.outfit.awareness || null,
            } : null,
        });
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

    const chatLog = resolveChatLog();
    const latestAssistant = Array.isArray(chatLog) ? findAssistantMessageBeforeIndex(chatLog.length - 1, chatLog) : null;
    const latestName = typeof latestAssistant?.name === "string" ? latestAssistant.name.trim() : "";
    const fallbackName = typeof decision?.name === "string" ? decision.name.trim() : "";
    const targetName = latestName || fallbackName;
    const rawFolder = typeof decision.folder === "string" ? decision.folder.trim() : "";
    const hasLeadingSlash = /^[\\/]/.test(rawFolder);
    const sanitizedFolder = rawFolder.replace(/^[\\/]+/, "");
    const normalizedCandidates = [targetName, fallbackName]
        .map(candidate => {
            if (!candidate) {
                return "";
            }
            const normalized = normalizeCostumeName(candidate) || candidate;
            return normalized.trim().toLowerCase();
        })
        .filter(Boolean);
    const folderSegments = sanitizedFolder.split(/[\\/]+/).filter(Boolean);
    const hasCharacterPrefix = folderSegments.some((segment) => {
        const normalizedSegment = normalizeCostumeName(segment) || segment;
        const loweredSegment = normalizedSegment.trim().toLowerCase();
        return normalizedCandidates.includes(loweredSegment);
    });
    const useFullPath = !hasLeadingSlash && hasCharacterPrefix;
    const escapedName = targetName ? targetName.replace(/"/g, '\\"') : "";
    const command = useFullPath
        ? `/costume ${sanitizedFolder}`
        : `/costume${escapedName ? ` name="${escapedName}"` : ""} \\${sanitizedFolder}`;
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
        recordDecisionEvent({
            type: 'switch',
            name: decision.name,
            folder: decision.folder,
            matchKind: opts.matchKind || null,
            charIndex,
            timestamp: decision.now,
            outfit: decision.outfit ? {
                folder: decision.outfit.folder,
                label: decision.outfit.label || null,
                reason: decision.outfit.reason || null,
                trigger: decision.outfit.trigger || null,
                awareness: decision.outfit.awareness || null,
            } : null,
        });
        showStatus(`Switched -> <b>${escapeHtml(decision.folder)}</b>`, 'success');
    } catch (err) {
        state.failedTriggerTimes.set(decision.folder, decision.now);
        recordDecisionEvent({
            type: 'skipped',
            name: decision.name,
            matchKind: opts.matchKind || null,
            reason: 'failed-trigger',
            charIndex,
            timestamp: decision.now,
            outfit: decision.outfit ? {
                folder: decision.outfit.folder,
                label: decision.outfit.label || null,
                reason: decision.outfit.reason || null,
                trigger: decision.outfit.trigger || null,
                awareness: decision.outfit.awareness || null,
            } : null,
        });
        showStatus(`Failed to switch to costume "<b>${escapeHtml(decision.folder)}</b>". Check console (F12).`, 'error');
        console.error(`${logPrefix} Failed to execute /costume command for "${decision.folder}".`, err);
    }
}

// ======================================================================
// UI MANAGEMENT
// ======================================================================
const uiMapping = {
    patterns: { selector: '#cs-patterns', type: 'patternEditor' },
    ignorePatterns: { selector: '#cs-ignore-patterns', type: 'textarea' },
    vetoPatterns: { selector: '#cs-veto-patterns', type: 'textarea' },
    defaultCostume: { selector: '#cs-default', type: 'text' },
    debug: { selector: '#cs-debug', type: 'checkbox' },
    globalCooldownMs: { selector: '#cs-global-cooldown', type: 'number' },
    repeatSuppressMs: { selector: '#cs-repeat-suppress', type: 'number' },
    perTriggerCooldownMs: { selector: '#cs-per-trigger-cooldown', type: 'number' },
    failedTriggerCooldownMs: { selector: '#cs-failed-trigger-cooldown', type: 'number' },
    maxBufferChars: { selector: '#cs-max-buffer-chars', type: 'number' },
    detectionBias: { selector: '#cs-detection-bias', type: 'range' },
    detectAttribution: { selector: '#cs-detect-attribution', type: 'checkbox' },
    detectAction: { selector: '#cs-detect-action', type: 'checkbox' },
    scanDialogueActions: { selector: '#cs-scan-dialogue-actions', type: 'checkbox' },
    detectVocative: { selector: '#cs-detect-vocative', type: 'checkbox' },
    detectPossessive: { selector: '#cs-detect-possessive', type: 'checkbox' },
    detectPronoun: { selector: '#cs-detect-pronoun', type: 'checkbox' },
    detectGeneral: { selector: '#cs-detect-general', type: 'checkbox' },
    scanLowercaseFallbackTokens: { selector: '#cs-scan-lowercase-fallback', type: 'checkbox' },
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

function readScriptCollectionSelectionsFromUI() {
    const selections = [];
    SCRIPT_COLLECTION_KEYS.forEach((key) => {
        const checkbox = document.querySelector(`[data-script-collection="${key}"]`);
        if (checkbox && checkbox.checked) {
            selections.push(key);
        }
    });
    return selections;
}

function syncScriptCollectionControls(selected) {
    const normalized = normalizeScriptCollections(selected, PROFILE_DEFAULTS.scriptCollections);
    SCRIPT_COLLECTION_KEYS.forEach((key) => {
        const checkbox = document.querySelector(`[data-script-collection="${key}"]`);
        if (!checkbox) {
            return;
        }
        checkbox.checked = normalized.includes(key);
    });
}

function refreshProfilePreprocessorPipeline(profile = getActiveProfile()) {
    if (!profile) {
        return [];
    }
    const normalizedSelections = normalizeScriptCollections(profile.scriptCollections, PROFILE_DEFAULTS.scriptCollections);
    profile.scriptCollections = normalizedSelections;
    const pipeline = collectProfilePreprocessorScripts(profile);
    if (!state.compiledRegexes || typeof state.compiledRegexes !== 'object') {
        state.compiledRegexes = {};
    }
    state.compiledRegexes.preprocessorScripts = pipeline;
    return pipeline;
}

function updateScenePanelSettingControls(panelSettings = ensureScenePanelSettings(getSettings?.() || {})) {
    const settings = panelSettings || ensureScenePanelSettings(getSettings?.() || {});
    const sections = settings?.sections || {};
    $("#cs-scene-panel-enable").prop('checked', !!(settings && settings.enabled));
    $("#cs-scene-auto-open").prop('checked', !!(settings && settings.autoOpenOnStream));
    $("#cs-scene-auto-open-results").prop('checked', !!(settings && settings.autoOpenOnResults));
    $("#cs-scene-auto-pin").prop('checked', settings.autoPinActive !== false);
    $("#cs-scene-show-avatars").prop('checked', !!(settings && settings.showRosterAvatars));
    $("#cs-scene-section-roster").prop('checked', sections.roster !== false);
    $("#cs-scene-section-active").prop('checked', sections.activeCharacters !== false);
    $("#cs-scene-section-log").prop('checked', sections.liveLog !== false);
    $("#cs-scene-section-coverage").prop('checked', sections.coverage !== false);
}

function applyScenePanelEnabledSetting(enabled, { message } = {}) {
    const settings = getSettings();
    const panelSettings = ensureScenePanelSettings(settings);
    panelSettings.enabled = Boolean(enabled);
    updateScenePanelSettingControls(panelSettings);
    requestScenePanelRender("panel-enabled", { immediate: true });
    const fallbackMessage = panelSettings.enabled
        ? "Scene panel enabled."
        : "Scene panel hidden.";
    persistSettings(message || fallbackMessage, "info");
}

function applyScenePanelSectionSetting(sectionKey, visible, { message } = {}) {
    if (!sectionKey) {
        return;
    }
    const settings = getSettings();
    const panelSettings = ensureScenePanelSettings(settings);
    if (typeof panelSettings.sections !== "object" || panelSettings.sections === null) {
        panelSettings.sections = { ...DEFAULT_SCENE_PANEL_SECTIONS };
    }
    panelSettings.sections[sectionKey] = Boolean(visible);
    updateScenePanelSettingControls(panelSettings);
    requestScenePanelRender(`section-${sectionKey}`, { immediate: true });
    const label = SCENE_PANEL_SECTION_LABELS[sectionKey] || sectionKey;
    const fallbackMessage = panelSettings.sections[sectionKey]
        ? `${label} section enabled.`
        : `${label} section hidden.`;
    persistSettings(message || fallbackMessage, "info");
}

function applyScenePanelAutoOpenOnStreamSetting(enabled, { message } = {}) {
    const settings = getSettings();
    const panelSettings = ensureScenePanelSettings(settings);
    panelSettings.autoOpenOnStream = Boolean(enabled);
    updateScenePanelSettingControls(panelSettings);
    requestScenePanelRender("auto-open-stream", { immediate: true });
    const fallbackMessage = panelSettings.autoOpenOnStream
        ? "Scene panel auto-open enabled."
        : "Scene panel auto-open disabled.";
    persistSettings(message || fallbackMessage, "info");
}

function applyScenePanelAutoPinSetting(enabled, { message } = {}) {
    const settings = getSettings();
    const panelSettings = ensureScenePanelSettings(settings);
    panelSettings.autoPinActive = Boolean(enabled);
    updateScenePanelSettingControls(panelSettings);
    requestScenePanelRender("auto-pin", { immediate: true });
    const fallbackMessage = panelSettings.autoPinActive
        ? "Auto-pin highlight enabled."
        : "Auto-pin highlight disabled.";
    persistSettings(message || fallbackMessage, "info");
}

function applyScenePanelShowAvatarsSetting(showAvatars, { message } = {}) {
    const settings = getSettings();
    const panelSettings = ensureScenePanelSettings(settings);
    panelSettings.showRosterAvatars = Boolean(showAvatars);
    updateScenePanelSettingControls(panelSettings);
    requestScenePanelRender("avatar-toggle", { immediate: true });
    const fallbackMessage = panelSettings.showRosterAvatars
        ? "Roster avatars enabled."
        : "Roster avatars hidden.";
    persistSettings(message || fallbackMessage, "info");
}

function applyScenePanelAutoOpenResultsSetting(enabled, { message } = {}) {
    const settings = getSettings();
    const panelSettings = ensureScenePanelSettings(settings);
    panelSettings.autoOpenOnResults = Boolean(enabled);
    updateScenePanelSettingControls(panelSettings);
    requestScenePanelRender("auto-open-results", { immediate: true });
    const fallbackMessage = panelSettings.autoOpenOnResults
        ? "Scene panel will auto-open on new results."
        : "Scene panel will stay collapsed after new results.";
    persistSettings(message || fallbackMessage, "info");
}

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
    const patternNames = collectProfilePatternList(profile);
    patternNames.forEach(name => {
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
    const getValue = (key) => getProfileValueForUI(profile, key);
    if (!profile || !Array.isArray(fields)) return;
    fields.forEach((key) => {
        const mapping = uiMapping[key];
        if (!mapping) return;
        const field = $(mapping.selector);
        if (!field.length) return;
        const value = getValue(key);
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
            case 'patternEditor':
                renderPatternEditor(profile);
                break;
            case 'optionalNumber':
                field.val(value ?? '');
                break;
            default:
                field.val(value ?? '');
                break;
        }
    });
}

function getProfileValueForUI(profile, key) {
    if (!profile || typeof profile !== 'object') {
        return PROFILE_DEFAULTS[key];
    }
    return profile[key];
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
    state.patternSearchQuery = "";
    const searchField = $("#cs-pattern-search");
    if (searchField.length) {
        searchField.val("");
    }
    $("#cs-profile-name").val('').attr('placeholder', `Enter a name... (current: ${profileName})`);
    $("#cs-enable").prop('checked', !!settings.enabled);
    const scenePanelSettings = ensureScenePanelSettings(settings);
    updateScenePanelSettingControls(scenePanelSettings);
    for (const key in uiMapping) {
        const { selector, type } = uiMapping[key];
        const value = getProfileValueForUI(profile, key);
        switch (type) {
            case 'checkbox': $(selector).prop('checked', !!value); break;
            case 'textarea': $(selector).val((value || []).join('\n')); break;
            case 'csvTextarea': $(selector).val((value || []).join(', ')); break;
            case 'patternEditor': renderPatternEditor(profile); break;
            case 'optionalNumber': $(selector).val(value ?? ''); break;
            default: $(selector).val(value); break;
        }
    }
    syncScriptCollectionControls(profile.scriptCollections);
    $("#cs-detection-bias-value").text(profile.detectionBias || 0);
    renderMappings(profile);
    recompileRegexes();
    updateFocusLockUI();
    populateScorePresetDropdown(getSettings()?.activeScorePreset || state.activeScorePresetKey);
    refreshCoverageFromLastReport();
}

function saveCurrentProfileData() {
    const profileData = {};
    const activeProfile = getActiveProfile();
    syncOutfitLabMappingsFromUI(activeProfile);
    for (const key in uiMapping) {
        const { selector, type } = uiMapping[key];
        if (type === 'patternEditor') {
            continue;
        }
        const field = $(selector);
        if (!field.length) {
            const fallback = PROFILE_DEFAULTS[key];
            if (type === 'optionalNumber') {
                profileData[key] = fallback ?? null;
            } else if (type === 'textarea' || type === 'csvTextarea') {
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
            case 'optionalNumber': {
                const raw = String(field.val() ?? '').trim();
                if (!raw) {
                    value = PROFILE_DEFAULTS[key] ?? null;
                    break;
                }
                const parsed = Number(raw);
                value = Number.isFinite(parsed) ? parsed : (PROFILE_DEFAULTS[key] ?? null);
                break;
            }
            default:
                value = String(field.val() ?? '').trim();
                break;
        }
        profileData[key] = value;
    }
    const scriptSelections = readScriptCollectionSelectionsFromUI();
    profileData.scriptCollections = normalizeScriptCollections(scriptSelections, PROFILE_DEFAULTS.scriptCollections);
    const slotSource = Array.isArray(activeProfile?.patternSlots) ? activeProfile.patternSlots : [];
    const draftPatternIds = state?.draftPatternIds instanceof Set ? state.draftPatternIds : new Set();
    const preparedSlots = preparePatternSlotsForSave(slotSource, draftPatternIds);
    profileData.patternSlots = preparedSlots;
    profileData.patterns = flattenPatternSlots(preparedSlots);
    const mappingSource = Array.isArray(activeProfile?.mappings) ? activeProfile.mappings : [];
    const draftIds = state?.draftMappingIds instanceof Set ? state.draftMappingIds : new Set();
    profileData.mappings = prepareMappingsForSave(mappingSource, draftIds);
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
    if (Array.isArray(normalized.patternSlots)) {
        const existingSlots = Array.isArray(profile.patternSlots) ? profile.patternSlots : [];
        normalized.patternSlots = reconcilePatternSlotReferences(existingSlots, normalized.patternSlots);
    }
    Object.assign(profile, normalized);
    profile.mappings = mappings;
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

function handleScriptCollectionCheckboxChange(event) {
    const profile = getActiveProfile();
    const selections = readScriptCollectionSelectionsFromUI();
    const normalizedSelections = normalizeScriptCollections(selections, PROFILE_DEFAULTS.scriptCollections);
    if (profile) {
        profile.scriptCollections = normalizedSelections;
    }
    const pipeline = refreshProfilePreprocessorPipeline(profile);
    refreshTesterPreprocessorPreview(pipeline);
    scheduleProfileAutoSave({
        key: 'scriptCollections',
        element: event?.currentTarget,
        requiresRecompile: true,
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

function parseOutfitListInput(value) {
    return String(value ?? "")
        .split(/\r?\n|,/)
        .map((entry) => entry.trim())
        .filter(Boolean);
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

    const prioritySource = normalized.priority ?? normalized.order ?? normalized.weight ?? 0;
    const priority = Number(prioritySource);
    normalized.priority = Number.isFinite(priority) ? priority : 0;
    delete normalized.order;
    delete normalized.weight;

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

function buildVariantFolderPath(mappingOrName, folderPath) {
    const rawFolder = (folderPath || "").trim();
    if (!rawFolder) {
        return "";
    }
    let normalizedFolder = rawFolder.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (!normalizedFolder) {
        return "";
    }
    const mapping = mappingOrName && typeof mappingOrName === "object" ? mappingOrName : null;
    const candidates = [];
    if (mapping) {
        const defaultFolder = typeof mapping.defaultFolder === "string" ? mapping.defaultFolder.trim() : "";
        const name = typeof mapping.name === "string" ? mapping.name.trim() : "";
        if (defaultFolder) {
            candidates.push(defaultFolder);
        }
        if (name) {
            candidates.push(name);
        }
    } else {
        const rawName = typeof mappingOrName === "string" ? mappingOrName.trim() : "";
        if (rawName) {
            candidates.push(rawName);
        }
    }

    const normalizedCandidates = candidates
        .map((candidate) => candidate.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, ""))
        .filter(Boolean)
        .map((normalized) => ({
            original: normalized,
            lower: normalized.toLowerCase(),
        }));

    const folderLower = normalizedFolder.toLowerCase();
    for (const candidate of normalizedCandidates) {
        if (folderLower === candidate.lower || folderLower.startsWith(`${candidate.lower}/`)) {
            return normalizedFolder;
        }
    }

    if (normalizedCandidates.length) {
        return `${normalizedCandidates[0].original}/${normalizedFolder}`;
    }

    return normalizedFolder;
}

function createPatternSlotCard(profile, slot, index) {
    const normalized = profile?.patternSlots?.[index] === slot
        ? slot
        : normalizePatternSlot(slot);

    if (profile && Array.isArray(profile.patternSlots)) {
        profile.patternSlots[index] = normalized;
    }

    ensurePatternSlotId(normalized);
    const slotId = normalized.__slotId || ensurePatternSlotId(normalized);

    const card = $('<article>')
        .addClass('cs-pattern-card')
        .attr('data-idx', index)
        .data('slot', normalized);

    const header = $('<div>').addClass('cs-pattern-card-header');
    const title = $('<div>').addClass('cs-pattern-card-title');
    title.append($('<i>').addClass('fa-solid fa-user')); // Icon for visual cue
    const titleText = $('<div>').addClass('cs-pattern-card-title-text');
    const heading = $('<h4>');
    const summary = $('<small>').addClass('cs-pattern-card-summary');
    const folderSummary = $('<small>').addClass('cs-pattern-card-folder');
    titleText.append(heading, summary, folderSummary);
    title.append(titleText);
    header.append(title);

    const removeButton = $('<button>', {
        type: 'button',
        class: 'menu_button interactable cs-button-danger cs-pattern-remove-slot',
    })
        .attr('data-change-notice', 'Removing this character slot auto-saves your patterns.')
        .attr('data-change-notice-key', `${slotId}-remove`)
        .append($('<i>').addClass('fa-solid fa-trash-can'), $('<span>').text('Remove Slot'))
        .on('click', () => {
            if (!profile || !Array.isArray(profile.patternSlots)) {
                return;
            }
            const buttonEl = removeButton[0];
            const id = ensurePatternSlotId(normalized);
            if (id && state?.draftPatternIds instanceof Set) {
                state.draftPatternIds.delete(id);
            }
            profile.patternSlots.splice(index, 1);
            updateProfilePatternCache(profile);
            renderPatternEditor(profile);
            scheduleProfileAutoSave({
                reason: 'character patterns',
                element: buttonEl,
                requiresRecompile: true,
                requiresFocusLockRefresh: true,
                noticeKey: `${slotId}-remove`,
            });
        });
    header.append(removeButton);
    card.append(header);

    const body = $('<div>').addClass('cs-pattern-card-body');
    card.append(body);

    const nameId = `cs-pattern-name-${slotId}`;
    const nameField = $('<div>').addClass('cs-field')
        .append($('<label>', { for: nameId, text: 'Character Name' }));
    const nameInput = $('<input>', {
        id: nameId,
        type: 'text',
        class: 'text_pole cs-pattern-name',
        placeholder: 'Primary name used in chat…',
    }).val(normalized.name || '');
    nameField.append(nameInput);
    body.append(nameField);

    const aliasesId = `cs-pattern-aliases-${slotId}`;
    const aliasField = $('<div>').addClass('cs-field')
        .append($('<label>', { for: aliasesId, text: 'Alternate Patterns' }));
    const aliasTextarea = $('<textarea>', {
        id: aliasesId,
        rows: 3,
        class: 'text_pole cs-pattern-aliases',
        placeholder: 'Nickname\nCodename\n/Regex Pattern/',
    }).val(Array.isArray(normalized.aliases) ? normalized.aliases.join('\n') : '');
    aliasField.append(aliasTextarea);
    aliasField.append($('<small>').text('One entry per line. Supports literal names or /regex/.'));
    body.append(aliasField);

    const folderId = `cs-pattern-folder-${slotId}`;
    const folderField = $('<div>').addClass('cs-field')
        .append($('<label>', { for: folderId, text: 'Default Folder' }));
    const folderRow = $('<div>').addClass('cs-pattern-folder-row');
    const folderInput = $('<input>', {
        id: folderId,
        type: 'text',
        class: 'text_pole cs-pattern-folder',
        placeholder: 'Enter folder path…',
    }).val(normalized.folder || '');
    const folderPicker = $('<input>', { type: 'file', hidden: true });
    folderPicker.attr({ webkitdirectory: 'true', directory: 'true', multiple: 'true' });
    const folderButton = $('<button>', {
        type: 'button',
        class: 'menu_button interactable cs-pattern-pick-folder',
    })
        .append($('<i>').addClass('fa-solid fa-folder-open'), $('<span>').text('Pick Folder'))
        .on('click', () => folderPicker.trigger('click'));
    folderPicker.on('change', function () {
        const folderPath = extractDirectoryFromFileList(this.files || []);
        if (folderPath) {
            folderInput.val(folderPath);
            folderInput.trigger('input');
        }
        $(this).val('');
    });
    folderRow.append(folderInput, folderButton, folderPicker);
    folderField.append(folderRow);
    folderField.append($('<small>').text('Optional path override when this slot is detected.'));
    body.append(folderField);

    const updateHeader = () => {
        const patterns = gatherSlotPatternList(normalized);
        const seen = new Set();
        const unique = patterns.filter((entry) => {
            if (seen.has(entry)) {
                return false;
            }
            seen.add(entry);
            return true;
        });
        const displayName = String(normalized.name ?? '').trim();
        if (displayName) {
            heading.text(displayName);
        } else {
            heading.text(`Character Slot ${index + 1}`);
        }
        if (unique.length) {
            summary.text(`Patterns: ${unique.join(', ')}`);
        } else {
            summary.text('Patterns: (none)');
        }
        const folderValue = String(normalized.folder ?? '').trim();
        if (folderValue) {
            folderSummary.text(`Folder: ${folderValue}`);
        } else {
            folderSummary.text('Folder: (inherit mapping or default)');
        }
    };

    const commitAliasInput = (value) => {
        const entries = String(value ?? '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        const unique = Array.from(new Set(entries));
        normalized.aliases = unique;
        updateProfilePatternCache(profile);
        updateHeader();
    };

    nameInput.on('input', (event) => {
        normalized.name = event.target.value;
        updateProfilePatternCache(profile);
        updateHeader();
        scheduleProfileAutoSave({
            key: 'patterns',
            element: event.currentTarget,
            requiresRecompile: true,
            requiresFocusLockRefresh: true,
        });
    });

    aliasTextarea.on('input', (event) => {
        commitAliasInput(event.target.value);
        scheduleProfileAutoSave({
            key: 'patterns',
            element: event.currentTarget,
            requiresRecompile: true,
            requiresFocusLockRefresh: true,
        });
    });

    folderInput.on('input', (event) => {
        normalized.folder = event.target.value.trim();
        updateHeader();
        scheduleProfileAutoSave({
            reason: 'character patterns',
            element: event.currentTarget,
        });
    });

    updateHeader();
    return card;
}

function renderPatternEditor(profile) {
    const editor = $('#cs-patterns');
    if (!editor.length) {
        return;
    }

    editor.attr('aria-busy', 'true');
    const list = editor.find('#cs-pattern-slot-list');
    const addButton = editor.find('#cs-pattern-add-slot');
    const searchInput = $("#cs-pattern-search");
    const searchQuery = typeof state.patternSearchQuery === "string" ? state.patternSearchQuery : "";
    if (searchInput.length && searchInput.val() !== searchQuery) {
        searchInput.val(searchQuery);
    }
    const filterQuery = searchQuery.trim().toLowerCase();

    const isEditable = profile && typeof profile === 'object';
    const workingProfile = isEditable && profile ? profile : { patternSlots: [] };

    const slots = Array.isArray(workingProfile.patternSlots)
        ? workingProfile.patternSlots.map((slot, index) => {
            const normalized = normalizePatternSlot(slot);
            ensurePatternSlotId(normalized);
            if (isEditable && Array.isArray(profile.patternSlots)) {
                profile.patternSlots[index] = normalized;
            }
            return normalized;
        })
        : [];

    if (isEditable && Array.isArray(profile.patternSlots)) {
        profile.patternSlots = slots;
    } else {
        workingProfile.patternSlots = slots;
    }

    updateProfilePatternCache(isEditable ? profile : workingProfile);

    list.empty();
    const slotEntries = slots.map((slot, idx) => ({ slot, idx }));
    const visibleSlots = filterQuery
        ? slotEntries.filter(({ slot }) => doesPatternSlotMatchQuery(slot, filterQuery))
        : slotEntries;

    if (visibleSlots.length === 0) {
        const emptyText = filterQuery
            ? "No character slots match your search."
            : list.data('emptyText') || list.attr('data-empty-text') || "No characters configured yet.";
        list.append($('<div>').addClass('cs-pattern-empty').text(emptyText));
    } else {
        visibleSlots.forEach(({ slot, idx }) => {
            list.append(createPatternSlotCard(profile, slot, idx));
        });
    }

    addButton.prop('disabled', !isEditable);
    addButton.off('click').on('click', () => {
        if (!isEditable || !profile || !Array.isArray(profile.patternSlots)) {
            return;
        }
        const buttonEl = addButton[0];
        const newSlot = normalizePatternSlot({ name: '', aliases: [] });
        ensurePatternSlotId(newSlot);
        profile.patternSlots.push(newSlot);
        if (state?.draftPatternIds instanceof Set && newSlot.__slotId) {
            state.draftPatternIds.add(newSlot.__slotId);
        }
        updateProfilePatternCache(profile);
        renderPatternEditor(profile);
        const newCard = $('#cs-pattern-slot-list .cs-pattern-card').last();
        const nameInput = newCard.find('.cs-pattern-name');
        if (nameInput.length) {
            nameInput.trigger('focus');
        }
        scheduleProfileAutoSave({
            reason: 'character patterns',
            element: buttonEl,
            noticeKey: buttonEl.dataset.changeNoticeKey || 'cs-pattern-add-slot',
        });
    });

    editor.attr('aria-busy', 'false');
    updateFocusLockUI();
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
    folderPicker.on('change', function () {
        const folderPath = extractDirectoryFromFileList(this.files || []);
        if (folderPath) {
            const combinedPath = buildVariantFolderPath(mapping, folderPath);
            folderInput.val(combinedPath);
            folderInput.trigger('input');
        }
        $(this).val('');
    });
    folderRow.append(folderInput, folderButton, folderPicker);
    folderField.append(folderRow);

    const priorityId = `cs-outfit-variant-priority-${mappingIdx}-${variantIndex}`;
    const priorityField = $('<div>').addClass('cs-field')
        .append($('<label>', { for: priorityId, text: 'Priority' }));
    const priorityValue = Number.isFinite(Number(normalized.priority)) ? Number(normalized.priority) : 0;
    const priorityInput = $('<input>', {
        id: priorityId,
        type: 'number',
        step: '1',
    }).addClass('text_pole cs-outfit-variant-priority')
        .val(priorityValue);
    priorityField.append(priorityInput);
    priorityField.append($('<small>').text('Higher numbers take precedence when multiple variants match.'));

    grid.append(labelField, folderField, priorityField);
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

    const updateAwarenessState = () => {
        const requiresList = parseOutfitListInput(requiresTextarea.val());
        const anyList = parseOutfitListInput(anyTextarea.val());
        const excludesList = parseOutfitListInput(excludesTextarea.val());
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
    };

    const handleAwarenessInput = function () {
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
        markVariantDirty(labelInput[0]);
    });

    folderInput.on('input', () => {
        normalized.folder = folderInput.val().trim();
        markVariantDirty(folderInput[0]);
    });

    priorityInput.on('input', () => {
        const raw = priorityInput.val();
        const value = Number(raw);
        if (Number.isFinite(value)) {
            normalized.priority = value;
        } else {
            normalized.priority = 0;
        }
        markVariantDirty(priorityInput[0]);
    });

    triggerTextarea.on('input', () => {
        const triggers = triggerTextarea.val()
            .split(/\r?\n/)
            .map(value => value.trim())
            .filter(Boolean);
        normalized.triggers = triggers;
        markVariantDirty(triggerTextarea[0]);
    });

    removeButton.on('click', () => {
        announceAutoSaveIntent(removeButton[0], 'character mappings', removeButton[0].dataset.changeNotice, removeButton[0].dataset.changeNoticeKey);
        const activeProfile = profile || getActiveProfile();
        if (!activeProfile?.mappings?.[mappingIdx]) {
            return;
        }
        activeProfile.mappings[mappingIdx].outfits.splice(variantIndex, 1);
        variantEl.remove();
        const card = $(`.cs-outfit-card[data-idx="${mappingIdx}"]`);
        const variantContainer = card.find('.cs-outfit-variants');
        variantContainer.find('.cs-outfit-variant').each(function (index) {
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
            if (cardId && state?.draftMappingIds instanceof Set) {
                state.draftMappingIds.delete(cardId);
            }
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
    defaultPicker.on('change', function () {
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
}

function renderMappings(profile) {
    if (!profile || typeof profile !== 'object') {
        renderPatternEditor(null);
        renderOutfitLab({ mappings: [] });
        return;
    }

    renderPatternEditor(profile);

    if (!Array.isArray(profile.mappings)) {
        profile.mappings = [];
    } else {
        profile.mappings = profile.mappings.map((entry) => normalizeMappingEntry(entry));
    }

    renderOutfitLab(profile);
}

function syncOutfitLabMappingsFromUI(profile) {
    if (!profile || typeof profile !== "object") {
        return;
    }
    if (!Array.isArray(profile.mappings)) {
        return;
    }
    const container = $("#cs-outfit-character-list");
    if (!container.length) {
        return;
    }

    container.find(".cs-outfit-card").each(function () {
        const card = $(this);
        const idx = Number(card.data("idx"));
        if (!Number.isFinite(idx) || !profile.mappings[idx]) {
            return;
        }
        const mapping = profile.mappings[idx];

        const nameInput = card.find(".cs-outfit-character-name");
        if (nameInput.length) {
            mapping.name = String(nameInput.val() ?? "").trim();
        }

        const defaultInput = card.find(".cs-outfit-default-folder");
        if (defaultInput.length) {
            const value = String(defaultInput.val() ?? "").trim();
            mapping.defaultFolder = value;
            if (value) {
                mapping.folder = value;
            } else if (typeof mapping.folder === "string") {
                mapping.folder = mapping.folder.trim();
            }
        }

        const outfits = [];
        card.find(".cs-outfit-variant").each(function () {
            const variantEl = $(this);
            const labelValue = String(variantEl.find(".cs-outfit-variant-label").val() ?? "").trim();
            const folderValue = String(variantEl.find(".cs-outfit-variant-folder").val() ?? "").trim();
            const priorityRaw = variantEl.find(".cs-outfit-variant-priority").val();
            const priority = Number(priorityRaw);
            const triggers = String(variantEl.find(".cs-outfit-variant-triggers").val() ?? "")
                .split(/\r?\n/)
                .map((value) => value.trim())
                .filter(Boolean);
            const matchKinds = variantEl.find(".cs-outfit-matchkind-options input:checked")
                .map((_, el) => String(el.value ?? "").trim())
                .get()
                .filter(Boolean);
            const awarenessInputs = variantEl.find(".cs-outfit-awareness-input");
            const requires = parseOutfitListInput(awarenessInputs.eq(0).val());
            const requiresAny = parseOutfitListInput(awarenessInputs.eq(1).val());
            const excludes = parseOutfitListInput(awarenessInputs.eq(2).val());
            const awareness = {};
            if (requires.length) {
                awareness.requires = requires;
            }
            if (requiresAny.length) {
                awareness.requiresAny = requiresAny;
            }
            if (excludes.length) {
                awareness.excludes = excludes;
            }

            const variant = {
                folder: folderValue,
                triggers,
                priority: Number.isFinite(priority) ? priority : 0,
            };
            if (labelValue) {
                variant.label = labelValue;
            }
            if (matchKinds.length) {
                variant.matchKinds = matchKinds;
            }
            if (Object.keys(awareness).length) {
                variant.awareness = awareness;
            }

            outfits.push(normalizeOutfitVariant(variant));
        });
        mapping.outfits = outfits;
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
        'outfit-unchanged': 'already wearing the selected outfit',
        'global-cooldown': 'blocked by global cooldown',
        'per-trigger-cooldown': 'blocked by per-trigger cooldown',
        'failed-trigger-cooldown': 'waiting after a failed switch',
        'repeat-suppression': 'suppressed as a rapid repeat',
        'no-profile': 'profile unavailable',
        'no-name': 'no name detected',
        'focus-lock': 'focus lock active',
        'outfit-unavailable': 'no mapped outfit available',
    };
    return messages[code] || 'not eligible to switch yet';
}

const RELEVANT_SKIP_CODES = new Set([
    'repeat-suppression',
    'global-cooldown',
    'per-trigger-cooldown',
    'failed-trigger-cooldown',
]);

const MAX_RECENT_DECISION_EVENTS = 25;

function trimDecisionEvents(events, max = MAX_RECENT_DECISION_EVENTS) {
    if (!Array.isArray(events)) {
        return [];
    }
    if (events.length <= max) {
        return events.slice();
    }

    const preservedTypes = new Set(["switch", "veto"]);
    const queue = events.slice();
    while (queue.length > max) {
        const dropIndex = queue.findIndex((event) => {
            if (!event || typeof event !== "object") {
                return true;
            }
            return !preservedTypes.has(event.type);
        });
        if (dropIndex === -1) {
            queue.splice(0, queue.length - max);
        } else {
            queue.splice(dropIndex, 1);
        }
    }
    return queue;
}

const __testables = {
    trimDecisionEvents,
    recordDecisionEvent,
    buildStreamingBuffers,
    STREAM_BUFFER_SAFETY_CHARS,
    resolveStreamSnapshotSource,
    resolveMessageSpeakerName,
    applySpeakerPrefix,
    shouldPrefixSpeaker,
    processStreamChunk,
};

function recordLastVetoMatch(match, { source = 'live', persist = true } = {}) {
    const phrase = String(match ?? '').trim() || '(unknown veto phrase)';
    const entry = { phrase, source, at: Date.now() };
    state.lastVetoMatch = entry;
    if (persist) {
        const session = ensureSessionData();
        if (session) {
            session.lastVetoMatch = entry;
        }
    }
    return entry;
}

function getSkipSummaryEvents(eventsOverride = null) {
    if (Array.isArray(eventsOverride)) {
        return eventsOverride;
    }
    if (Array.isArray(state.lastTesterReport?.events) && state.lastTesterReport.events.length) {
        return state.lastTesterReport.events;
    }
    if (Array.isArray(state.recentDecisionEvents) && state.recentDecisionEvents.length) {
        return state.recentDecisionEvents;
    }
    const session = ensureSessionData();
    if (session && Array.isArray(session.recentDecisionEvents) && session.recentDecisionEvents.length) {
        return session.recentDecisionEvents;
    }
    return [];
}

function updateSkipReasonSummaryDisplay(eventsOverride = null) {
    if (typeof document === 'undefined') {
        return;
    }
    const el = document.getElementById('cs-test-skip-reasons');
    if (!el) {
        return;
    }
    const events = getSkipSummaryEvents(eventsOverride);
    const summary = summarizeSkipReasonsForReport(events);
    const relevant = summary.filter(item => RELEVANT_SKIP_CODES.has(item.code));
    if (!relevant.length) {
        const hasEvents = Array.isArray(events) && events.length > 0;
        el.textContent = hasEvents ? 'No cooldown skips recorded' : 'None recorded';
        el.classList.add('cs-tester-list-placeholder');
        el.removeAttribute('title');
        return;
    }

    const parts = relevant.slice(0, 3).map(item => `${describeSkipReason(item.code)} (${item.count})`);
    el.textContent = parts.join(', ');
    el.classList.remove('cs-tester-list-placeholder');
    const tooltip = relevant.map(item => `${describeSkipReason(item.code)} (${item.code}): ${item.count}`).join('\n');
    el.setAttribute('title', tooltip);
}

function overwriteRecentDecisionEvents(messageKey, events) {
    const normalizedKey = normalizeMessageKey(messageKey);
    const prepared = [];
    if (normalizedKey && Array.isArray(events)) {
        events.forEach((event) => {
            const clone = cloneDecisionEvent(event);
            if (!clone) {
                return;
            }
            clone.messageKey = normalizedKey;
            if (!Number.isFinite(clone.timestamp)) {
                clone.timestamp = Date.now();
            }
            if (typeof clone.name === "string" && clone.name.trim()) {
                clone.name = clone.name.trim();
            }
            const normalizedName = normalizeRosterKey(clone.normalized || clone.name);
            if (normalizedName) {
                clone.normalized = normalizedName;
            } else {
                delete clone.normalized;
            }
            prepared.push(clone);
        });
    }

    const limited = trimDecisionEvents(prepared, MAX_RECENT_DECISION_EVENTS);

    state.recentDecisionEvents = limited;

    const session = ensureSessionData();
    if (session) {
        session.recentDecisionEvents = limited.map(event => cloneDecisionEvent(event));
    }

    updateSkipReasonSummaryDisplay();
    return limited;
}

function recordDecisionEvent(event) {
    if (!event || typeof event !== 'object') {
        return;
    }
    const entry = {
        ...event,
        timestamp: Number.isFinite(event.timestamp) ? event.timestamp : Date.now(),
    };
    if (typeof entry.name === "string" && entry.name.trim()) {
        entry.name = entry.name.trim();
    }
    const normalizedName = normalizeRosterKey(entry.normalized || entry.name);
    if (normalizedName) {
        entry.normalized = normalizedName;
    } else {
        delete entry.normalized;
    }
    if (!entry.messageKey) {
        if (typeof event.messageKey === "string" && event.messageKey.trim()) {
            entry.messageKey = normalizeMessageKey(event.messageKey);
        } else if (state.currentGenerationKey) {
            entry.messageKey = normalizeMessageKey(state.currentGenerationKey);
        }
    }
    if (!Array.isArray(state.recentDecisionEvents)) {
        state.recentDecisionEvents = [];
    }
    state.recentDecisionEvents.push(entry);
    state.recentDecisionEvents = trimDecisionEvents(state.recentDecisionEvents, MAX_RECENT_DECISION_EVENTS);

    const session = ensureSessionData();
    if (session) {
        if (!Array.isArray(session.recentDecisionEvents)) {
            session.recentDecisionEvents = [];
        }
        session.recentDecisionEvents.push(entry);
        session.recentDecisionEvents = trimDecisionEvents(session.recentDecisionEvents, MAX_RECENT_DECISION_EVENTS);
    }

    updateSkipReasonSummaryDisplay();
    requestScenePanelRender("decision-event");
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

function updateTesterPreprocessedDisplay(text) {
    const el = $('#cs-test-preprocessed');
    if (!el.length) {
        return;
    }
    const placeholder = el.attr('data-placeholder') || 'No scripts applied yet.';
    if (typeof text === 'string' && text.length > 0) {
        el.removeClass('cs-tester-list-placeholder');
        el.text(text);
    } else {
        el.addClass('cs-tester-list-placeholder');
        el.text(placeholder);
    }
}

function refreshTesterPreprocessorPreview(pipeline = null) {
    const lastReport = state.lastTesterReport;
    if (!lastReport || typeof lastReport.normalizedInput !== 'string' || !lastReport.normalizedInput.length) {
        if (!lastReport) {
            updateTesterPreprocessedDisplay(null);
        }
        return;
    }

    const profile = getActiveProfile();
    if (!profile) {
        updateTesterPreprocessedDisplay(null);
        return;
    }

    const effectivePipeline = Array.isArray(pipeline)
        ? pipeline
        : refreshProfilePreprocessorPipeline(profile);
    const normalizedInput = lastReport.normalizedInput;
    const result = applyPreprocessorScripts(normalizedInput, effectivePipeline || []);
    const processedText = typeof result?.text === 'string'
        ? result.text
        : normalizedInput;
    state.lastPreprocessedText = processedText;
    lastReport.preprocessedText = processedText;
    const scriptSummary = normalizeAppliedScriptEntries(result?.applied);
    state.lastPreprocessorScripts = scriptSummary;
    lastReport.preprocessorScripts = clonePreprocessorScripts(scriptSummary);
    updateTesterPreprocessedDisplay(processedText);
    renderTesterPreprocessorMeta({ scripts: scriptSummary });
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
            warningContainer.text('No tester warnings triggered.');
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

async function analyzeCoverageDiagnostics(text, profile = getActiveProfile()) {
    if (!text) {
        return { missingPronouns: [], missingAttributionVerbs: [], missingActionVerbs: [], totalTokens: 0 };
    }

    const normalized = normalizeStreamText(text).toLowerCase();
    const tokens = normalized.match(COVERAGE_TOKEN_REGEX) || [];
    // FIX #9: Use accurate async tokenizer for total count
    const accurateCount = await getTokenCountAsync(text);
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
        totalTokens: accurateCount,
    };
}

function cloneCoverageDiagnostics(value) {
    if (!value || typeof value !== "object") {
        return { missingPronouns: [], missingAttributionVerbs: [], missingActionVerbs: [], totalTokens: 0 };
    }
    return {
        missingPronouns: Array.isArray(value.missingPronouns) ? [...value.missingPronouns] : [],
        missingAttributionVerbs: Array.isArray(value.missingAttributionVerbs) ? [...value.missingAttributionVerbs] : [],
        missingActionVerbs: Array.isArray(value.missingActionVerbs) ? [...value.missingActionVerbs] : [],
        totalTokens: Number.isFinite(value.totalTokens) ? value.totalTokens : 0,
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

async function refreshCoverageFromLastReport() {
    const text = state.lastTesterReport?.normalizedInput;
    const profile = getActiveProfile();
    if (text) {
        const coverage = await analyzeCoverageDiagnostics(text, profile);
        renderCoverageDiagnostics(coverage);
        if (state.lastTesterReport) {
            state.lastTesterReport.coverage = coverage;
        }
    } else {
        renderCoverageDiagnostics(null);
    }
}

function describeScriptCollectionLabel(key) {
    if (!key) {
        return "Custom";
    }
    const normalized = String(key).toLowerCase();
    return SCRIPT_COLLECTION_LABELS[normalized] || key;
}

function resolveScriptName(script, index = 0) {
    if (!script || typeof script !== "object") {
        return `Script ${index + 1}`;
    }
    const candidates = [script.name, script.label, script.title, script.id, script.scriptId];
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate.trim();
        }
    }
    return `Script ${index + 1}`;
}

function resolveScriptDescription(script) {
    if (!script || typeof script !== "object") {
        return "";
    }
    const description = typeof script.description === "string"
        ? script.description
        : typeof script.desc === "string"
            ? script.desc
            : "";
    return description.trim();
}

function normalizeAppliedScriptEntries(applied = []) {
    if (!Array.isArray(applied)) {
        return [];
    }
    return applied
        .map((entry, index) => {
            if (!entry || typeof entry !== "object") {
                return null;
            }
            const script = entry.script && typeof entry.script === "object" ? entry.script : null;
            return {
                collection: typeof entry.collection === "string" ? entry.collection : null,
                script: script
                    ? {
                        id: script.id ?? script.scriptId ?? null,
                        name: resolveScriptName(script, index),
                        description: resolveScriptDescription(script),
                    }
                    : null,
            };
        })
        .filter(Boolean);
}

function clonePreprocessorScripts(scripts = []) {
    if (!Array.isArray(scripts)) {
        return [];
    }
    return scripts.map(entry => ({
        collection: entry?.collection ?? null,
        script: entry?.script
            ? {
                id: entry.script.id ?? null,
                name: entry.script.name ?? null,
                description: entry.script.description ?? "",
            }
            : null,
    }));
}

function renderTesterScriptList(scriptsInput) {
    const list = $("#cs-preprocessor-script-list");
    if (!list.length) {
        return;
    }
    const scripts = Array.isArray(scriptsInput) ? scriptsInput : [];
    list.empty();
    if (!scripts.length) {
        list.append($('<li>').addClass('cs-tester-list-placeholder').text('No scripts executed.'));
        return;
    }
    scripts.forEach((entry, index) => {
        const item = $('<li>').addClass('cs-script-entry');
        const summary = $('<div>').addClass('cs-script-entry__summary');
        summary.append($('<span>').addClass('cs-script-entry__collection').text(describeScriptCollectionLabel(entry?.collection)));
        const scriptName = entry?.script?.name || `Script ${index + 1}`;
        summary.append($('<span>').addClass('cs-script-entry__name').text(scriptName));
        const actions = $('<div>').addClass('cs-script-entry__actions');
        const expandButton = $('<button type="button">')
            .addClass('cs-script-entry__action cs-script-entry__expand')
            .attr('aria-expanded', 'false')
            .text('Show Details');
        actions.append(expandButton);
        const hasDescription = Boolean(entry?.script?.description);
        const copyButton = $('<button type="button">')
            .addClass('cs-script-entry__action cs-script-entry__copy')
            .text('Copy')
            .prop('disabled', !hasDescription);
        if (hasDescription) {
            copyButton.attr('title', 'Copy script description.');
            copyButton.data('description', entry.script.description);
        } else {
            copyButton.attr('title', 'No description to copy.');
        }
        actions.append(copyButton);
        summary.append(actions);
        item.append(summary);
        const description = $('<div>').addClass('cs-script-entry__description');
        if (hasDescription) {
            description.text(entry.script.description);
        } else {
            description.append($('<span>').addClass('cs-tester-list-placeholder').text('No description provided.'));
        }
        item.append(description);
        list.append(item);
    });
}

function renderTesterPreprocessorMeta({ scripts } = {}) {
    const scriptsToRender = scripts !== undefined ? scripts : state.lastPreprocessorScripts;
    renderTesterScriptList(scriptsToRender);
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
    lines.push('Character Visuals – Live Pattern Tester Report');
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

    const scriptSummary = Array.isArray(report.preprocessorScripts) ? report.preprocessorScripts : [];
    lines.push('Preprocessor Scripts:');
    if (scriptSummary.length) {
        scriptSummary.forEach((entry, idx) => {
            const label = describeScriptCollectionLabel(entry?.collection);
            const scriptName = entry?.script?.name || '(unnamed script)';
            lines.push(`  ${idx + 1}. [${label}] ${scriptName}`);
            if (entry?.script?.description) {
                entry.script.description.split(/\r?\n/).forEach(line => {
                    lines.push(`       ${line}`);
                });
            }
        });
    } else {
        lines.push('  (none executed)');
    }
    lines.push('');

    lines.push('Name Normalization: Not tracked (fuzzy matching removed).');
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
        const summaryKeys = ['globalCooldownMs', 'perTriggerCooldownMs', 'repeatSuppressMs'];
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

    if (!Number.isFinite(msgState.bufferOffset)) {
        msgState.bufferOffset = 0;
    }

    if (!Number.isFinite(msgState.processedLength)) {
        msgState.processedLength = 0;
    }

    if (Number.isFinite(trimmedChars) && trimmedChars > 0) {
        msgState.bufferOffset += trimmedChars;
        shiftDetectionContext(msgState, msgState.bufferOffset);
    }

    if (Number.isFinite(combinedLength) && combinedLength >= 0) {
        const absoluteTail = msgState.bufferOffset + combinedLength;
        msgState.processedLength = Math.max(msgState.processedLength, absoluteTail);
    }
}

function buildStreamingBuffers(previousBuffer, nextChunk, profile, msgState) {
    const priorText = typeof previousBuffer === "string" ? previousBuffer : "";
    const appended = priorText + (typeof nextChunk === "string" ? nextChunk : "");
    const safetyLimit = Math.max(resolveMaxBufferChars(profile), STREAM_BUFFER_SAFETY_CHARS);
    const trimmedChars = safetyLimit > 0 && appended.length > safetyLimit
        ? appended.length - safetyLimit
        : 0;
    const detectionBuffer = trimmedChars > 0 ? appended.slice(-safetyLimit) : appended;
    const appendedWindow = detectionBuffer;
    const baseBufferOffset = Number.isFinite(msgState?.bufferOffset) ? msgState.bufferOffset : 0;
    const bufferOffset = baseBufferOffset + trimmedChars;

    return {
        appended: appendedWindow,
        detectionBuffer,
        trimmedChars,
        bufferOffset,
    };
}

function createTesterMessageState(profile) {
    const defaultRosterTTL = sanitizeRosterTurnValue(profile?.sceneRosterTTL ?? PROFILE_DEFAULTS.sceneRosterTTL);
    return {
        lastAcceptedName: null,
        lastAcceptedTs: 0,
        vetoed: false,
        lastSubject: null,
        lastSubjectNormalized: null,
        pendingSubject: null,
        pendingSubjectNormalized: null,
        sceneRoster: new Set(),
        rosterTurns: new Map(),
        defaultRosterTTL,
        outfitRoster: new Map(),
        outfitTTL: sanitizeRosterTurnValue(profile?.sceneRosterTTL ?? PROFILE_DEFAULTS.sceneRosterTTL),
        processedLength: 0,
        lastAcceptedIndex: -1,
        bufferOffset: 0,
        speakerPrefixLength: 0,
        detectionContext: createDetectionContext(0),
    };
}

function buildSimulationFinalState(msgState) {
    if (!msgState || typeof msgState !== "object") {
        return {
            lastAcceptedName: null,
            lastAcceptedTimestamp: 0,
            lastSubject: null,
            processedLength: 0,
            sceneRoster: [],
            rosterTTL: null,
            outfitRoster: [],
            outfitTTL: null,
            vetoed: false,
            virtualDurationMs: 0,
        };
    }

    return {
        lastAcceptedName: msgState.lastAcceptedName,
        lastAcceptedTimestamp: msgState.lastAcceptedTs,
        lastSubject: msgState.lastSubject,
        processedLength: msgState.processedLength,
        sceneRoster: Array.from(msgState.sceneRoster || []),
        rosterTTL: msgState.defaultRosterTTL,
        rosterTurns: msgState?.rosterTurns instanceof Map
            ? Array.from(msgState.rosterTurns.entries())
            : [],
        outfitRoster: Array.from(msgState.outfitRoster || []),
        outfitTTL: msgState.outfitTTL,
        vetoed: Boolean(msgState.vetoed),
        virtualDurationMs: msgState.processedLength > 0 ? Math.max(0, (msgState.processedLength - 1) * 50) : 0,
    };
}

function simulateTesterStream(combined, profile, bufKey, options = {}) {
    const events = [];
    const normalizedKey = normalizeMessageKey(bufKey) || bufKey;
    const msgState = state.perMessageStates.get(normalizedKey);
    state.lastPreprocessedText = typeof combined === "string" ? combined : "";
    if (!msgState) {
        replaceLiveTesterOutputs([], { roster: [], preprocessedText: state.lastPreprocessedText });
        requestScenePanelRender("tester-reset", { source: "tester" });
        return { events, finalState: null, rosterTimeline: [], rosterWarnings: [] };
    }

    if (!(msgState.rosterTurns instanceof Map)) {
        msgState.rosterTurns = new Map();
    }
    if (!Number.isFinite(msgState.defaultRosterTTL)) {
        msgState.defaultRosterTTL = sanitizeRosterTurnValue(profile?.sceneRosterTTL ?? PROFILE_DEFAULTS.sceneRosterTTL);
    }

    const settings = getSettings();
    const rosterDisplayNames = new Map();
    const normalizedTesterKey = normalizeMessageKey(bufKey) || String(bufKey ?? "").trim() || "tester";
    const testerMessageKey = normalizedTesterKey.startsWith("tester:")
        ? normalizedTesterKey
        : `tester:${normalizedTesterKey}`;
    const overridePreprocessedText = typeof options?.preprocessedText === "string"
        ? options.preprocessedText
        : null;
    const finalizeResult = (result, extra = {}) => {
        const rosterSnapshot = Array.isArray(result?.finalState?.sceneRoster)
            ? result.finalState.sceneRoster
            : Array.from(msgState?.sceneRoster || []);
        const eventList = Array.isArray(result?.events) ? result.events : events;
        const preprocessedText = typeof extra.preprocessedText === "string"
            ? extra.preprocessedText
            : (overridePreprocessedText ?? state.lastPreprocessedText);
        overwriteRecentDecisionEvents(testerMessageKey, eventList);
        replaceLiveTesterOutputs(eventList, {
            roster: rosterSnapshot,
            displayNames: rosterDisplayNames,
            preprocessedText,
        });
        state.lastPreprocessedText = preprocessedText;
        requestScenePanelRender("tester-stream", { source: "tester" });
        return result;
    };

    const lockedName = String(settings?.focusLock?.character ?? "").trim();
    if (lockedName) {
        const event = buildFocusLockSkipEvent(lockedName);
        events.push(event);
        return finalizeResult({
            events,
            finalState: buildSimulationFinalState(msgState),
            rosterTimeline: [],
            rosterWarnings: [],
        });
    }

    const effectivePatterns = Array.isArray(state.compiledRegexes?.effectivePatterns)
        ? state.compiledRegexes.effectivePatterns
        : [];
    if (!effectivePatterns.length) {
        return finalizeResult({
            events,
            finalState: null,
            rosterTimeline: [],
            rosterWarnings: [{ type: "no-patterns", message: NO_EFFECTIVE_PATTERNS_MESSAGE }],
        });
    }

    const simulationState = {
        lastIssuedCostume: null,
        lastIssuedFolder: null,
        lastSwitchTimestamp: 0,
        lastTriggerTimes: new Map(),
        failedTriggerTimes: new Map(),
        characterOutfits: new Map(),
    };

    const defaultRosterTTL = sanitizeRosterTurnValue(profile?.sceneRosterTTL ?? PROFILE_DEFAULTS.sceneRosterTTL);
    const repeatSuppress = Number(profile.repeatSuppressMs) || 0;
    let buffer = "";
    const rosterTimeline = [];
    const rosterWarnings = [];

    for (let i = 0; i < combined.length; i++) {
        const { appended, detectionBuffer, trimmedChars, bufferOffset } = buildStreamingBuffers(buffer, combined[i], profile, msgState);
        const combinedLength = detectionBuffer.length;
        const newestAbsoluteIndex = combinedLength > 0 ? bufferOffset + combinedLength - 1 : bufferOffset;
        const lastProcessedIndex = Number.isFinite(msgState.lastAcceptedIndex) ? msgState.lastAcceptedIndex : -1;
        let windowUpdated = false;
        const flushWindow = () => {
            if (windowUpdated) {
                return;
            }
            adjustWindowForTrim(msgState, trimmedChars, combinedLength);
            state.perMessageBuffers.set(bufKey, appended);
            windowUpdated = true;
        };
        buffer = appended;

        if (newestAbsoluteIndex <= lastProcessedIndex) {
            flushWindow();
            continue;
        }

        if (state.compiledRegexes.vetoRegex && state.compiledRegexes.vetoRegex.test(detectionBuffer)) {
            const vetoMatch = detectionBuffer.match(state.compiledRegexes.vetoRegex)?.[0];
            const recordedVeto = recordLastVetoMatch(vetoMatch, { source: 'tester', persist: false });
            if (typeof globalThis.$ === 'function') {
                showStatus(`Detection halted. Veto phrase <b>${escapeHtml(recordedVeto.phrase)}</b> matched in tester.`, 'error', 5000);
            }
            if (vetoMatch) {
                events.push({ type: 'veto', match: vetoMatch, charIndex: newestAbsoluteIndex });
            }
            msgState.vetoed = true;
            flushWindow();
            break;
        }

        let minIndexRelative = null;
        if (lastProcessedIndex >= bufferOffset) {
            minIndexRelative = lastProcessedIndex - bufferOffset;
        }

        const matchOptions = {};
        if (Number.isFinite(minIndexRelative) && minIndexRelative >= 0) {
            matchOptions.minIndex = minIndexRelative;
        }
        matchOptions.messageState = msgState;

        const matches = findAllMatches(detectionBuffer, matchOptions);
        const bestMatch = findBestMatch(detectionBuffer, matches, matchOptions);
        if (!bestMatch) {
            if (Array.isArray(matches.filteredOut) && matches.filteredOut.length) {
                matches.filteredOut.forEach((entry) => {
                    events.push({
                        type: 'skipped',
                        name: entry.name,
                        rawName: entry.rawName || entry.name,
                        matchKind: entry.matchKind,
                        reason: entry.reason || 'outfit-unavailable',
                        charIndex: newestAbsoluteIndex,
                        tokenIndex: entry.tokenIndex ?? null,
                        tokenLength: entry.tokenLength ?? null,
                        nameResolution: entry.nameResolution || null,
                    });
                });
            }
            flushWindow();
            continue;
        }

        const matchLength = Number.isFinite(bestMatch.matchLength) && bestMatch.matchLength > 0
            ? Math.floor(bestMatch.matchLength)
            : 1;
        const matchTokenIndex = Number.isFinite(bestMatch.tokenIndex)
            ? Math.floor(bestMatch.tokenIndex)
            : null;
        const matchTokenLength = Number.isFinite(bestMatch.tokenLength) && bestMatch.tokenLength > 0
            ? Math.floor(bestMatch.tokenLength)
            : null;
        const matchKind = bestMatch.matchKind;
        const matchEndRelative = Number.isFinite(bestMatch.matchIndex)
            ? bestMatch.matchIndex + matchLength - 1
            : null;
        const absoluteIndex = Number.isFinite(matchEndRelative)
            ? bufferOffset + matchEndRelative
            : newestAbsoluteIndex;

        msgState.lastAcceptedIndex = absoluteIndex;
        msgState.processedLength = Math.max(msgState.processedLength || 0, absoluteIndex + 1);

        if (profile.enableSceneRoster) {
            const normalized = normalizeRosterKey(bestMatch.name);
            const wasPresent = normalized ? msgState.sceneRoster.has(normalized) : false;
            if (normalized) {
                msgState.sceneRoster.add(normalized);
                rosterDisplayNames.set(normalized, bestMatch.rawName || bestMatch.name);
                const resolvedTTL = sanitizeRosterTurnValue(msgState.defaultRosterTTL ?? defaultRosterTTL);
                if (resolvedTTL != null) {
                    msgState.rosterTurns.set(normalized, resolvedTTL);
                }
            }
            msgState.outfitTTL = sanitizeRosterTurnValue(profile?.sceneRosterTTL ?? PROFILE_DEFAULTS.sceneRosterTTL);
            rosterTimeline.push({
                type: wasPresent ? 'refresh' : 'join',
                name: bestMatch.name,
                rawName: bestMatch.rawName || bestMatch.name,
                matchKind: bestMatch.matchKind,
                charIndex: absoluteIndex,
                tokenIndex: matchTokenIndex,
                tokenLength: matchTokenLength,
                timestamp: absoluteIndex * 50,
                rosterSize: msgState.sceneRoster.size,
                nameResolution: bestMatch.nameResolution || null,
            });
        }

        if (bestMatch.matchKind !== 'pronoun') {
            confirmMessageSubject(msgState, bestMatch.name);
        }

        const virtualNow = absoluteIndex * 50;
        if (msgState.lastAcceptedName?.toLowerCase() === bestMatch.name.toLowerCase()
            && (virtualNow - msgState.lastAcceptedTs < repeatSuppress)) {
            if (bestMatch.matchKind !== 'pronoun') {
                events.push({
                    type: 'skipped',
                    name: bestMatch.name,
                    rawName: bestMatch.rawName || bestMatch.name,
                    matchKind: bestMatch.matchKind,
                    reason: 'repeat-suppression',
                    charIndex: absoluteIndex,
                    tokenIndex: matchTokenIndex,
                    tokenLength: matchTokenLength,
                    nameResolution: bestMatch.nameResolution || null,
                });
            }
            flushWindow();
            continue;
        }

        msgState.lastAcceptedName = bestMatch.name;
        msgState.lastAcceptedTs = virtualNow;

        const decision = evaluateSwitchDecision(bestMatch.name, {
            matchKind: bestMatch.matchKind,
            bufKey,
            messageState: msgState,
            context: { text: detectionBuffer, matchKind: bestMatch.matchKind, roster: msgState.sceneRoster },
            rawName: bestMatch.rawName || bestMatch.name,
            nameResolution: bestMatch.nameResolution || null,
        }, simulationState, virtualNow);
        if (decision.shouldSwitch) {
            events.push({
                type: 'switch',
                name: bestMatch.name,
                rawName: bestMatch.rawName || bestMatch.name,
                folder: decision.folder,
                matchKind: bestMatch.matchKind,
                score: Math.round(bestMatch.score ?? 0),
                charIndex: absoluteIndex,
                tokenIndex: matchTokenIndex,
                tokenLength: matchTokenLength,
                outfit: decision.outfit ? {
                    folder: decision.outfit.folder,
                    label: decision.outfit.label || null,
                    reason: decision.outfit.reason || null,
                    trigger: decision.outfit.trigger || null,
                    awareness: decision.outfit.awareness || null,
                } : null,
                nameResolution: bestMatch.nameResolution || null,
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
            if (decision.reason === 'outfit-unchanged' && decision.outfit?.folder) {
                const cache = ensureCharacterOutfitCache(simulationState);
                cache.set(decision.name.toLowerCase(), {
                    folder: decision.outfit.folder,
                    reason: decision.outfit.reason || 'tester',
                    label: decision.outfit.label || null,
                    updatedAt: decision.now,
                });
            }

            if (shouldLogMatchEvent(bestMatch.matchKind, decision.reason)) {
                events.push({
                    type: 'skipped',
                    name: bestMatch.name,
                    rawName: bestMatch.rawName || bestMatch.name,
                    matchKind: bestMatch.matchKind,
                    reason: decision.reason || 'unknown',
                    outfit: decision.outfit ? {
                        folder: decision.outfit.folder,
                        label: decision.outfit.label || null,
                        reason: decision.outfit.reason || null,
                        trigger: decision.outfit.trigger || null,
                        awareness: decision.outfit.awareness || null,
                    } : null,
                    charIndex: absoluteIndex,
                    tokenIndex: matchTokenIndex,
                    tokenLength: matchTokenLength,
                    nameResolution: bestMatch.nameResolution || null,
                });
            }
        }

        if (state.currentGenerationKey && state.currentGenerationKey === bufKey) {
            const displayNames = new Map();
            if (bestMatch.name) {
                const normalizedName = normalizeRosterKey(bestMatch.name);
                if (normalizedName) {
                    displayNames.set(normalizedName, bestMatch.rawName || bestMatch.name);
                }
            }
            applySceneRosterUpdate({
                key: bufKey,
                messageId: extractMessageIdFromKey(bufKey),
                roster: Array.from(msgState.sceneRoster || []),
                displayNames,
                lastMatch: {
                    name: bestMatch.name,
                    rawName: bestMatch.rawName || bestMatch.name,
                    matchKind,
                    charIndex: absoluteIndex,
                    tokenIndex: matchTokenIndex,
                    tokenLength: matchTokenLength,
                    nameResolution: bestMatch.nameResolution || null,
                },
                updatedAt: now,
                turnsByMember: cloneRosterTurns(msgState.rosterTurns),
                turnsRemaining: msgState.defaultRosterTTL,
            });
            requestScenePanelRender("stream-roster");
        }
        flushWindow();
    }

    const finalState = buildSimulationFinalState(msgState);

    if (profile.enableSceneRoster && msgState.rosterTurns instanceof Map && msgState.rosterTurns.size > 0) {
        const expiring = [];
        msgState.rosterTurns.forEach((turns, normalized) => {
            const sanitized = sanitizeRosterTurnValue(turns);
            if (sanitized == null) {
                return;
            }
            if (sanitized <= 1) {
                const nextRemaining = Math.max(0, sanitized - 1);
                expiring.push({
                    name: rosterDisplayNames.get(normalized) || normalized,
                    remaining: nextRemaining,
                });
            }
        });
        if (expiring.length) {
            const names = expiring.map((entry) => entry.name);
            const turnsRemaining = expiring.reduce((min, entry) => Math.min(min, entry.remaining), expiring[0].remaining);
            const ttlLabel = defaultRosterTTL != null
                ? `Scene roster TTL of ${defaultRosterTTL}`
                : "Scene roster TTL";
            rosterWarnings.push({
                type: 'ttl-expiry',
                turnsRemaining: Math.max(0, turnsRemaining),
                names,
                message: `${ttlLabel} will clear ${names.join(', ')} before the next message. Consider increasing the TTL for longer conversations.`,
            });
            rosterTimeline.push({
                type: 'expiry-warning',
                turnsRemaining: Math.max(0, turnsRemaining),
                names,
                timestamp: finalState.virtualDurationMs,
            });
        }
    }

    return finalizeResult({ events, finalState, rosterTimeline, rosterWarnings }, {
        preprocessedText: overridePreprocessedText ?? state.lastPreprocessedText,
    });
}


function renderTesterStream(eventList, events) {
    eventList.empty();
    if (!events.length) {
        eventList.html('<li class="cs-tester-list-placeholder">No stream activity.</li>');
        return;
    }

    let delay = 0;
    const formatTokenSpan = (event) => {
        if (!event || !Number.isFinite(event.tokenIndex)) {
            return "";
        }
        const start = event.tokenIndex + 1;
        const length = Number.isFinite(event.tokenLength) && event.tokenLength > 1
            ? Math.floor(event.tokenLength)
            : null;
        if (length && length > 1) {
            const end = start + length - 1;
            return `, token T#${start}…${end}`;
        }
        return `, token T#${start}`;
    };
    events.forEach(event => {
        const item = $('<li>');
        if (event.type === 'switch') {
            const tokenSummary = formatTokenSpan(event);
            const details = `${event.name}${event.matchKind ? ' via ' + event.matchKind : ''}, char #${event.charIndex + 1}${tokenSummary}${Number.isFinite(event.score) ? ', score ' + event.score : ''}`;
            const outfitInfo = summarizeOutfitDecision(event.outfit);
            const extra = outfitInfo ? `<br><span class="cs-tester-outfit-detail">${escapeHtml(outfitInfo)}</span>` : '';
            item.addClass('cs-tester-log-switch').html(`<b>Switch → ${escapeHtml(event.folder)}</b><small> (${escapeHtml(details)})${extra}</small>`);
        } else if (event.type === 'veto') {
            item.addClass('cs-tester-log-veto').html(`<b>Veto Triggered</b><small> (${event.match})</small>`);
        } else {
            const skipDetails = `${event.matchKind}, ${describeSkipReason(event.reason)}`;
            const outfitInfo = summarizeOutfitDecision(event.outfit);
            const extra = outfitInfo ? `<br><span class="cs-tester-outfit-detail">${escapeHtml(outfitInfo)}</span>` : '';
            const tokenSummary = formatTokenSpan(event);
            item.addClass('cs-tester-log-skip').html(`<span>${escapeHtml(event.name)}</span><small> (${escapeHtml(skipDetails)}${tokenSummary})${extra}</small>`);
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



async function testRegexPattern() {
    clearTesterTimers();
    state.lastTesterReport = null;
    updateTesterCopyButton();
    updateTesterTopCharactersDisplay(null);
    updateTesterPreprocessedDisplay(null);
    state.lastPreprocessorScripts = [];
    renderTesterPreprocessorMeta({ scripts: [] });
    $("#cs-test-veto-result").text('N/A').css('color', 'var(--text-color-soft)');
    renderTesterScoreBreakdown(null);
    renderTesterRosterTimeline(null, null);
    renderCoverageDiagnostics(null);
    clearLiveTesterOutputs();
    requestScenePanelRender("tester-reset", { immediate: true, source: "tester" });
    const text = $("#cs-regex-test-input").val();
    if (!text) {
        $("#cs-test-all-detections, #cs-test-winner-list").html('<li class="cs-tester-list-placeholder">Enter text to test.</li>');
        updateTesterTopCharactersDisplay(null);
        updateSkipReasonSummaryDisplay([]);
        updateTesterPreprocessedDisplay(null);
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

    const coverage = await analyzeCoverageDiagnostics(combined, tempProfile);

    if (state.compiledRegexes.vetoRegex && state.compiledRegexes.vetoRegex.test(combined)) {
        const vetoMatch = combined.match(state.compiledRegexes.vetoRegex)?.[0] || 'unknown veto phrase';
        const recordedVeto = recordLastVetoMatch(vetoMatch, { source: 'tester', persist: false });
        showStatus(`Detection halted. Veto phrase <b>${escapeHtml(recordedVeto.phrase)}</b> matched in tester.`, 'error', 5000);
        $("#cs-test-veto-result").html(`Vetoed by: <b style="color: var(--red);">${vetoMatch}</b>`);
        allDetectionsList.html('<li class="cs-tester-list-placeholder">Message vetoed.</li>');
        const vetoEvents = [{ type: 'veto', match: vetoMatch, charIndex: combined.length - 1 }];
        state.lastPreprocessedText = combined;
        updateTesterPreprocessedDisplay(combined);
        renderTesterStream(streamList, vetoEvents);
        updateSkipReasonSummaryDisplay(vetoEvents);
        renderTesterScoreBreakdown([]);
        renderTesterRosterTimeline([], []);
        renderCoverageDiagnostics(coverage);
        replaceLiveTesterOutputs(vetoEvents, { roster: [], preprocessedText: state.lastPreprocessedText });
        requestScenePanelRender("tester-veto", { source: "tester" });
        const skipSummary = summarizeSkipReasonsForReport(vetoEvents);
        state.lastTesterReport = {
            ...reportBase,
            vetoed: true,
            vetoMatch,
            events: vetoEvents,
            matches: [],
            topCharacters: [],
            rosterTimeline: [],
            rosterWarnings: [],
            scoreDetails: [],
            coverage,
            skipSummary,
            preprocessedText: state.lastPreprocessedText,
            preprocessorScripts: clonePreprocessorScripts(state.lastPreprocessorScripts),
        };
        updateTesterTopCharactersDisplay([]);
        updateTesterCopyButton();
    } else {
        $("#cs-test-veto-result").text('No veto phrases matched.').css('color', 'var(--green)');

        const allMatches = findAllMatches(combined).sort((a, b) => a.matchIndex - b.matchIndex);
        const preprocessedSnapshot = typeof state.lastPreprocessedText === "string"
            ? state.lastPreprocessedText
            : combined;
        const scriptSnapshot = clonePreprocessorScripts(state.lastPreprocessorScripts);
        renderTesterPreprocessorMeta({ scripts: scriptSnapshot });
        updateTesterPreprocessedDisplay(preprocessedSnapshot);
        allDetectionsList.empty();
        if (allMatches.length > 0) {
            allMatches.forEach(m => {
                const charPos = Number.isFinite(m.matchIndex) ? m.matchIndex + 1 : '?';
                const priorityLabel = Number.isFinite(m.priority) ? m.priority : 'n/a';
                let resolutionNote = '';
                if (m.nameResolution?.changed) {
                    const rawSource = m.nameResolution.raw || m.rawName || m.originalName || m.name;
                    const methodLabel = m.nameResolution.method || 'normalized';
                    const safeRaw = typeof rawSource === 'string' && rawSource.trim()
                        ? rawSource.trim()
                        : 'unknown';
                    resolutionNote = ` <span class="cs-detection-note">→ normalized from ‘${escapeHtml(safeRaw)}’ via ${escapeHtml(methodLabel)}</span>`;
                }
                allDetectionsList.append(`<li><b>${escapeHtml(m.name)}</b> <small>(${escapeHtml(m.matchKind)} @ ${charPos}, p:${priorityLabel})</small>${resolutionNote}</li>`);
            });
        } else {
            allDetectionsList.html('<li class="cs-tester-list-placeholder">No detections found.</li>');
        }

        resetTesterMessageState();
        const simulationResult = simulateTesterStream(combined, tempProfile, bufKey, {
            preprocessedText: preprocessedSnapshot,
        });
        const events = Array.isArray(simulationResult?.events) ? simulationResult.events : [];
        renderTesterStream(streamList, events);
        updateSkipReasonSummaryDisplay(events);
        updateTesterPreprocessedDisplay(preprocessedSnapshot);
        const testerRoster = simulationResult?.finalState?.sceneRoster || [];
        const topCharacters = rankSceneCharacters(allMatches, {
            rosterSet: testerRoster,
            profile: tempProfile,
            distancePenaltyWeight: resolveNumericSetting(tempProfile?.distancePenaltyWeight, PROFILE_DEFAULTS.distancePenaltyWeight),
            rosterBonus: resolveNumericSetting(tempProfile?.rosterBonus, PROFILE_DEFAULTS.rosterBonus),
            priorityMultiplier: 100,
            tokenLength: Number.isFinite(allMatches?.tokenCount) ? allMatches.tokenCount : null,
        });
        const detailedScores = scoreMatchesDetailed(allMatches, combined.length, {
            rosterSet: testerRoster,
            profile: tempProfile,
            distancePenaltyWeight: resolveNumericSetting(tempProfile?.distancePenaltyWeight, PROFILE_DEFAULTS.distancePenaltyWeight),
            rosterBonus: resolveNumericSetting(tempProfile?.rosterBonus, PROFILE_DEFAULTS.rosterBonus),
            rosterPriorityDropoff: resolveNumericSetting(tempProfile?.rosterPriorityDropoff, PROFILE_DEFAULTS.rosterPriorityDropoff),
            priorityMultiplier: 100,
            tokenLength: Number.isFinite(allMatches?.tokenCount) ? allMatches.tokenCount : null,
        });
        renderTesterScoreBreakdown(detailedScores);
        renderTesterRosterTimeline(simulationResult?.rosterTimeline || [], simulationResult?.rosterWarnings || []);
        renderCoverageDiagnostics(coverage);
        updateTesterTopCharactersDisplay(topCharacters);
        state.lastPreprocessedText = preprocessedSnapshot;
        state.lastPreprocessorScripts = clonePreprocessorScripts(scriptSnapshot);

        state.lastTesterReport = {
            ...reportBase,
            vetoed: false,
            vetoMatch: null,
            matches: allMatches.map(m => ({ ...m })),
            events: events.map(e => ({ ...e })),
            skipSummary: summarizeSkipReasonsForReport(events),
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
            preprocessedText: preprocessedSnapshot,
            preprocessorScripts: clonePreprocessorScripts(scriptSnapshot),
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
    const panelSettings = ensureScenePanelSettings(settings);
    updateScenePanelSettingControls(panelSettings);
    initTabNavigation();
    Object.entries(uiMapping).forEach(([key, mapping]) => {
        const selector = mapping?.selector;
        if (!selector) {
            return;
        }
        $(document).on('change', selector, (event) => handleAutoSaveFieldEvent(event, key));
        if (['text', 'textarea', 'csvTextarea', 'number', 'range', 'optionalNumber'].includes(mapping.type)) {
            $(document).on('input', selector, (event) => handleAutoSaveFieldEvent(event, key));
        }
    });
    $(document).on('change', '.cs-script-collection-toggle', handleScriptCollectionCheckboxChange);
    $(document).on('focusin mouseenter', '[data-change-notice]', function () {
        if (this?.disabled) {
            return;
        }
        announceAutoSaveIntent(this, null, this.dataset.changeNotice, this.dataset.changeNoticeKey);
    });
    $(document).on('click', '.cs-script-entry__expand', function () {
        const item = $(this).closest('.cs-script-entry');
        if (!item.length) {
            return;
        }
        const expanded = !item.hasClass('is-expanded');
        item.toggleClass('is-expanded', expanded);
        $(this).attr('aria-expanded', expanded ? 'true' : 'false');
        $(this).text(expanded ? 'Hide Details' : 'Show Details');
    });
    $(document).on('click', '.cs-script-entry__copy', function () {
        if (this?.disabled) {
            return;
        }
        const description = $(this).data('description');
        if (!description) {
            return;
        }
        copyTextToClipboard(description)
            .then(() => showStatus('Script description copied.', 'success'))
            .catch(() => showStatus('Unable to copy script description.', 'error'));
    });

    $(document).on('input', '#cs-pattern-search', function () {
        state.patternSearchQuery = String($(this).val() ?? "");
        const profile = getActiveProfile();
        renderPatternEditor(profile);
    });

    $(document).on('keydown', '#cs-pattern-search', function (event) {
        if (event.key === "Escape" && $(this).val()) {
            event.preventDefault();
            $(this).val("");
            state.patternSearchQuery = "";
            const profile = getActiveProfile();
            renderPatternEditor(profile);
        }
    });

    $(document).on('change', '#cs-enable', function () {
        const enabled = $(this).prop('checked');
        announceAutoSaveIntent(this, null, `Extension will ${enabled ? 'enable' : 'disable'} immediately.`, 'cs-enable');
        settings.enabled = enabled;
        persistSettings('Extension ' + (enabled ? 'Enabled' : 'Disabled'), 'info');
    });
    $(document).on('change', '#cs-scene-panel-enable', function () {
        const enabled = $(this).prop('checked');
        const notice = this?.dataset?.changeNotice
            || `Scene panel will ${enabled ? 'appear next to chat.' : 'hide until re-enabled.'}`;
        announceAutoSaveIntent(this, null, notice, 'cs-scene-panel-enable');
        applyScenePanelEnabledSetting(enabled, {
            message: enabled ? 'Scene panel enabled.' : 'Scene panel hidden.',
        });
    });
    $(document).on('change', '#cs-scene-auto-open', function () {
        const autoOpen = $(this).prop('checked');
        const notice = this?.dataset?.changeNotice
            || `Scene panel will ${autoOpen ? 'auto-open' : 'remain collapsed'} when streaming starts.`;
        announceAutoSaveIntent(this, null, notice, 'cs-scene-auto-open');
        applyScenePanelAutoOpenOnStreamSetting(autoOpen, {
            message: autoOpen
                ? 'Scene panel auto-open enabled.'
                : 'Scene panel auto-open disabled.',
        });
    });
    $(document).on('change', '#cs-scene-auto-open-results', function () {
        const autoOpen = $(this).prop('checked');
        const notice = this?.dataset?.changeNotice
            || `Scene panel will ${autoOpen ? 'pop open' : 'stay collapsed'} when new results are captured.`;
        announceAutoSaveIntent(this, null, notice, 'cs-scene-auto-open-results');
        applyScenePanelAutoOpenResultsSetting(autoOpen, {
            message: autoOpen
                ? 'Scene panel will auto-open on new results.'
                : 'Scene panel will stay collapsed after new results.',
        });
    });
    $(document).on('change', '#cs-scene-section-roster', function () {
        const visible = $(this).prop('checked');
        const notice = this?.dataset?.changeNotice
            || `Scene roster section will ${visible ? 'be shown' : 'be hidden'} in the panel.`;
        announceAutoSaveIntent(this, null, notice, 'cs-scene-section-roster');
        applyScenePanelSectionSetting('roster', visible, {
            message: visible ? 'Scene roster section enabled.' : 'Scene roster section hidden.',
        });
    });
    $(document).on('change', '#cs-scene-section-active', function () {
        const visible = $(this).prop('checked');
        const notice = this?.dataset?.changeNotice
            || `Active characters section will ${visible ? 'be shown' : 'be hidden'} in the panel.`;
        announceAutoSaveIntent(this, null, notice, 'cs-scene-section-active');
        applyScenePanelSectionSetting('activeCharacters', visible, {
            message: visible ? 'Active characters section enabled.' : 'Active characters section hidden.',
        });
    });
    $(document).on('change', '#cs-scene-section-log', function () {
        const visible = $(this).prop('checked');
        const notice = this?.dataset?.changeNotice
            || `Live log section will ${visible ? 'be shown' : 'be hidden'} in the panel.`;
        announceAutoSaveIntent(this, null, notice, 'cs-scene-section-log');
        applyScenePanelSectionSetting('liveLog', visible, {
            message: visible ? 'Live log section enabled.' : 'Live log section hidden.',
        });
    });
    $(document).on('change', '#cs-scene-section-coverage', function () {
        const visible = $(this).prop('checked');
        const notice = this?.dataset?.changeNotice
            || `Coverage suggestions will ${visible ? 'be shown' : 'be hidden'} in the panel.`;
        announceAutoSaveIntent(this, null, notice, 'cs-scene-section-coverage');
        applyScenePanelSectionSetting('coverage', visible, {
            message: visible ? 'Coverage suggestions section enabled.' : 'Coverage suggestions section hidden.',
        });
    });
    $(document).on('change', '#cs-scene-show-avatars', function () {
        const showAvatars = $(this).prop('checked');
        const notice = this?.dataset?.changeNotice
            || `Roster avatars will ${showAvatars ? 'be shown' : 'be hidden'} in the scene panel.`;
        announceAutoSaveIntent(this, null, notice, 'cs-scene-show-avatars');
        applyScenePanelShowAvatarsSetting(showAvatars, {
            message: showAvatars ? 'Roster avatars enabled.' : 'Roster avatars hidden.',
        });
    });
    $(document).on('change', '#cs-scene-auto-pin', function () {
        const enabled = $(this).prop('checked');
        const notice = this?.dataset?.changeNotice
            || `Top active character will ${enabled ? 'stay highlighted' : 'no longer be highlighted'} in the panel.`;
        announceAutoSaveIntent(this, null, notice, 'cs-scene-auto-pin');
        applyScenePanelAutoPinSetting(enabled, {
            message: enabled ? 'Auto-pin highlight enabled.' : 'Auto-pin highlight disabled.',
        });
    });
    $(document).on('click', '#cs-scene-panel-summon', function (event) {
        event.preventDefault();
        const scenePanelSettings = ensureScenePanelSettings(settings);
        const isEnabled = scenePanelSettings.enabled !== false;
        if (isEnabled) {
            applyScenePanelEnabledSetting(false, {
                message: 'Scene panel hidden.',
            });
        } else {
            setScenePanelCollapsed(false);
            applyScenePanelEnabledSetting(true, {
                message: 'Scene panel enabled.',
            });
        }
    });
    $(document).on('click', '#cs-scene-panel-toggle', function (event) {
        event.preventDefault();
        const scenePanelSettings = ensureScenePanelSettings(settings);
        const next = !scenePanelSettings.enabled;
        applyScenePanelEnabledSetting(next, {
            message: next ? 'Scene panel enabled.' : 'Scene panel hidden.',
        });
    });
    $(document).on('click', '#cs-scene-section-toggle-roster', function (event) {
        event.preventDefault();
        const scenePanelSettings = ensureScenePanelSettings(settings);
        const current = scenePanelSettings.sections?.roster !== false;
        const next = !current;
        applyScenePanelSectionSetting('roster', next, {
            message: next ? 'Scene roster section enabled.' : 'Scene roster section hidden.',
        });
    });
    $(document).on('click', '#cs-scene-section-toggle-active', function (event) {
        event.preventDefault();
        const scenePanelSettings = ensureScenePanelSettings(settings);
        const current = scenePanelSettings.sections?.activeCharacters !== false;
        const next = !current;
        applyScenePanelSectionSetting('activeCharacters', next, {
            message: next ? 'Active characters section enabled.' : 'Active characters section hidden.',
        });
    });
    $(document).on('click', '#cs-scene-section-toggle-log', function (event) {
        event.preventDefault();
        const scenePanelSettings = ensureScenePanelSettings(settings);
        const current = scenePanelSettings.sections?.liveLog !== false;
        const next = !current;
        applyScenePanelSectionSetting('liveLog', next, {
            message: next ? 'Live log section enabled.' : 'Live log section hidden.',
        });
    });
    $(document).on('click', '#cs-scene-section-toggle-coverage', function (event) {
        event.preventDefault();
        const scenePanelSettings = ensureScenePanelSettings(settings);
        const current = scenePanelSettings.sections?.coverage !== false;
        const next = !current;
        applyScenePanelSectionSetting('coverage', next, {
            message: next ? 'Coverage suggestions section enabled.' : 'Coverage suggestions section hidden.',
        });
    });
    $(document).on('click', '#cs-scene-panel-toggle-auto-open', function (event) {
        event.preventDefault();
        const scenePanelSettings = ensureScenePanelSettings(settings);
        const next = !scenePanelSettings.autoOpenOnResults;
        applyScenePanelAutoOpenResultsSetting(next, {
            message: next
                ? 'Scene panel will auto-open on new results.'
                : 'Scene panel will stay collapsed after new results.',
        });
    });
    $(document).on('click', '#cs-scene-panel-settings-open-extension', function (event) {
        event.preventDefault();
        if (openExtensionSettingsView()) {
            showStatus('Opening Character Visuals settings…', 'info');
            // toastr.info('Opening Costume Switcher settings…');
            $('#costume-switcher-settings').slideDown(200, "swing");
            showStatus('Open the Extensions drawer to access the full Character Visuals settings.', 'warning');
        }
    });
    $(document).on('click', '#cs-scene-manage-roster', handleScenePanelManageRoster);
    $(document).on('click', '#cs-scene-clear-roster', handleScenePanelClearRoster);
    $(document).on('click', '#cs-scene-refresh', handleScenePanelRefresh);
    $(document).on('click', '#cs-scene-focus-toggle', handleScenePanelFocusToggle);
    $(document).on('click', '#cs-scene-log-expand', handleScenePanelExpandLog);
    $(document).on('click', '#cs-scene-log-copy', handleScenePanelCopyLog);
    $(document).on('click', '#cs-scene-open-settings', handleScenePanelOpenSettings);
    $(document).on('submit', '#cs-scene-manager-form', handleSceneManagerSubmit);
    $(document).on('click', '.cs-scene-manager__toggle', handleSceneManagerToggle);
    $(document).on('click', '.cs-scene-manager__remove', handleSceneManagerRemove);
    $(document).on('click', '[data-scene-panel="close-layer"]', () => closeScenePanelLayer());
    $(document).on('click', '#cs-scene-panel-layer', function (event) {
        if (event.target === this) {
            closeScenePanelLayer();
        }
    });
    $(document).on('keydown', function (event) {
        if (event.key === "Escape" && isScenePanelLayerOpen()) {
            closeScenePanelLayer();
        }
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
    $(document).on('change', '#cs-profile-select', function () {
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
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify({ name: settings.activeProfile, data: getActiveProfile() }, null, 2));
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
    $(document).on('change', '#cs-profile-file-input', function (event) {
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
    $(document).on('change', '#cs-preset-select', function () {
        const presetKey = $(this).val();
        const descriptionEl = $("#cs-preset-description");
        if (presetKey && PRESETS[presetKey]) {
            descriptionEl.text(PRESETS[presetKey].description);
        } else {
            descriptionEl.text("Load a recommended configuration into the current profile.");
        }
    });
    $(document).on('change', '#cs-score-preset-select', function () {
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
    $(document).on('click', '.cs-coverage-pill', function () {
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
            requestScenePanelRender("coverage-pill", { immediate: true });
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
    $(document).on('input', '#cs-detection-bias', function () { $("#cs-detection-bias-value").text($(this).val()); });
    $(document).on('click', '#cs-reset', manualReset);
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
        const newIndex = profile.mappings.length - 1;
        renderMappings(profile);
        rebuildMappingLookup(profile);
        if (newIndex >= 0) {
            const addedMapping = profile.mappings[newIndex];
            const cardId = ensureMappingCardId(addedMapping);
            if (cardId && state?.draftMappingIds instanceof Set) {
                state.draftMappingIds.add(cardId);
            }
        }
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
    $(document).on('click', '#cs-regex-test-button', testRegexPattern);
    $(document).on('click', '#cs-regex-test-copy', copyTesterReport);
    $(document).on('click', '#cs-stats-log', logLastMessageStats);

    if (typeof window !== "undefined") {
        state.autoSaveCleanup = registerAutoSaveGuards({
            flushFn: flushScheduledProfileAutoSave,
            target: window,
        });
    }

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

function isLikelyMessageKey(candidate) {
    if (candidate == null) {
        return false;
    }

    const normalized = typeof candidate === "string"
        ? (normalizeMessageKey(candidate) || candidate.trim())
        : normalizeMessageKey(candidate);

    if (typeof normalized !== "string" || !normalized) {
        return false;
    }

    if (/^m\d+$/.test(normalized)) {
        return true;
    }

    if (normalized.toLowerCase().startsWith("tester:")) {
        return true;
    }

    return false;
}

function extractSceneMessageDigest(message) {
    if (!message || typeof message !== "object") {
        return null;
    }

    const parts = [];

    const pushValue = (label, value) => {
        if (value == null) {
            return;
        }
        if (typeof value === "number" && !Number.isFinite(value)) {
            return;
        }
        if (typeof value === "string") {
            const trimmed = value.trim();
            if (!trimmed) {
                return;
            }
            parts.push(`${label}:${trimmed}`);
            return;
        }
        parts.push(`${label}:${value}`);
    };

    const pushNumber = (label, value) => {
        if (Number.isFinite(value)) {
            parts.push(`${label}:${value}`);
        }
    };

    pushValue("chat", message.chat_id ?? message.chatId ?? message.conversation_id ?? message.conversationId ?? message.cid ?? null);
    pushNumber("character", message.character_id ?? message.characterId ?? message.chid);
    pushNumber("id", message.mesId);
    pushNumber("swipe", message.swipe_id);

    const textSource = typeof message.mes === "string" && message.mes.length
        ? message.mes
        : (typeof message.text === "string" ? message.text : "");
    if (textSource) {
        const slice = textSource.length > 64 ? textSource.slice(-64) : textSource;
        pushValue("text", `${slice.length}:${slice}`);
    }

    const resolveTimestamp = () => {
        if (Number.isFinite(message.updatedAt)) return message.updatedAt;
        if (Number.isFinite(message.lastModified)) return message.lastModified;
        if (Number.isFinite(message.timestamp)) return message.timestamp;
        if (message.extra && typeof message.extra === "object") {
            const extra = message.extra;
            if (Number.isFinite(extra.updatedAt)) return extra.updatedAt;
            if (Number.isFinite(extra.last_update)) return extra.last_update;
            if (Number.isFinite(extra.lastUpdated)) return extra.lastUpdated;
        }
        return null;
    };

    const timestamp = resolveTimestamp();
    if (timestamp != null) {
        parts.push(`ts:${timestamp}`);
    }

    return parts.length ? parts.join("|") : null;
}

function deriveSceneDigestFromText(text) {
    if (typeof text !== "string") {
        return null;
    }
    const trimmed = text.trim();
    if (!trimmed) {
        return null;
    }
    const slice = trimmed.length > 64 ? trimmed.slice(-64) : trimmed;
    return `text:${slice.length}:${slice}`;
}

function extractMessageIdFromKey(key) {
    const normalized = normalizeMessageKey(key);
    if (!normalized) return null;
    const match = normalized.match(/^m(\d+)$/);
    return match ? Number(match[1]) : null;
}

function resolveMessageIdFromTimestamp(value) {
    if (Number.isFinite(value)) {
        return value;
    }
    if (value instanceof Date) {
        const timestamp = value.getTime();
        return Number.isFinite(timestamp) ? timestamp : null;
    }
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function parseMessageReference(input, seen = null) {
    let key = null;
    let messageId = null;
    const visited = seen instanceof WeakSet ? seen : new WeakSet();

    const commitKey = (candidate) => {
        const normalized = normalizeMessageKey(candidate);
        if (!normalized) return;
        if (!isLikelyMessageKey(normalized)) return;
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
    } else if (Array.isArray(input)) {
        if (visited.has(input)) {
            return { key: null, messageId: null };
        }
        visited.add(input);
        for (const entry of input) {
            const nested = parseMessageReference(entry, visited);
            if (!key && nested.key) {
                key = nested.key;
            }
            if (messageId == null && nested.messageId != null) {
                messageId = nested.messageId;
            }
            if (key && messageId != null) {
                break;
            }
        }
    } else if (typeof input === 'object') {
        if (visited.has(input)) {
            return { key: null, messageId: null };
        }
        visited.add(input);
        if (Number.isFinite(input.messageId)) commitId(input.messageId);
        if (Number.isFinite(input.mesId)) commitId(input.mesId);
        if (Number.isFinite(input.id)) commitId(input.id);
        if (Number.isFinite(input.message_id)) commitId(input.message_id);
        if (typeof input.messageId === 'string') commitKey(input.messageId);
        if (typeof input.mesId === 'string') commitKey(input.mesId);
        if (typeof input.id === 'string') commitKey(input.id);
        if (typeof input.message_id === 'string') commitKey(input.message_id);
        if (typeof input.key === 'string') commitKey(input.key);
        if (typeof input.bufKey === 'string') commitKey(input.bufKey);
        if (typeof input.messageKey === 'string') commitKey(input.messageKey);
        if (typeof input.generationType === 'string') commitKey(input.generationType);
        if (input.extra && typeof input.extra === "object") {
            const extra = input.extra;
            if (Number.isFinite(extra.messageId)) commitId(extra.messageId);
            if (Number.isFinite(extra.message_id)) commitId(extra.message_id);
            if (Number.isFinite(extra.mesId)) commitId(extra.mesId);
            if (Number.isFinite(extra.id)) commitId(extra.id);
            if (typeof extra.messageId === "string") commitKey(extra.messageId);
            if (typeof extra.message_id === "string") commitKey(extra.message_id);
            if (typeof extra.mesId === "string") commitKey(extra.mesId);
            if (typeof extra.id === "string") commitKey(extra.id);
            if (typeof extra.message_key === "string") commitKey(extra.message_key);
            if (typeof extra.messageKey === "string") commitKey(extra.messageKey);
            if (typeof extra.key === "string") commitKey(extra.key);
        }
        if (messageId == null) {
            const timestampId = resolveMessageIdFromTimestamp(input.send_date)
                ?? resolveMessageIdFromTimestamp(input.gen_started)
                ?? resolveMessageIdFromTimestamp(input.gen_finished);
            if (timestampId != null) {
                commitId(timestampId);
            }
        }
        if (typeof input.message === 'object' && input.message !== null) {
            const nested = parseMessageReference(input.message, visited);
            if (!key && nested.key) key = nested.key;
            if (messageId == null && nested.messageId != null) messageId = nested.messageId;
        }
        if (Array.isArray(input.messages)) {
            for (const entry of input.messages) {
                const nested = parseMessageReference(entry, visited);
                if (!key && nested.key) {
                    key = nested.key;
                }
                if (messageId == null && nested.messageId != null) {
                    messageId = nested.messageId;
                }
                if (key && messageId != null) {
                    break;
                }
            }
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

function createDetectionContext(bufferOffset = 0) {
    const offset = Number.isFinite(bufferOffset) ? Math.max(0, Math.floor(bufferOffset)) : 0;
    return {
        lastProcessedAbsolute: offset - 1,
        quoteState: {
            ranges: [],
            stack: [],
            windowOffset: offset,
            lastIndex: offset - 1,
        },
        matchCache: {
            matches: [],
            processedAbsolute: offset - 1,
            windowOffset: offset,
            tokenCount: null,
            tokenizerId: null,
            minTokenIndex: null,
        },
        metrics: {
            incrementalRuns: 0,
            incrementalChars: 0,
            fullRuns: 0,
            fullChars: 0,
        },
    };
}

function ensureDetectionContext(msgState, bufferOffset = 0) {
    if (!msgState || typeof msgState !== "object") {
        return null;
    }
    const offset = Number.isFinite(bufferOffset) ? Math.max(0, Math.floor(bufferOffset)) : 0;
    if (!msgState.detectionContext || typeof msgState.detectionContext !== "object") {
        msgState.detectionContext = createDetectionContext(offset);
        return msgState.detectionContext;
    }

    const context = msgState.detectionContext;

    if (!context.quoteState || typeof context.quoteState !== "object") {
        context.quoteState = createDetectionContext(offset).quoteState;
    }
    if (!Array.isArray(context.quoteState.ranges)) {
        context.quoteState.ranges = [];
    }
    if (!Array.isArray(context.quoteState.stack)) {
        context.quoteState.stack = [];
    }
    context.quoteState.windowOffset = Number.isFinite(context.quoteState.windowOffset)
        ? Math.max(0, Math.floor(context.quoteState.windowOffset))
        : offset;
    if (!Number.isFinite(context.quoteState.lastIndex)) {
        context.quoteState.lastIndex = context.quoteState.windowOffset - 1;
    }

    if (!context.matchCache || typeof context.matchCache !== "object") {
        context.matchCache = createDetectionContext(offset).matchCache;
    }
    if (!Array.isArray(context.matchCache.matches)) {
        context.matchCache.matches = [];
    }
    context.matchCache.windowOffset = Number.isFinite(context.matchCache.windowOffset)
        ? Math.max(0, Math.floor(context.matchCache.windowOffset))
        : offset;
    if (!Number.isFinite(context.matchCache.processedAbsolute)) {
        context.matchCache.processedAbsolute = context.matchCache.windowOffset - 1;
    }

    if (!context.metrics || typeof context.metrics !== "object") {
        context.metrics = createDetectionContext(offset).metrics;
    }
    const metrics = context.metrics;
    if (!Number.isFinite(metrics.incrementalRuns)) {
        metrics.incrementalRuns = 0;
    }
    if (!Number.isFinite(metrics.incrementalChars)) {
        metrics.incrementalChars = 0;
    }
    if (!Number.isFinite(metrics.fullRuns)) {
        metrics.fullRuns = 0;
    }
    if (!Number.isFinite(metrics.fullChars)) {
        metrics.fullChars = 0;
    }
    if (!Number.isFinite(context.lastProcessedAbsolute)) {
        context.lastProcessedAbsolute = context.matchCache.processedAbsolute;
    }

    return context;
}

function shiftDetectionContext(msgState, newBufferOffset) {
    const context = ensureDetectionContext(msgState, newBufferOffset);
    if (!context) {
        return;
    }
    const offset = Number.isFinite(newBufferOffset) ? Math.max(0, Math.floor(newBufferOffset)) : 0;

    if (context.matchCache && Array.isArray(context.matchCache.matches)) {
        context.matchCache.matches = context.matchCache.matches.filter((match) => {
            if (!match || !Number.isFinite(match.absoluteIndex)) {
                return true;
            }
            return match.absoluteIndex >= offset;
        });
        if (!Number.isFinite(context.matchCache.processedAbsolute) || context.matchCache.processedAbsolute < offset - 1) {
            context.matchCache.processedAbsolute = offset - 1;
        }
        context.matchCache.windowOffset = offset;
    }

    if (context.quoteState) {
        if (!Array.isArray(context.quoteState.ranges)) {
            context.quoteState.ranges = [];
        } else {
            context.quoteState.ranges = context.quoteState.ranges.filter((range) => {
                if (!Array.isArray(range) || range.length < 2) {
                    return false;
                }
                const [, end] = range;
                return Number.isFinite(end) ? end >= offset : true;
            });
        }
        if (!Array.isArray(context.quoteState.stack)) {
            context.quoteState.stack = [];
        } else {
            context.quoteState.stack = context.quoteState.stack.filter((frame) => {
                if (!frame || !Number.isFinite(frame.index)) {
                    return false;
                }
                return frame.index >= offset;
            });
        }
        context.quoteState.windowOffset = offset;
        if (!Number.isFinite(context.quoteState.lastIndex) || context.quoteState.lastIndex < offset - 1) {
            context.quoteState.lastIndex = offset - 1;
        }
    }

    if (!Number.isFinite(context.lastProcessedAbsolute) || context.lastProcessedAbsolute < offset - 1) {
        context.lastProcessedAbsolute = offset - 1;
    }
}

function ensureMatchCache(normalizedKey, messageState = null) {
    if (!(state.messageMatches instanceof Map)) {
        state.messageMatches = new Map();
    }

    if (messageState) {
        const context = ensureDetectionContext(messageState, messageState.bufferOffset || 0);
        if (context?.matchCache) {
            state.messageMatches.set(normalizedKey, context.matchCache);
            return context.matchCache;
        }
    }

    let cache = state.messageMatches.get(normalizedKey);
    if (!cache || typeof cache !== "object" || !Array.isArray(cache.matches)) {
        const fallbackContext = createDetectionContext(0);
        cache = fallbackContext.matchCache;
        state.messageMatches.set(normalizedKey, cache);
    }
    return cache;
}

function normalizeMatchForCache(match, bufferOffset) {
    const matchLength = Number.isFinite(match.matchLength) && match.matchLength > 0
        ? Math.floor(match.matchLength)
        : null;
    const absoluteIndex = Number.isFinite(match.matchIndex)
        ? match.matchIndex + bufferOffset
        : null;
    const tokenIndex = Number.isFinite(match.tokenIndex)
        ? Math.floor(match.tokenIndex)
        : null;
    const tokenLength = Number.isFinite(match.tokenLength) && match.tokenLength > 0
        ? Math.floor(match.tokenLength)
        : null;
    return {
        name: match.name,
        matchKind: match.matchKind,
        matchLength,
        priority: match.priority,
        absoluteIndex,
        tokenIndex,
        tokenLength,
    };
}

function normalizeStoredMatch(match, bufferOffset = 0) {
    if (!match) {
        return null;
    }
    const matchLength = Number.isFinite(match.matchLength) && match.matchLength > 0
        ? Math.floor(match.matchLength)
        : null;
    let absoluteIndex = null;
    if (Number.isFinite(match.absoluteIndex)) {
        absoluteIndex = match.absoluteIndex;
    } else if (Number.isFinite(match.matchIndex)) {
        absoluteIndex = match.matchIndex + bufferOffset;
    }
    const tokenIndex = Number.isFinite(match.tokenIndex)
        ? Math.floor(match.tokenIndex)
        : null;
    const tokenLength = Number.isFinite(match.tokenLength) && match.tokenLength > 0
        ? Math.floor(match.tokenLength)
        : null;
    return {
        name: match.name,
        matchKind: match.matchKind,
        matchLength,
        priority: match.priority,
        absoluteIndex,
        tokenIndex,
        tokenLength,
    };
}

function computeAbsoluteEnd(match) {
    if (!match || !Number.isFinite(match.absoluteIndex)) {
        return null;
    }
    if (!Number.isFinite(match.matchLength) || match.matchLength <= 0) {
        return match.absoluteIndex;
    }
    return match.absoluteIndex + match.matchLength - 1;
}

function projectMatchesForBuffer(cache, bufferOffset, textLength) {
    if (!cache || !Array.isArray(cache.matches)) {
        return [];
    }
    const limit = bufferOffset + textLength;
    const projected = cache.matches
        .filter((match) => !Number.isFinite(match.absoluteIndex)
            || (match.absoluteIndex >= bufferOffset && match.absoluteIndex < limit))
        .map((match) => {
            const relativeIndex = Number.isFinite(match.absoluteIndex)
                ? match.absoluteIndex - bufferOffset
                : null;
            return {
                name: match.name,
                matchKind: match.matchKind,
                matchLength: match.matchLength,
                priority: match.priority,
                matchIndex: relativeIndex,
                absoluteIndex: match.absoluteIndex,
                tokenIndex: Number.isFinite(match.tokenIndex) ? Math.floor(match.tokenIndex) : null,
                tokenLength: Number.isFinite(match.tokenLength) && match.tokenLength > 0
                    ? Math.floor(match.tokenLength)
                    : null,
            };
        });
    projected.tokenCount = Number.isFinite(cache.tokenCount) ? cache.tokenCount : null;
    projected.tokenizerId = cache.tokenizerId || null;
    projected.minTokenIndex = Number.isFinite(cache.minTokenIndex) ? cache.minTokenIndex : null;
    return projected;
}

function areStatsEqual(previousStats, nextStats) {
    const prev = previousStats instanceof Map ? previousStats : new Map();
    const next = nextStats instanceof Map ? nextStats : new Map();
    if (prev.size !== next.size) {
        return false;
    }
    for (const [key, value] of prev.entries()) {
        if (next.get(key) !== value) {
            return false;
        }
    }
    return true;
}

function areRankingsEqual(previousRanking, nextRanking) {
    const prev = Array.isArray(previousRanking) ? previousRanking : [];
    const next = Array.isArray(nextRanking) ? nextRanking : [];
    if (prev.length !== next.length) {
        return false;
    }
    const keys = [
        "name",
        "normalized",
        "count",
        "bestPriority",
        "earliest",
        "latest",
        "inSceneRoster",
        "firstMatchKind",
        "score",
    ];
    for (let i = 0; i < prev.length; i += 1) {
        const a = prev[i] || {};
        const b = next[i] || {};
        for (const key of keys) {
            if ((a[key] ?? null) !== (b[key] ?? null)) {
                return false;
            }
        }
    }
    return true;
}

function maskQuotes(text) {
    if (!text) return text;
    // Standard quotes: split by " and mask odd segments (inside quotes)
    const parts = text.split('"');
    for (let i = 1; i < parts.length; i += 2) {
        parts[i] = " ".repeat(parts[i].length);
    }
    let masked = parts.join('"');
    // Smart quotes: replace content between “ and ” with spaces
    masked = masked.replace(/“[^”]*”/g, m => " ".repeat(m.length));
    // Open Smart Quote to end (assuming dialogue continues to EOS)
    masked = masked.replace(/“[^”]*$/g, m => " ".repeat(m.length));
    return masked;
}

function updateQuoteContext(context, text) {
    if (!context || !text) return;
    for (const char of text) {
        if (context.inQuote) {
            if (char === context.quoteChar) {
                context.inQuote = false;
                context.quoteChar = null;
            }
        } else {
            if (char === '"') {
                context.inQuote = true;
                context.quoteChar = '"'; // Standard toggle
            } else if (char === '“') {
                context.inQuote = true;
                context.quoteChar = '”'; // Smart open -> close
            }
        }
    }
}

function maskQuotesWithContext(text, context) {
    if (!text) return text;
    let inQuote = context?.inQuote || false;
    let quoteChar = context?.quoteChar || null;
    let chars = text.split('');

    for (let i = 0; i < chars.length; i++) {
        const char = chars[i];
        if (inQuote) {
            if (char === quoteChar) {
                inQuote = false;
                quoteChar = null;
                chars[i] = ' '; // Mask closer too? Yes for safety
            } else {
                chars[i] = ' ';
            }
        } else {
            if (char === '"') {
                inQuote = true;
                quoteChar = '"';
                chars[i] = ' ';
            } else if (char === '“') {
                inQuote = true;
                quoteChar = '”';
                chars[i] = ' ';
            }
        }
    }
    return chars.join('');
}

function isMatchInsideQuote(text, match, quoteContext) {
    if (!text || !match || !Number.isFinite(match.matchIndex)) return false;

    // Create a temporary context copy to not mutate the real state during this check
    // Actually, we pass the *starting* state of the buffer.
    const tempContext = { inQuote: quoteContext?.inQuote || false, quoteChar: quoteContext?.quoteChar || null };

    // We only need to mask up to the match end
    const matchEnd = match.matchIndex + (match.matchLength || 0);
    const segment = text.slice(0, matchEnd);
    const masked = maskQuotesWithContext(segment, tempContext);

    // Check if the match content is masked (space)
    // We check the middle of the match to avoid edge cases with adjacent quotes
    const checkPos = match.matchIndex + Math.floor((match.matchLength || 1) / 2);

    // Since we sliced to matchEnd, checkPos is safe.
    return masked[checkPos] === ' ';
}

function updateMessageAnalytics(bufKey, text, options = {}) {
    const {
        rosterSet,
        updateSession = true,
        assumeNormalized = false,
        bufferOffset: explicitBufferOffset = 0,
        incremental = false,
        startIndex = null,
        previousProcessedAbsolute = null,
        messageState = null,
    } = options;

    const normalizedKey = bufKey ? (normalizeMessageKey(bufKey) || bufKey) : bufKey;
    if (!normalizedKey) {
        return { stats: new Map(), ranking: [] };
    }

    if (!(state.messageStats instanceof Map)) {
        state.messageStats = new Map();
    }

    if (!(state.topSceneRanking instanceof Map)) {
        state.topSceneRanking = new Map();
    }

    let normalizedText = typeof text === "string" ? (assumeNormalized ? text : normalizeStreamText(text)) : "";

    // FIX #4: Mask out reasoning/thinking blocks to prevent detection spam
    // We replace content with spaces to preserve indices for consistency.
    if (normalizedText) {
        normalizedText = normalizedText.replace(
            /<(think|reasoning)>[\s\S]*?(<\/\1>|$)/gi,
            (match) => " ".repeat(match.length)
        );
    }

    const profile = getActiveProfile();
    const bufferOffset = Number.isFinite(explicitBufferOffset) ? Math.max(0, Math.floor(explicitBufferOffset)) : 0;
    const context = messageState ? ensureDetectionContext(messageState, bufferOffset) : null;
    const cache = ensureMatchCache(normalizedKey, messageState);

    const textLength = normalizedText.length;
    const explicitMinIndex = Number.isFinite(options?.minIndex) && options.minIndex >= 0
        ? Math.max(0, Math.floor(options.minIndex))
        : null;

    if (!incremental || !context) {
        const detectionOptions = {};
        if (explicitMinIndex != null) {
            detectionOptions.minIndex = explicitMinIndex;
        }
        if (messageState) {
            detectionOptions.messageState = messageState;
        }
        if (context?.quoteState) {
            detectionOptions.quoteState = context.quoteState;
            detectionOptions.bufferOffset = bufferOffset;
            detectionOptions.lastIndex = context.lastProcessedAbsolute;
        }
        const matches = normalizedText
            ? findAllMatches(normalizedText, detectionOptions)
            : [];
        cache.matches = matches.map((match) => normalizeMatchForCache(match, bufferOffset));
        cache.tokenCount = Number.isFinite(matches.tokenCount) ? matches.tokenCount : null;
        cache.tokenizerId = matches.tokenizerId || null;
        cache.minTokenIndex = Number.isFinite(matches.minTokenIndex) ? matches.minTokenIndex : null;
        const absoluteTail = textLength > 0
            ? bufferOffset + textLength - 1
            : bufferOffset - 1;
        cache.processedAbsolute = absoluteTail;
        if (context) {
            context.lastProcessedAbsolute = absoluteTail;
            if (textLength > 0) {
                context.metrics.fullRuns += 1;
                context.metrics.fullChars += textLength;
            }
        }
    } else if (normalizedText) {
        const resumeRelative = Number.isFinite(context.lastProcessedAbsolute)
            ? Math.max(0, context.lastProcessedAbsolute + 1 - bufferOffset)
            : 0;
        const requestedStart = Number.isFinite(startIndex) && startIndex >= 0
            ? Math.min(Math.floor(startIndex), textLength)
            : 0;
        const relativeStart = Math.min(textLength, Math.max(resumeRelative, requestedStart));
        const effectiveMinIndex = explicitMinIndex != null
            ? Math.max(explicitMinIndex, relativeStart)
            : relativeStart;
        // NOTE: We intentionally do NOT pass startIndex here.
        // startIndex causes incremental scanning that SKIPS earlier buffer content,
        // breaking detection of characters mentioned before the processed position.
        // minIndex is sufficient to filter already-processed matches.
        const detectionOptions = {
            minIndex: effectiveMinIndex,
        };

        if (messageState) {
            detectionOptions.messageState = messageState;
        }
        if (context?.quoteState) {
            detectionOptions.quoteState = context.quoteState;
            detectionOptions.lastIndex = context.lastProcessedAbsolute;
            detectionOptions.bufferOffset = bufferOffset;
        }
        const newMatches = findAllMatches(normalizedText, detectionOptions);
        if (Number.isFinite(newMatches.tokenCount)) {
            cache.tokenCount = newMatches.tokenCount;
        }
        if (newMatches.tokenizerId) {
            cache.tokenizerId = newMatches.tokenizerId;
        }
        if (Number.isFinite(newMatches.minTokenIndex)) {
            cache.minTokenIndex = newMatches.minTokenIndex;
        }
        const processedBoundary = Number.isFinite(context.lastProcessedAbsolute)
            ? context.lastProcessedAbsolute
            : (Number.isFinite(cache.processedAbsolute)
                ? cache.processedAbsolute
                : (Number.isFinite(previousProcessedAbsolute)
                    ? previousProcessedAbsolute
                    : bufferOffset + relativeStart - 1));
        const inserted = [];
        newMatches
            .map((match) => normalizeMatchForCache(match, bufferOffset))
            .forEach((match) => {
                const absoluteEnd = computeAbsoluteEnd(match);
                if (Number.isFinite(absoluteEnd) && absoluteEnd <= processedBoundary) {
                    return;
                }
                cache.matches.push(match);
                inserted.push(match);
            });
        if (inserted.length > 0 && cache.matches.length > 1) {
            cache.matches.sort((a, b) => {
                const aIndex = Number.isFinite(a.absoluteIndex) ? a.absoluteIndex : Number.POSITIVE_INFINITY;
                const bIndex = Number.isFinite(b.absoluteIndex) ? b.absoluteIndex : Number.POSITIVE_INFINITY;
                return aIndex - bIndex;
            });
        }
        const newAbsoluteTail = textLength > 0
            ? bufferOffset + textLength - 1
            : bufferOffset - 1;
        const previousProcessed = Number.isFinite(cache.processedAbsolute)
            ? cache.processedAbsolute
            : bufferOffset - 1;
        cache.processedAbsolute = Math.max(previousProcessed, newAbsoluteTail);
        context.lastProcessedAbsolute = Math.max(
            Number.isFinite(context.lastProcessedAbsolute) ? context.lastProcessedAbsolute : newAbsoluteTail,
            newAbsoluteTail,
        );
        const scannedChars = Math.max(0, textLength - relativeStart);
        if (scannedChars > 0) {
            context.metrics.incrementalRuns += 1;
            context.metrics.incrementalChars += scannedChars;
        }
    }

    const nextStats = summarizeMatches(cache.matches);
    const previousStats = state.messageStats.get(normalizedKey);
    const statsChanged = !areStatsEqual(previousStats, nextStats);
    if (statsChanged || !(previousStats instanceof Map)) {
        state.messageStats.set(normalizedKey, nextStats);
    }

    const visibleMatches = projectMatchesForBuffer(cache, bufferOffset, textLength);

    const ranking = rankSceneCharacters(visibleMatches, {
        rosterSet,
        profile,
        distancePenaltyWeight: resolveNumericSetting(profile?.distancePenaltyWeight, PROFILE_DEFAULTS.distancePenaltyWeight),
        rosterBonus: resolveNumericSetting(profile?.rosterBonus, PROFILE_DEFAULTS.rosterBonus),
        priorityMultiplier: 100,
        tokenLength: Number.isFinite(visibleMatches?.tokenCount) ? visibleMatches.tokenCount : null,
    });
    const previousRanking = state.topSceneRanking.get(normalizedKey) || [];
    const rankingChanged = !areRankingsEqual(previousRanking, ranking);
    if (rankingChanged || !Array.isArray(previousRanking)) {
        state.topSceneRanking.set(normalizedKey, ranking);
    }

    const timestamp = Date.now();
    if (!(state.topSceneRankingUpdatedAt instanceof Map)) {
        state.topSceneRankingUpdatedAt = new Map();
    }
    if (rankingChanged) {
        state.topSceneRankingUpdatedAt.set(normalizedKey, timestamp);
        if (updateSession !== false) {
            updateSessionTopCharacters(normalizedKey, ranking, timestamp);
        } else if (state.latestTopRanking?.bufKey && normalizeMessageKey(state.latestTopRanking.bufKey) === normalizedKey) {
            state.latestTopRanking.updatedAt = timestamp;
        }
    } else if (updateSession === false && state.latestTopRanking?.bufKey && normalizeMessageKey(state.latestTopRanking.bufKey) === normalizedKey) {
        state.latestTopRanking.updatedAt = timestamp;
    }

    if (statsChanged || rankingChanged) {
        requestScenePanelRender("analytics-update");
    }

    const statsResult = statsChanged ? nextStats : (previousStats instanceof Map ? previousStats : nextStats);
    const rankingResult = rankingChanged ? ranking : previousRanking;

    return {
        stats: statsResult,
        ranking: rankingResult,
        matches: visibleMatches,
    };
}

function resolveBufferOffsetForKey(key) {
    const normalizedKey = normalizeMessageKey(key);
    if (!normalizedKey) {
        return 0;
    }
    if (state.perMessageStates instanceof Map) {
        const msgState = state.perMessageStates.get(normalizedKey);
        if (msgState && Number.isFinite(msgState.bufferOffset)) {
            return Math.max(0, Math.floor(msgState.bufferOffset));
        }
    }
    return 0;
}

function getCachedMatchesForBuffer(key, bufferLength = null) {
    const normalizedKey = normalizeMessageKey(key);
    if (!normalizedKey || !(state.messageMatches instanceof Map)) {
        return [];
    }
    const cache = state.messageMatches.get(normalizedKey);
    if (!cache) {
        return [];
    }
    const bufferOffset = resolveBufferOffsetForKey(normalizedKey);
    const length = Number.isFinite(bufferLength) && bufferLength >= 0
        ? bufferLength
        : (() => {
            if (Number.isFinite(cache.processedAbsolute)) {
                return Math.max(0, cache.processedAbsolute - bufferOffset + 1);
            }
            return 0;
        })();
    return projectMatchesForBuffer(cache, bufferOffset, length);
}

function calculateFinalMessageStats(reference) {
    const { key: requestedKey, messageId } = parseMessageReference(reference);
    const bufKey = findExistingMessageKey(requestedKey, messageId);

    if (!bufKey) {
        debugLog("Could not resolve message key to calculate stats for:", reference);
        return;
    }

    const normalizedKey = normalizeMessageKey(bufKey) || bufKey;
    trackMessageKey(normalizedKey);

    const resolvedMessageId = Number.isFinite(messageId) ? messageId : extractMessageIdFromKey(normalizedKey);

    let fullText = state.perMessageBuffers.get(normalizedKey);
    if (!fullText && requestedKey && requestedKey !== normalizedKey && state.perMessageBuffers.has(requestedKey)) {
        fullText = state.perMessageBuffers.get(requestedKey);
    }

    if (!fullText) {
        debugLog("Could not find message buffer to calculate stats for:", normalizedKey);
        const { chat } = getContext();
        if (!Number.isFinite(resolvedMessageId)) {
            debugLog("No valid message id available to fall back to chat context for key:", normalizedKey);
            return;
        }

        const message = chat.find(m => m.mesId === resolvedMessageId);
        if (!message) {
            return;
        }
        const snapshot = resolveStreamSnapshotSource(message);
        const fallbackText = typeof message.mes === "string" ? message.mes : "";
        const sourceText = snapshot || fallbackText;
        if (!sourceText) {
            return;
        }
        fullText = normalizeStreamText(sourceText);
    }

    const msgState = state.perMessageStates.get(normalizedKey);
    const rosterSet = msgState?.sceneRoster instanceof Set ? msgState.sceneRoster : null;
    updateMessageAnalytics(normalizedKey, fullText, { rosterSet, assumeNormalized: true, messageState: msgState });

    debugLog("Final stats calculated for", normalizedKey, state.messageStats.get(normalizedKey));
    requestScenePanelRender("final-stats", { immediate: true });
    maybeAutoExpandScenePanel("result");
}

function collectDecisionEventsForKey(bufKey) {
    const normalizedKey = normalizeMessageKey(bufKey);
    if (!normalizedKey || !Array.isArray(state.recentDecisionEvents)) {
        return [];
    }
    return state.recentDecisionEvents
        .filter((event) => normalizeMessageKey(event?.messageKey) === normalizedKey)
        .map((event) => cloneDecisionEvent(event))
        .filter(Boolean);
}

function isSystemMessage(message) {
    return Boolean(message?.is_system);
}

function isNarratorMessage(message) {
    if (!message || typeof message !== "object") {
        return false;
    }
    const narratorType = system_message_types?.NARRATOR;
    if (typeof narratorType !== "string" || !message.extra || typeof message.extra !== "object") {
        return false;
    }
    return message.extra.type === narratorType;
}

function isSystemOrNarratorMessage(message) {
    return isSystemMessage(message) || isNarratorMessage(message);
}

function isAssistantLikeMessage(message) {
    if (!message || typeof message !== "object") {
        return false;
    }
    if (message.is_user) {
        return false;
    }
    if (isSystemOrNarratorMessage(message)) {
        return false;
    }
    return true;
}

function findChatMessageById(messageId) {
    if (!Number.isFinite(messageId)) {
        return null;
    }
    const { chat } = getContext();
    if (!Array.isArray(chat)) {
        return null;
    }
    const candidate = chat.find((message) => message && message.mesId === messageId) || null;
    if (!candidate) {
        return null;
    }
    if (isSystemOrNarratorMessage(candidate)) {
        return null;
    }
    return candidate;
}

function findChatMessageByKey(key) {
    const normalizedKey = normalizeMessageKey(key);
    if (!normalizedKey) {
        return null;
    }
    const resolvedId = extractMessageIdFromKey(normalizedKey);
    const direct = findChatMessageById(resolvedId);
    if (direct && isAssistantLikeMessage(direct)) {
        return direct;
    }
    const { chat } = getContext();
    if (!Array.isArray(chat)) {
        return null;
    }
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        const message = chat[i];
        if (!isAssistantLikeMessage(message)) {
            continue;
        }
        const candidateKey = normalizeMessageKey(message?.message_key || message?.key || `m${message.mesId}`);
        if (candidateKey === normalizedKey) {
            return message;
        }
    }
    return null;
}

function collectDisplayNameMap(roster, events, existingEntries = []) {
    const map = fromDisplayNameEntries(existingEntries);
    events.forEach((event) => {
        if (!event) {
            return;
        }
        const normalized = normalizeRosterKey(event.normalized || event.name);
        if (!normalized) {
            return;
        }
        if (typeof event.name === "string" && event.name.trim() && !map.has(normalized)) {
            map.set(normalized, event.name.trim());
        }
    });
    roster.forEach((value) => {
        const normalized = normalizeRosterKey(value);
        if (!normalized || map.has(normalized)) {
            return;
        }
        const fallback = normalized.charAt(0).toUpperCase() + normalized.slice(1);
        map.set(normalized, fallback);
    });
    return map;
}

function getOutcomeBucket(message, create = false) {
    if (!message || typeof message !== "object") {
        return null;
    }
    if (!message.extra || typeof message.extra !== "object") {
        if (!create) {
            return null;
        }
        message.extra = {};
    }
    const existing = message.extra[MESSAGE_OUTCOME_STORAGE_KEY];
    if (existing && typeof existing === "object") {
        return existing;
    }
    if (create) {
        message.extra[MESSAGE_OUTCOME_STORAGE_KEY] = {};
        return message.extra[MESSAGE_OUTCOME_STORAGE_KEY];
    }
    return null;
}

function persistSceneOutcome(message, swipeId, outcome) {
    if (!message || typeof message !== "object" || message.is_user || isSystemOrNarratorMessage(message)) {
        return;
    }
    const bucket = getOutcomeBucket(message, true);
    if (!bucket) {
        return;
    }
    bucket[swipeId] = outcome;
}

function captureSceneOutcomeForMessage(reference) {
    const { key: requestedKey, messageId } = parseMessageReference(reference);
    const bufKey = findExistingMessageKey(requestedKey, messageId);
    if (!bufKey) {
        return;
    }
    const normalizedKey = normalizeMessageKey(bufKey);
    const resolvedId = Number.isFinite(messageId) ? messageId : extractMessageIdFromKey(normalizedKey);
    const message = findChatMessageById(resolvedId) || findChatMessageByKey(normalizedKey);
    if (message?.is_user || isSystemOrNarratorMessage(message)) {
        debugLog(`Skipping scene outcome capture for non-assistant message ${normalizedKey}.`);
        return;
    }
    const swipeId = Number.isFinite(message?.swipe_id) ? message.swipe_id : 0;
    const msgState = state.perMessageStates instanceof Map ? state.perMessageStates.get(normalizedKey) : null;
    const rosterSet = msgState?.sceneRoster instanceof Set ? msgState.sceneRoster : new Set();
    const roster = Array.from(rosterSet).map(normalizeRosterKey).filter(Boolean);
    const events = collectDecisionEventsForKey(normalizedKey);
    const existingOutcome = message ? getStoredSceneOutcome(message) : null;
    const displayNames = collectDisplayNameMap(roster, events, existingOutcome?.displayNames);
    const stats = state.messageStats instanceof Map ? state.messageStats.get(normalizedKey) : null;
    const timestamp = Date.now();
    const turnsByMember = cloneRosterTurns(msgState?.rosterTurns);
    const turnsRemaining = Number.isFinite(msgState?.defaultRosterTTL)
        ? Math.max(0, Math.floor(msgState.defaultRosterTTL))
        : null;
    const buffer = state.perMessageBuffers instanceof Map ? state.perMessageBuffers.get(normalizedKey) || "" : "";
    const matches = getCachedMatchesForBuffer(normalizedKey, buffer.length);

    replaceLiveTesterOutputs(events, {
        roster,
        displayNames,
        timestamp,
        preprocessedText: state.lastPreprocessedText,
    });

    applySceneRosterUpdate({
        key: normalizedKey,
        messageId: Number.isFinite(resolvedId) ? resolvedId : extractMessageIdFromKey(normalizedKey),
        roster,
        displayNames,
        lastMatch: events.length ? { ...events[events.length - 1] } : null,
        updatedAt: timestamp,
        turnsByMember,
        turnsRemaining,
    });

    state.lastSceneSwipeId = Number.isFinite(message?.swipe_id) ? message.swipe_id : null;
    state.lastSceneDigest = extractSceneMessageDigest(message)
        || deriveSceneDigestFromText(message?.mes)
        || deriveSceneDigestFromText(buffer);
    const outcome = {
        version: 1,
        messageKey: normalizedKey,
        messageId: Number.isFinite(resolvedId) ? resolvedId : null,
        roster,
        displayNames: toDisplayNameEntries(displayNames),
        events: events.map((event) => ({ ...event, messageKey: normalizedKey })),
        stats: toStatsEntries(stats),
        buffer,
        preprocessedText: state.lastPreprocessedText,
        text: message?.mes || "",
        updatedAt: timestamp,
        lastEvent: events.length ? { ...events[events.length - 1] } : null,
        turnsByMember: toRosterTurnEntries(turnsByMember),
        turnsRemaining,
        matches: matches.map((match) => ({ ...match })),
    };

    if (message) {
        persistSceneOutcome(message, swipeId, outcome);
        if (typeof saveChatDebounced === "function") {
            saveChatDebounced();
        }
    }
}

function getStoredSceneOutcome(message) {
    const bucket = getOutcomeBucket(message, false);
    if (!bucket) {
        return null;
    }
    const swipeId = Number.isFinite(message?.swipe_id) ? message.swipe_id : 0;
    const entry = bucket[swipeId];
    if (!entry || typeof entry !== "object") {
        return null;
    }
    return entry;
}

function restoreSceneOutcomeForMessage(message, {
    immediateRender = true,
    preserveStateOnFailure = false,
} = {}) {
    const now = Date.now();
    if (!message || message.is_user || isSystemOrNarratorMessage(message)) {
        if (!preserveStateOnFailure) {
            resetSceneState();
            replaceLiveTesterOutputs([], { roster: [], preprocessedText: "" });
        }
        if (immediateRender) {
            requestScenePanelRender("history-reset", { immediate: true });
        }
        return false;
    }
    const stored = getStoredSceneOutcome(message);
    const fallbackKey = normalizeMessageKey(`m${message.mesId}`);
    const messageKey = normalizeMessageKey(stored?.messageKey || fallbackKey);
    if (!messageKey) {
        if (!preserveStateOnFailure) {
            resetSceneState();
            replaceLiveTesterOutputs([], { roster: [], preprocessedText: "" });
        }
        if (immediateRender) {
            requestScenePanelRender("history-reset", { immediate: true });
        }
        return false;
    }

    trackMessageKey(messageKey);
    if (!(state.perMessageBuffers instanceof Map)) {
        state.perMessageBuffers = new Map();
    }

    const buffer = typeof stored?.buffer === "string" ? stored.buffer : normalizeStreamText(message.mes || "");
    state.perMessageBuffers.set(messageKey, buffer);
    state.lastSceneSwipeId = Number.isFinite(message?.swipe_id) ? message.swipe_id : null;
    state.lastSceneDigest = extractSceneMessageDigest(message)
        || deriveSceneDigestFromText(stored?.text)
        || deriveSceneDigestFromText(buffer);

    const roster = Array.isArray(stored?.roster) ? stored.roster.filter(Boolean) : [];
    const displayNames = collectDisplayNameMap(roster, [], stored?.displayNames);
    const events = Array.isArray(stored?.events)
        ? stored.events.map((event) => {
            const clone = cloneDecisionEvent(event);
            if (clone) {
                clone.messageKey = messageKey;
            }
            return clone;
        }).filter(Boolean)
        : [];

    overwriteRecentDecisionEvents(messageKey, events);

    if (!(state.messageStats instanceof Map)) {
        state.messageStats = new Map();
    }

    const restoredMessageState = state.perMessageStates instanceof Map
        ? state.perMessageStates.get(messageKey)
        : null;
    updateMessageAnalytics(messageKey, buffer, {
        rosterSet: new Set(roster),
        assumeNormalized: true,
        messageState: restoredMessageState,
    });
    if (Array.isArray(stored?.stats) && stored.stats.length) {
        state.messageStats.set(messageKey, fromStatsEntries(stored.stats));
    }

    const currentSceneSnapshot = typeof getCurrentSceneSnapshot === "function"
        ? getCurrentSceneSnapshot()
        : null;
    const existingUpdatedAt = Number.isFinite(currentSceneSnapshot?.updatedAt)
        && currentSceneSnapshot.updatedAt > 0
        ? currentSceneSnapshot.updatedAt
        : null;
    const storedTimestamp = Number.isFinite(stored?.updatedAt) ? stored.updatedAt : null;
    const timestamp = storedTimestamp ?? existingUpdatedAt ?? now;

    const restoredPreprocessed = typeof stored?.preprocessedText === 'string'
        ? stored.preprocessedText
        : buffer;
    replaceLiveTesterOutputs(events, {
        roster,
        displayNames,
        timestamp,
        preprocessedText: restoredPreprocessed,
    });

    const resolvedId = Number.isFinite(stored?.messageId) ? stored.messageId : message.mesId;
    const storedTurnEntries = Array.isArray(stored?.turnsByMember)
        ? stored.turnsByMember
        : [];
    const turnsByMember = fromRosterTurnEntries(storedTurnEntries);
    const turnsRemaining = Number.isFinite(stored?.turnsRemaining)
        ? Math.max(0, Math.floor(stored.turnsRemaining))
        : null;
    if (turnsByMember.size === 0 && Number.isFinite(stored?.turnsRemaining)) {
        const fallbackTurns = Math.max(0, Math.floor(stored.turnsRemaining));
        roster.forEach((value) => {
            const normalized = normalizeRosterKey(value);
            if (!normalized) {
                return;
            }
            turnsByMember.set(normalized, fallbackTurns);
        });
    }
    const cache = ensureMatchCache(messageKey);
    if (Array.isArray(stored?.matches) && stored.matches.length) {
        const bufferOffset = resolveBufferOffsetForKey(messageKey);
        cache.matches = stored.matches
            .map((match) => normalizeStoredMatch(match, bufferOffset))
            .filter(Boolean);
        const maxAbsolute = cache.matches.reduce((max, match) => {
            const end = computeAbsoluteEnd(match);
            return Number.isFinite(end) ? Math.max(max, end) : max;
        }, Number.NEGATIVE_INFINITY);
        if (Number.isFinite(maxAbsolute) && maxAbsolute !== Number.NEGATIVE_INFINITY) {
            cache.processedAbsolute = maxAbsolute;
        } else if (!Number.isFinite(cache.processedAbsolute)) {
            cache.processedAbsolute = buffer.length > 0
                ? bufferOffset + buffer.length - 1
                : bufferOffset - 1;
        }
    }

    const preserveExistingRoster = roster.length === 0;

    applySceneRosterUpdate({
        key: messageKey,
        messageId: Number.isFinite(resolvedId) ? resolvedId : extractMessageIdFromKey(messageKey),
        roster,
        displayNames,
        lastMatch: stored?.lastEvent ? { ...stored.lastEvent } : (events.length ? { ...events[events.length - 1] } : null),
        updatedAt: timestamp,
        turnsByMember,
        turnsRemaining,
    }, preserveExistingRoster ? { preserveActiveOnEmpty: true } : undefined);

    if (immediateRender) {
        requestScenePanelRender("history-restore", { immediate: true });
    }

    return Boolean(stored);
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
            if (!Array.isArray(profile.patternSlots)) {
                profile.patternSlots = [];
            }
            const newSlot = normalizePatternSlot({ name });
            ensurePatternSlotId(newSlot);
            profile.patternSlots.push(newSlot);
            updateProfilePatternCache(profile);
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

function normalizeSubjectForComparison(name) {
    if (!name && name !== "") {
        return null;
    }
    const trimmed = String(name ?? "").trim();
    if (!trimmed) {
        return null;
    }
    const normalized = normalizeCostumeName(trimmed) || trimmed;
    const lowered = String(normalized).trim().toLowerCase();
    return lowered || null;
}

function confirmMessageSubject(msgState, matchedName) {
    if (!msgState) {
        return;
    }

    const trimmed = String(matchedName ?? "").trim();
    const normalized = normalizeSubjectForComparison(trimmed);

    if (!normalized) {
        msgState.lastSubject = null;
        msgState.lastSubjectNormalized = null;
        return;
    }

    const pendingNormalized = msgState.pendingSubjectNormalized || null;
    if (pendingNormalized && normalized === pendingNormalized) {
        const pendingTrimmed = typeof msgState.pendingSubject === "string"
            ? msgState.pendingSubject.trim()
            : "";
        msgState.lastSubject = pendingTrimmed || trimmed;
    } else {
        msgState.lastSubject = trimmed;
    }

    msgState.lastSubjectNormalized = normalized;
    msgState.pendingSubject = null;
    msgState.pendingSubjectNormalized = null;
}

function shouldAdvanceRosterTTL(role) {
    if (typeof role !== "string") {
        return false;
    }
    const normalizedRole = role.trim().toLowerCase();
    if (!normalizedRole) {
        return false;
    }
    return normalizedRole === "assistant";
}

function resolveMessageRoleFromArgs(args) {
    if (!Array.isArray(args) || args.length === 0) {
        return null;
    }

    const normalizeRole = (value) => {
        if (typeof value !== "string") {
            return null;
        }
        const trimmed = value.trim().toLowerCase();
        if (!trimmed) {
            return null;
        }
        if (["assistant", "model", "bot", "ai"].includes(trimmed)) {
            return "assistant";
        }
        if (["user", "player", "human", "manual", "input"].includes(trimmed)) {
            return "user";
        }
        if (["system", "narrator"].includes(trimmed)) {
            return trimmed;
        }
        return null;
    };

    const narratorTokens = new Set();
    narratorTokens.add("narrator");
    if (system_message_types && typeof system_message_types === "object") {
        const rawNarrator = system_message_types.NARRATOR;
        if (typeof rawNarrator === "string") {
            const normalizedNarrator = rawNarrator.trim().toLowerCase();
            if (normalizedNarrator) {
                narratorTokens.add(normalizedNarrator);
            }
        }
    }

    const resolveFlaggedRole = (value) => {
        if (!value || typeof value !== "object") {
            return null;
        }
        if (value.is_user === true || value.isUser === true) {
            return "user";
        }
        if (value.is_system === true || value.isSystem === true) {
            return "system";
        }
        if (value.is_assistant === true || value.isAssistant === true) {
            return "assistant";
        }
        const extraType = value.extra?.type;
        if (typeof extraType === "string") {
            const trimmed = extraType.trim().toLowerCase();
            if (trimmed) {
                if (narratorTokens.has(trimmed)) {
                    return "narrator";
                }
                const normalizedExtraRole = normalizeRole(trimmed);
                if (normalizedExtraRole) {
                    return normalizedExtraRole;
                }
            }
        }
        return null;
    };

    const visited = new Set();
    const queue = [...args];

    const inspectContainer = (container) => {
        if (!container || typeof container !== "object") {
            return null;
        }

        const flagged = resolveFlaggedRole(container);
        if (flagged) {
            return flagged;
        }

        queue.push(container);

        if (typeof container.message === "object" && container.message !== null) {
            const nestedFlagged = resolveFlaggedRole(container.message);
            if (nestedFlagged) {
                return nestedFlagged;
            }
            queue.push(container.message);
        }

        if (Array.isArray(container.messages) && container.messages.length > 0) {
            for (const message of container.messages) {
                const nestedFlagged = resolveFlaggedRole(message);
                if (nestedFlagged) {
                    return nestedFlagged;
                }
            }
            queue.push(...container.messages);
        }

        return null;
    };

    while (queue.length > 0) {
        const value = queue.shift();

        if (typeof value === "string") {
            const role = normalizeRole(value);
            if (role) {
                return role;
            }
            continue;
        }

        if (typeof value === "number" || typeof value === "boolean" || value == null) {
            continue;
        }

        if (Array.isArray(value)) {
            queue.push(...value);
            continue;
        }

        if (typeof value !== "object") {
            continue;
        }

        if (visited.has(value)) {
            continue;
        }
        visited.add(value);

        if (typeof value.role === "string" && value.role.trim()) {
            const role = normalizeRole(value.role);
            if (role) {
                return role;
            }
            return value.role.trim().toLowerCase();
        }

        const flaggedRole = resolveFlaggedRole(value);
        if (flaggedRole) {
            return flaggedRole;
        }

        const candidates = [value.author, value.sender, value.source, value.type, value.generationType];
        for (const candidate of candidates) {
            const role = normalizeRole(candidate);
            if (role) {
                return role;
            }
        }

        if (typeof value.message === "object" && value.message !== null) {
            const nestedFlagged = resolveFlaggedRole(value.message);
            if (nestedFlagged) {
                return nestedFlagged;
            }
            queue.push(value.message);
        }
        if (Array.isArray(value.messages) && value.messages.length > 0) {
            for (const message of value.messages) {
                const nestedFlagged = resolveFlaggedRole(message);
                if (nestedFlagged) {
                    return nestedFlagged;
                }
            }
            queue.push(...value.messages);
        }
        const nestedContainers = [value.detail, value.payload, value.event, value.data];
        for (const container of nestedContainers) {
            const nestedRole = inspectContainer(container);
            if (nestedRole) {
                return nestedRole;
            }
        }
    }
    return null;
}

function createMessageState(profile, bufKey, options = {}) {
    if (!profile || !bufKey) {
        return { state: null, initialized: false, rosterCleared: false, key: null };
    }

    const normalizedKey = normalizeMessageKey(bufKey) || bufKey;

    if (!(state.perMessageStates instanceof Map)) {
        state.perMessageStates = new Map();
    }
    if (!(state.perMessageBuffers instanceof Map)) {
        state.perMessageBuffers = new Map();
    }

    if (state.perMessageStates.has(normalizedKey)) {
        return {
            state: state.perMessageStates.get(normalizedKey),
            initialized: false,
            rosterCleared: false,
            key: normalizedKey,
        };
    }

    let oldState = null;
    if (state.perMessageStates.size > 0) {
        const queue = ensureMessageQueue();
        for (let i = queue.length - 1; i >= 0; i -= 1) {
            const candidateKey = queue[i];
            if (!candidateKey || candidateKey === normalizedKey) {
                continue;
            }
            const candidateState = state.perMessageStates.get(candidateKey);
            if (candidateState) {
                oldState = candidateState;
                break;
            }
        }
        if (!oldState) {
            oldState = Array.from(state.perMessageStates.values()).pop() || null;
        }
    }

    let pendingSubject = null;
    let pendingSubjectNormalized = null;
    if (oldState?.lastSubject) {
        const inherited = String(oldState.lastSubject).trim();
        const normalized = normalizeSubjectForComparison(inherited);
        if (normalized) {
            pendingSubject = inherited;
            pendingSubjectNormalized = normalized;
        }
    }

    const profileTTL = sanitizeRosterTurnValue(profile?.sceneRosterTTL ?? PROFILE_DEFAULTS.sceneRosterTTL);
    const advanceRosterTTL = shouldAdvanceRosterTTL(options?.messageRole);
    const previousTurns = oldState?.rosterTurns instanceof Map ? oldState.rosterTurns : null;
    const rosterTurns = new Map();
    const expiredMembers = [];

    if (previousTurns && previousTurns.size > 0) {
        previousTurns.forEach((value, key) => {
            const normalized = normalizeRosterKey(key);
            const sanitized = sanitizeRosterTurnValue(value);
            if (!normalized || sanitized == null) {
                return;
            }
            if (!advanceRosterTTL) {
                rosterTurns.set(normalized, sanitized);
                return;
            }
            const next = sanitized - 1;
            if (next > 0) {
                rosterTurns.set(normalized, next);
            } else {
                expiredMembers.push(normalized);
            }
        });
    } else if (oldState?.sceneRoster instanceof Set && oldState.sceneRoster.size > 0) {
        const fallback = sanitizeRosterTurnValue(oldState?.rosterTTL ?? profileTTL);
        oldState.sceneRoster.forEach((value) => {
            const normalized = normalizeRosterKey(value);
            if (!normalized) {
                return;
            }
            if (fallback == null) {
                expiredMembers.push(normalized);
                return;
            }
            if (!advanceRosterTTL) {
                rosterTurns.set(normalized, fallback);
                return;
            }
            const next = fallback - 1;
            if (next > 0) {
                rosterTurns.set(normalized, next);
            } else {
                expiredMembers.push(normalized);
            }
        });
    }

    const sceneRoster = new Set(rosterTurns.keys());
    const baseOutfitTTL = Number.isFinite(oldState?.outfitTTL)
        ? oldState.outfitTTL
        : profileTTL;

    const newState = {
        lastAcceptedName: null,
        lastAcceptedTs: 0,
        vetoed: false,
        lastSubject: null,
        lastSubjectNormalized: null,
        pendingSubject,
        pendingSubjectNormalized,
        sceneRoster,
        outfitRoster: new Map(oldState?.outfitRoster || []),
        rosterTurns,
        defaultRosterTTL: profileTTL,
        outfitTTL: baseOutfitTTL,
        processedLength: 0,
        lastAcceptedIndex: -1,
        bufferOffset: 0,
        speakerPrefixLength: 0,
        removedRoster: new Set(oldState?.removedRoster || []),
        quoteContext: { inQuote: false, quoteChar: null }, // FIX #12 Performance
    };

    let rosterCleared = false;

    if (expiredMembers.length > 0) {
        rosterCleared = true;
        debugLog(`Scene roster TTL expired for ${expiredMembers.join(', ')}, removing from roster.`);
    }

    if (advanceRosterTTL && newState.outfitRoster.size > 0 && Number.isFinite(newState.outfitTTL)) {
        newState.outfitTTL -= 1;
        if (newState.outfitTTL <= 0) {
            const expired = Array.from(newState.outfitRoster.keys());
            if (expired.length) {
                debugLog("Outfit roster TTL expired, clearing tracked outfits:", expired.join(', '));
            } else {
                debugLog("Outfit roster TTL expired, clearing tracked outfits.");
            }
            newState.outfitRoster.clear();
            const cache = ensureCharacterOutfitCache(state);
            expired.forEach(key => cache.delete(key));
        }
        newState.outfitTTL = Math.max(0, newState.outfitTTL);
    }

    state.perMessageStates.set(normalizedKey, newState);
    state.perMessageBuffers.set(normalizedKey, '');
    trackMessageKey(normalizedKey);

    return { state: newState, initialized: true, rosterCleared, key: normalizedKey };
}

__testables.createMessageState = createMessageState;
__testables.resolveMessageRoleFromArgs = resolveMessageRoleFromArgs;
__testables.findAssistantMessageBeforeIndex = findAssistantMessageBeforeIndex;
__testables.resolveAssistantHistoryMessage = resolveAssistantHistoryMessage;
__testables.findChatMessageById = findChatMessageById;
__testables.findChatMessageByKey = findChatMessageByKey;
__testables.resolveHistoryTargetMessage = resolveHistoryTargetMessage;
__testables.issueCostumeForName = issueCostumeForName;

function remapMessageKey(oldKey, newKey) {
    if (!oldKey || !newKey || oldKey === newKey) return;

    const normalizedOld = normalizeMessageKey(oldKey);
    const normalizedNew = normalizeMessageKey(newKey);

    const moveEntry = (map) => {
        if (!(map instanceof Map) || !map.has(oldKey)) return;
        const value = map.get(oldKey);
        map.delete(oldKey);
        map.set(newKey, value);
    };

    moveEntry(state.perMessageBuffers);
    moveEntry(state.perMessageStates);
    moveEntry(state.messageStats);
    moveEntry(state.messageMatches);

    if (state.topSceneRanking instanceof Map) {
        moveEntry(state.topSceneRanking);
    }

    if (state.topSceneRankingUpdatedAt instanceof Map) {
        if (normalizedOld && state.topSceneRankingUpdatedAt.has(normalizedOld)) {
            const value = state.topSceneRankingUpdatedAt.get(normalizedOld);
            state.topSceneRankingUpdatedAt.delete(normalizedOld);
            const targetKey = normalizedNew || newKey;
            if (targetKey) {
                state.topSceneRankingUpdatedAt.set(targetKey, value);
            }
        } else {
            moveEntry(state.topSceneRankingUpdatedAt);
        }
    }

    if (state.latestTopRanking?.bufKey === oldKey) {
        state.latestTopRanking.bufKey = newKey;
    }

    const settings = getSettings?.();
    if (settings?.session && settings.session.lastMessageKey === oldKey) {
        settings.session.lastMessageKey = newKey;
    }

    replaceTrackedMessageKey(oldKey, newKey);

    const remapEvents = (events) => {
        if (!Array.isArray(events) || !normalizedOld || !normalizedNew) {
            return;
        }
        events.forEach((event) => {
            if (!event || typeof event !== "object") {
                return;
            }
            if (normalizeMessageKey(event.messageKey) === normalizedOld) {
                event.messageKey = normalizedNew;
            }
        });
    };

    remapEvents(state.recentDecisionEvents);
    if (Array.isArray(state.lastTesterReport?.events)) {
        remapEvents(state.lastTesterReport.events);
    }
    const session = ensureSessionData();
    if (session && Array.isArray(session.recentDecisionEvents)) {
        remapEvents(session.recentDecisionEvents);
    }

    debugLog(`Remapped message data from ${oldKey} to ${newKey}.`);
}

function resolveStreamMessageKeyFromChatMessage(message) {
    if (!message || typeof message !== "object") {
        debugLog("Stream message key resolution skipped; invalid chat message payload.", message);
        return null;
    }
    const extra = message.extra && typeof message.extra === "object" ? message.extra : null;
    const rawKey = message.message_key
        || message.messageKey
        || message.key
        || extra?.message_key
        || extra?.messageKey
        || extra?.key
        || (Number.isFinite(message.mesId) ? `m${message.mesId}` : null)
        || (Number.isFinite(message.id) ? `m${message.id}` : null)
        || (Number.isFinite(message.messageId) ? `m${message.messageId}` : null)
        || (Number.isFinite(message.message_id) ? `m${message.message_id}` : null)
        || (Number.isFinite(extra?.mesId) ? `m${extra.mesId}` : null)
        || (Number.isFinite(extra?.id) ? `m${extra.id}` : null)
        || (Number.isFinite(extra?.messageId) ? `m${extra.messageId}` : null)
        || (Number.isFinite(extra?.message_id) ? `m${extra.message_id}` : null);
    if (!rawKey) {
        const timestampId = resolveMessageIdFromTimestamp(message.send_date)
            ?? resolveMessageIdFromTimestamp(message.gen_started)
            ?? resolveMessageIdFromTimestamp(message.gen_finished);
        if (timestampId != null) {
            const resolved = normalizeMessageKey(`m${timestampId}`) || `m${timestampId}`;
            debugLog("Resolved stream message key from chat message timestamp.", { timestampId, resolved });
            return resolved;
        }
        debugLog("Stream message key resolution found no usable key on chat message.", message);
        return null;
    }
    const resolved = normalizeMessageKey(rawKey) || rawKey;
    debugLog("Resolved stream message key from chat message.", { rawKey, resolved });
    return resolved;
}

function resolveStreamingContext() {
    let ctx = null;
    if (typeof getContext === "function") {
        ctx = getContext();
    } else if (typeof window !== "undefined" && window.SillyTavern && typeof window.SillyTavern.getContext === "function") {
        ctx = window.SillyTavern.getContext();
    }
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : null;
    const streamingProcessor = ctx?.streamingProcessor || null;
    if (Number.isFinite(streamingProcessor?.messageId)) {
        debugLog("Resolved streaming processor context.", {
            messageId: streamingProcessor.messageId,
            chatLength: Array.isArray(chat) ? chat.length : 0,
        });
    }
    return {
        ctx,
        chat,
        streamingProcessor,
    };
}

function resolveStreamingAssistantMessage(args = [], { chatOverride = null, streamingProcessor = null, allowFallback = true } = {}) {
    const chat = resolveChatLog(chatOverride);
    if (!Array.isArray(chat) || chat.length === 0) {
        return null;
    }
    let candidate = null;
    if (streamingProcessor && Number.isFinite(streamingProcessor.messageId)) {
        const byProcessor = chat[streamingProcessor.messageId];
        if (byProcessor) {
            candidate = byProcessor;
            debugLog("Resolved streaming assistant message from streaming processor index.", {
                messageId: streamingProcessor.messageId,
                key: resolveStreamMessageKeyFromChatMessage(byProcessor),
            });
        }
    }
    if (!candidate && Array.isArray(args) && args.length > 0) {
        for (const value of args) {
            const reference = parseMessageReference(value);
            if (Number.isFinite(reference.messageId)) {
                const resolved = findChatMessageById(reference.messageId);
                if (resolved) {
                    candidate = resolved;
                    break;
                }
            }
            if (reference.key) {
                const resolved = findChatMessageByKey(reference.key);
                if (resolved) {
                    candidate = resolved;
                    break;
                }
            }
        }
    }
    if (!candidate && allowFallback) {
        candidate = findAssistantMessageBeforeIndex(chat.length - 1, chat);
        if (candidate) {
            debugLog("Resolved streaming assistant message from fallback chat search.", {
                key: resolveStreamMessageKeyFromChatMessage(candidate),
            });
        }
    }
    if (candidate && !isAssistantLikeMessage(candidate)) {
        debugLog("Streaming assistant message rejected due to non-assistant role.", {
            role: resolveMessageRoleFromArgs([candidate]),
            key: resolveStreamMessageKeyFromChatMessage(candidate),
        });
        return null;
    }
    return candidate;
}

const handleGenerationStart = (...args) => {
    let messageRole = resolveMessageRoleFromArgs(args);
    if (messageRole && messageRole !== "assistant") {
        debugLog("Skipping generation start due to non-assistant message role.", { messageRole, args });
        state.currentGenerationKey = null;
        state.currentGenerationRole = messageRole;
        return;
    }

    let bufKey = null;
    let locatedMessage = null;

    const adoptReference = (value) => {
        if (value == null) {
            return;
        }
        const reference = parseMessageReference(value);
        if (!locatedMessage) {
            if (Number.isFinite(reference.messageId)) {
                locatedMessage = findChatMessageById(reference.messageId);
            }
            if (!locatedMessage && reference.key) {
                locatedMessage = findChatMessageByKey(reference.key);
            }
        }
        if (!bufKey && locatedMessage) {
            const derivedKey = resolveStreamMessageKeyFromChatMessage(locatedMessage);
            if (derivedKey) {
                bufKey = derivedKey;
            }
        }
    };

    const visited = new Set();
    const queue = Array.isArray(args) ? [...args] : [];
    while (queue.length > 0) {
        const value = queue.shift();
        if (typeof value === "string" || typeof value === "number") {
            adoptReference(value);
            continue;
        }
        if (typeof value === "boolean" || value == null) {
            continue;
        }
        if (Array.isArray(value)) {
            queue.push(...value);
            continue;
        }
        if (typeof value !== "object") {
            continue;
        }
        if (visited.has(value)) {
            continue;
        }
        visited.add(value);

        adoptReference(value);

        if (typeof value.message === "object" && value.message !== null) {
            queue.push(value.message);
        }
        if (Array.isArray(value.messages) && value.messages.length > 0) {
            queue.push(...value.messages);
        }
        if (typeof value.detail === "object" && value.detail !== null) {
            queue.push(value.detail);
            if (typeof value.detail.message === "object" && value.detail.message !== null) {
                queue.push(value.detail.message);
            }
            if (Array.isArray(value.detail.messages) && value.detail.messages.length > 0) {
                queue.push(...value.detail.messages);
            }
        }
    }

    const { chat, streamingProcessor } = resolveStreamingContext();
    const streamingMessage = resolveStreamingAssistantMessage(args, {
        chatOverride: chat,
        streamingProcessor,
        allowFallback: false,
    });
    if (streamingMessage) {
        locatedMessage = streamingMessage;
        const streamingKey = resolveStreamMessageKeyFromChatMessage(streamingMessage);
        if (streamingKey) {
            bufKey = streamingKey;
        }
        debugLog("Streaming message resolved during generation start.", {
            streamingKey,
            currentGenerationKey: state.currentGenerationKey,
        });
    }

    const locatedRole = locatedMessage ? resolveMessageRoleFromArgs([locatedMessage]) : null;
    if (locatedRole && locatedRole !== "assistant") {
        debugLog("Skipping generation start due to non-assistant chat message role.", {
            locatedRole,
            bufKey,
            messageRole,
            args,
        });
        state.currentGenerationKey = null;
        state.currentGenerationRole = locatedRole;
        return;
    }
    if (!messageRole && locatedRole) {
        messageRole = locatedRole;
    }

    const isUserInitiated = (() => {
        const queue = Array.isArray(args) ? [...args] : [];
        const visited = new Set();
        while (queue.length) {
            const value = queue.shift();
            if (value == null) {
                continue;
            }
            if (typeof value === "string") {
                const lowered = value.trim().toLowerCase();
                if (["user", "input", "manual", "manual_input", "human", "player"].includes(lowered)) {
                    return true;
                }
                continue;
            }
            if (typeof value === "number" || typeof value === "boolean") {
                continue;
            }
            if (typeof value !== "object") {
                continue;
            }
            if (visited.has(value)) {
                continue;
            }
            visited.add(value);
            if (value.is_user === true || value.isUser === true) {
                return true;
            }
            const role = typeof value.role === "string" ? value.role.trim().toLowerCase() : null;
            if (role === "user" || role === "player" || role === "human") {
                return true;
            }
            const author = typeof value.author === "string" ? value.author.trim().toLowerCase() : null;
            if (author === "user" || author === "player" || author === "human") {
                return true;
            }
            const sender = typeof value.sender === "string" ? value.sender.trim().toLowerCase() : null;
            if (sender === "user" || sender === "player" || sender === "human") {
                return true;
            }
            const source = typeof value.source === "string" ? value.source.trim().toLowerCase() : null;
            if (source === "user" || source === "player" || source === "human") {
                return true;
            }
            const type = typeof value.type === "string" ? value.type.trim().toLowerCase() : null;
            if (type === "user" || type === "input" || type === "manual" || type === "human") {
                return true;
            }
            const generationType = typeof value.generationType === "string"
                ? value.generationType.trim().toLowerCase()
                : null;
            if (generationType === "user" || generationType === "input" || generationType === "manual") {
                return true;
            }
            if (typeof value.message === "object" && value.message !== null) {
                queue.push(value.message);
            }
            if (Array.isArray(value.messages)) {
                queue.push(...value.messages);
            }
            if (typeof value.detail === "object" && value.detail !== null) {
                queue.push(value.detail);
                if (typeof value.detail.message === "object" && value.detail.message !== null) {
                    queue.push(value.detail.message);
                }
                if (Array.isArray(value.detail.messages)) {
                    queue.push(...value.detail.messages);
                }
            }
        }
        return false;
    })();

    if (isUserInitiated) {
        debugLog("Skipping generation start for user-authored event.", args);
        state.currentGenerationRole = "user";
        return;
    }

    if (!bufKey && locatedMessage) {
        const fallbackKey = locatedMessage.message_key
            || locatedMessage.messageKey
            || locatedMessage.key
            || (Number.isFinite(locatedMessage.mesId) ? `m${locatedMessage.mesId}` : null)
            || (Number.isFinite(locatedMessage.id) ? `m${locatedMessage.id}` : null);
        if (fallbackKey) {
            const normalizedFallback = normalizeMessageKey(fallbackKey) || fallbackKey;
            bufKey = normalizedFallback;
            debugLog(`Adopted ${normalizedFallback} from chat context for generation start.`);
        }
    }

    if (!bufKey && Number.isFinite(streamingProcessor?.messageId)) {
        const fallbackKey = `m${streamingProcessor.messageId}`;
        const normalizedFallback = normalizeMessageKey(fallbackKey) || fallbackKey;
        bufKey = normalizedFallback;
        debugLog(`Adopted ${normalizedFallback} from streaming processor messageId for generation start.`);
    }

    if (!bufKey) {
        const hasChatAssistant = Array.isArray(chat) && findAssistantMessageBeforeIndex(chat.length - 1, chat);
        if (!hasChatAssistant) {
            bufKey = "live";
        }
    }

    if (!bufKey) {
        debugLog("Generation started without a resolvable chat message key.", args);
        state.currentGenerationKey = null;
        state.currentGenerationRole = messageRole || "assistant";
        return;
    }

    const normalizedKey = normalizeMessageKey(bufKey) || bufKey;

    state.currentGenerationKey = normalizedKey;
    state.currentGenerationRole = messageRole || "assistant";
    debugLog(`Generation started for ${bufKey}, resetting state.`);
    state.focusLockNotice = createFocusLockNotice();

    const profile = getActiveProfile();
    if (profile) {
        const { state: msgState, rosterCleared } = createMessageState(profile, normalizedKey, { messageRole });
        if (rosterCleared && msgState) {
            applySceneRosterUpdate({
                key: normalizedKey,
                messageId: extractMessageIdFromKey(normalizedKey),
                roster: Array.from(msgState.sceneRoster || []),
                turnsByMember: cloneRosterTurns(msgState.rosterTurns),
                turnsRemaining: msgState.defaultRosterTTL,
                updatedAt: Date.now(),
            });
            requestScenePanelRender("roster-prime", { immediate: true });
        }
    } else {
        state.perMessageStates.delete(normalizedKey);
        state.perMessageBuffers.set(normalizedKey, "");
    }
    startStreamSnapshotTimer();
    maybeAutoExpandScenePanel("stream");
};

__testables.handleGenerationStart = handleGenerationStart;
__testables.restoreLatestSceneOutcome = restoreLatestSceneOutcome;
__testables.flushStreamQueue = flushStreamQueue;
__testables.flushStreamingDetectionPass = flushStreamingDetectionPass;

function resolveStreamSnapshotMessage(bufKey, { fallbackLatest = false } = {}) {
    if (!bufKey) {
        return null;
    }
    const chat = resolveChatLog();
    if (!Array.isArray(chat) || chat.length === 0) {
        return null;
    }
    const normalizedKey = normalizeMessageKey(bufKey) || bufKey;
    const resolvedId = extractMessageIdFromKey(normalizedKey);
    let resolvedMessage = null;
    if (Number.isFinite(resolvedId)) {
        resolvedMessage = findChatMessageById(resolvedId);
    }
    if (!resolvedMessage) {
        resolvedMessage = findChatMessageByKey(normalizedKey);
    }
    if (!resolvedMessage && Number.isFinite(resolvedId)) {
        resolvedMessage = chat.find((message) => Number.isFinite(message?.mesId) && message.mesId === resolvedId) || null;
    }
    if (!resolvedMessage && fallbackLatest) {
        resolvedMessage = findAssistantMessageBeforeIndex(chat.length - 1, chat);
    }
    return resolvedMessage;
}

function resolveStreamSnapshotSource(message) {
    if (!message || typeof message !== "object") {
        return "";
    }
    // Note: We intentionally do NOT apply the speaker prefix here.
    // Applying the prefix causes index mismatch between snapshot-based and token-based
    // streaming paths, which breaks subsequent character detection after the first match.
    // The speaker name will be detected naturally if it appears in the message content.
    const candidates = [
        message.mes,
        message.text,
        message.content,
        message.message,
        message.msg,
        message.data?.mes,
        message.data?.text,
        message.data?.content,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.length > 0) {
            return candidate;
        }
    }
    return "";
}


function resolveStreamTokenText(args) {
    if (!Array.isArray(args) || args.length === 0) {
        return "";
    }
    for (const entry of args) {
        if (typeof entry === "string") {
            return entry;
        }
        if (!entry || typeof entry !== "object") {
            continue;
        }
        if (typeof entry.token === "string") {
            return entry.token;
        }
        if (typeof entry.text === "string") {
            return entry.text;
        }
        if (typeof entry.content === "string") {
            return entry.content;
        }
        if (typeof entry.delta === "string") {
            return entry.delta;
        }
        if (typeof entry.delta?.text === "string") {
            return entry.delta.text;
        }
        if (typeof entry.delta?.content === "string") {
            return entry.delta.content;
        }
    }
    return "";
}

function canUseStreamSnapshot(bufKey, { messageRole = "assistant" } = {}) {
    if (!bufKey || messageRole !== "assistant") {
        return false;
    }
    const resolvedMessage = resolveStreamSnapshotMessage(bufKey, { fallbackLatest: true });
    if (!resolvedMessage || !isAssistantLikeMessage(resolvedMessage)) {
        return false;
    }
    const snapshotSource = resolveStreamSnapshotSource(resolvedMessage);
    if (!snapshotSource) {
        return false;
    }
    const snapshotText = normalizeStreamText(snapshotSource);
    return Boolean(snapshotText);
}

function processStreamSnapshotText(bufKey, snapshotSource, { messageRole = "assistant" } = {}) {
    if (!bufKey || messageRole !== "assistant") {
        return false;
    }
    const profile = getActiveProfile();
    if (!profile) {
        return false;
    }
    const normalizedKey = normalizeMessageKey(bufKey) || bufKey;
    const snapshotText = normalizeStreamText(snapshotSource);
    if (!snapshotText) {
        return false;
    }

    let msgState = state.perMessageStates.get(normalizedKey);
    if (!msgState) {
        const { state: createdState, rosterCleared } = createMessageState(profile, normalizedKey, { messageRole });
        msgState = createdState;
        if (rosterCleared && msgState) {
            applySceneRosterUpdate({
                key: normalizedKey,
                messageId: extractMessageIdFromKey(normalizedKey),
                roster: Array.from(msgState.sceneRoster || []),
                turnsByMember: cloneRosterTurns(msgState.rosterTurns),
                turnsRemaining: msgState.defaultRosterTTL,
                updatedAt: Date.now(),
            });
            requestScenePanelRender("roster-prime", { immediate: true });
        }
    }
    if (!msgState || msgState.vetoed) {
        return false;
    }

    const previousProcessedLength = Number.isFinite(msgState.processedLength) ? msgState.processedLength : 0;
    if (snapshotText.length <= previousProcessedLength) {
        msgState.processedLength = Math.max(msgState.processedLength || 0, snapshotText.length);
        return false;
    }

    const deltaText = snapshotText.slice(previousProcessedLength);
    if (!deltaText) {
        return false;
    }

    processStreamChunk(normalizedKey, deltaText, { messageRole });
    return true;
}

function runStreamSnapshotTick({ forceKey = null, forceRole = null } = {}) {
    const activeKey = forceKey || state.currentGenerationKey;
    if (!activeKey) {
        return false;
    }
    const normalizedKey = normalizeMessageKey(activeKey) || activeKey;
    const profile = getActiveProfile();
    if (!profile) {
        return false;
    }
    const messageRole = forceRole || state.currentGenerationRole || "assistant";
    if (messageRole !== "assistant") {
        return false;
    }
    const resolvedMessage = resolveStreamSnapshotMessage(normalizedKey, { fallbackLatest: true });
    if (!resolvedMessage || !isAssistantLikeMessage(resolvedMessage)) {
        return false;
    }
    const snapshotSource = resolveStreamSnapshotSource(resolvedMessage);
    if (!snapshotSource) {
        return false;
    }
    return processStreamSnapshotText(normalizedKey, snapshotSource, { messageRole });
}

function startStreamSnapshotTimer() {
    if (state.streamSnapshotTimer) {
        return;
    }
    state.streamSnapshotTimer = setInterval(() => {
        if (!state.currentGenerationKey) {
            stopStreamSnapshotTimer();
            return;
        }
        runStreamSnapshotTick();
    }, STREAM_SNAPSHOT_INTERVAL_MS);
}

function stopStreamSnapshotTimer({ finalSnapshot = false, finalKey = null, finalRole = null } = {}) {
    if (finalSnapshot) {
        runStreamSnapshotTick({ forceKey: finalKey, forceRole: finalRole });
    }
    if (state.streamSnapshotTimer) {
        clearInterval(state.streamSnapshotTimer);
        state.streamSnapshotTimer = null;
    }
}

function ensureStreamQueue() {
    if (!(state.pendingStreamBuffers instanceof Map)) {
        state.pendingStreamBuffers = new Map();
    }
    if (!(state.pendingStreamRoles instanceof Map)) {
        state.pendingStreamRoles = new Map();
    }
    return {
        buffers: state.pendingStreamBuffers,
        roles: state.pendingStreamRoles,
    };
}

function scheduleStreamQueueFlush() {
    if (state.pendingStreamTimer) {
        return;
    }
    state.pendingStreamTimer = setTimeout(() => {
        state.pendingStreamTimer = null;
        flushStreamQueue();
    }, STREAM_QUEUE_FLUSH_MS);
}

function flushStreamQueue({ keys = null } = {}) {
    if (!(state.pendingStreamBuffers instanceof Map) || state.pendingStreamBuffers.size === 0) {
        return;
    }
    const targets = Array.isArray(keys) ? new Set(keys) : null;
    const buffers = state.pendingStreamBuffers;
    const roles = state.pendingStreamRoles instanceof Map ? state.pendingStreamRoles : new Map();
    for (const [bufKey, chunk] of buffers.entries()) {
        if (targets && !targets.has(bufKey)) {
            continue;
        }
        if (typeof chunk === "string" && chunk.length > 0) {
            const messageRole = roles.get(bufKey) || state.currentGenerationRole || "assistant";
            processStreamChunk(bufKey, chunk, { messageRole });
        }
        buffers.delete(bufKey);
        roles.delete(bufKey);
    }
    if (buffers.size === 0 && state.pendingStreamTimer) {
        clearTimeout(state.pendingStreamTimer);
        state.pendingStreamTimer = null;
    }
}

function runStreamingDetectionPass(bufKey, { messageRole } = {}) {
    if (!bufKey) {
        return false;
    }
    const normalizedKey = normalizeMessageKey(bufKey) || bufKey;
    const profile = getActiveProfile();
    if (!profile) {
        return false;
    }
    const msgState = state.perMessageStates instanceof Map ? state.perMessageStates.get(normalizedKey) || null : null;
    if (!msgState || msgState.vetoed) {
        return false;
    }
    const effectiveRole = messageRole || state.currentGenerationRole || "assistant";
    if (effectiveRole && effectiveRole !== "assistant") {
        return false;
    }
    const buffer = state.perMessageBuffers instanceof Map ? (state.perMessageBuffers.get(normalizedKey) || "") : "";
    if (!buffer.trim()) {
        return false;
    }
    const bufferLength = buffer.length;
    const lastKey = state.streamingDetectionLastKey;
    const lastLength = state.streamingDetectionLastLength;
    if (lastKey === normalizedKey && Number.isFinite(lastLength) && lastLength === bufferLength) {
        return false;
    }
    const bufferOffset = Number.isFinite(msgState.bufferOffset) ? msgState.bufferOffset : 0;
    const rosterSet = msgState.sceneRoster instanceof Set ? msgState.sceneRoster : null;
    let processed = false;
    try {
        updateMessageAnalytics(normalizedKey, buffer, {
            rosterSet,
            assumeNormalized: true,
            bufferOffset,
            incremental: true,
            messageState: msgState,
        });
        processed = true;
        return true;
    } finally {
        if (processed) {
            state.streamingDetectionLastKey = normalizedKey;
            state.streamingDetectionLastLength = bufferLength;
        }
    }
}

function scheduleStreamingDetectionPass(bufKey, { messageRole } = {}) {
    if (!bufKey) {
        return;
    }
    const normalizedKey = normalizeMessageKey(bufKey) || bufKey;
    state.streamingDetectionKey = normalizedKey;
    if (messageRole) {
        state.streamingDetectionRole = messageRole;
    }
    const now = Date.now();
    const lastRun = Number.isFinite(state.streamingDetectionLastAt) ? state.streamingDetectionLastAt : 0;
    const elapsed = now - lastRun;
    if (elapsed >= STREAMING_DETECTION_INTERVAL_MS) {
        if (runStreamingDetectionPass(normalizedKey, { messageRole: state.streamingDetectionRole })) {
            state.streamingDetectionLastAt = Date.now();
        }
        return;
    }
    if (state.streamingDetectionTimer) {
        return;
    }
    const delay = Math.max(0, STREAMING_DETECTION_INTERVAL_MS - elapsed);
    state.streamingDetectionTimer = setTimeout(() => {
        state.streamingDetectionTimer = null;
        const key = state.streamingDetectionKey;
        if (key && runStreamingDetectionPass(key, { messageRole: state.streamingDetectionRole })) {
            state.streamingDetectionLastAt = Date.now();
        }
    }, delay);
}

function flushStreamingDetectionPass({ forceKey = null, forceRole = null } = {}) {
    if (state.streamingDetectionTimer) {
        clearTimeout(state.streamingDetectionTimer);
        state.streamingDetectionTimer = null;
    }
    const key = forceKey || state.streamingDetectionKey;
    if (!key) {
        return false;
    }
    const role = forceRole || state.streamingDetectionRole || state.currentGenerationRole;
    if (runStreamingDetectionPass(key, { messageRole: role })) {
        state.streamingDetectionLastAt = Date.now();
        return true;
    }
    return false;
}

function queueStreamChunk(bufKey, tokenText, { messageRole } = {}) {
    if (!bufKey || typeof tokenText !== "string" || tokenText.length === 0) {
        debugLog("[STREAM] Skipping queue for empty stream chunk or missing key.", {
            messageKey: bufKey,
            currentGenerationKey: state.currentGenerationKey,
            rawToken: tokenText,
        });
        return;
    }
    const { buffers, roles } = ensureStreamQueue();
    const existing = buffers.get(bufKey) || "";
    const combined = existing + tokenText;
    const normalizedToken = normalizeStreamText(tokenText);
    buffers.set(bufKey, combined);
    if (messageRole) {
        roles.set(bufKey, messageRole);
    }
    const normalizedKey = normalizeMessageKey(bufKey) || bufKey;
    const currentKey = state.currentGenerationKey ? (normalizeMessageKey(state.currentGenerationKey) || state.currentGenerationKey) : null;
    debugLog("[STREAM] Queued stream chunk.", {
        messageKey: normalizedKey,
        currentGenerationKey: currentKey,
        matchesCurrentKey: currentKey ? currentKey === normalizedKey : false,
        rawToken: tokenText,
        normalizedToken,
        bufferLength: combined.length,
    });
    if (combined.length >= STREAM_QUEUE_MAX_CHARS) {
        flushStreamQueue({ keys: [bufKey] });
        return;
    }
    scheduleStreamQueueFlush();
}

function processStreamChunk(bufKey, tokenText, { messageRole } = {}) {
    if (!bufKey) {
        debugLog("[STREAM] Skipping stream chunk without a message key.", {
            currentGenerationKey: state.currentGenerationKey,
            rawToken: tokenText,
        });
        return;
    }
    const normalizedKey = normalizeMessageKey(bufKey) || bufKey;
    const profile = getActiveProfile();
    if (!profile) {
        return;
    }

    const normalizedToken = normalizeStreamText(tokenText);
    if (!normalizedToken) {
        debugLog("[STREAM] Normalized stream chunk is empty; skipping append.", {
            messageKey: bufKey,
            currentGenerationKey: state.currentGenerationKey,
            rawToken: tokenText,
            normalizedToken,
        });
        return;
    }


    let msgState = state.perMessageStates.get(normalizedKey);

    if (!msgState) {
        const { state: createdState, rosterCleared } = createMessageState(profile, normalizedKey, { messageRole: messageRole || "assistant" });
        msgState = createdState;
        if (rosterCleared && msgState) {
            applySceneRosterUpdate({
                key: normalizedKey,
                messageId: extractMessageIdFromKey(normalizedKey),
                roster: Array.from(msgState.sceneRoster || []),
                turnsByMember: cloneRosterTurns(msgState.rosterTurns),
                turnsRemaining: msgState.defaultRosterTTL,
                updatedAt: Date.now(),
            });
            requestScenePanelRender("roster-prime", { immediate: true });
        }
    }
    if (!msgState) return;

    if (msgState.vetoed) return;

    const prev = state.perMessageBuffers.get(normalizedKey) || "";
    const previousOffset = Number.isFinite(msgState.bufferOffset) ? msgState.bufferOffset : 0;
    const previousProcessedLength = Number.isFinite(msgState.processedLength)
        ? msgState.processedLength
        : previousOffset + prev.length;
    const { appended, detectionBuffer, trimmedChars, bufferOffset } = buildStreamingBuffers(prev, normalizedToken, profile, msgState);

    // FIX #12 Performance: maintain incremental quote state
    if (!msgState.quoteContext) {
        msgState.quoteContext = { inQuote: false, quoteChar: null };
    }

    if (trimmedChars > 0) {
        // We dropped text from the start. Update our state based on what was dropped.
        const fullBuffer = prev + normalizedToken;
        const droppedText = fullBuffer.slice(0, trimmedChars);
        updateQuoteContext(msgState.quoteContext, droppedText);
    }
    const currentKey = state.currentGenerationKey ? (normalizeMessageKey(state.currentGenerationKey) || state.currentGenerationKey) : null;
    debugLog("[STREAM] Appended stream chunk to buffer.", {
        messageKey: normalizedKey,
        currentGenerationKey: currentKey,
        matchesCurrentKey: currentKey ? currentKey === normalizedKey : false,
        rawToken: tokenText,
        normalizedToken,
        bufferLength: appended.length,
        windowLength: detectionBuffer.length,
        trimmedChars,
    });
    const combinedLength = detectionBuffer.length;
    const deltaAbsoluteStart = Math.max(previousProcessedLength, bufferOffset);
    const startIndex = Math.max(0, deltaAbsoluteStart - bufferOffset);
    const newestAbsoluteIndex = combinedLength > 0
        ? bufferOffset + combinedLength - 1
        : bufferOffset;
    const lastProcessedIndex = Number.isFinite(msgState.lastAcceptedIndex) ? msgState.lastAcceptedIndex : -1;
    let windowUpdated = false;
    const flushWindow = () => {
        if (windowUpdated) {
            return;
        }
        adjustWindowForTrim(msgState, trimmedChars, combinedLength);
        state.perMessageBuffers.set(normalizedKey, appended);
        windowUpdated = true;
    };

    if (newestAbsoluteIndex <= lastProcessedIndex) {
        flushWindow();
        return;
    }

    let minIndexRelative = null;
    if (lastProcessedIndex >= bufferOffset) {
        minIndexRelative = lastProcessedIndex - bufferOffset;
    }

    const matchOptions = {};
    if (Number.isFinite(minIndexRelative) && minIndexRelative >= 0) {
        matchOptions.minIndex = minIndexRelative;
    }
    matchOptions.messageState = msgState;
    const detectionContext = ensureDetectionContext(msgState, bufferOffset);
    if (detectionContext?.quoteState) {
        matchOptions.quoteState = detectionContext.quoteState;
        matchOptions.lastIndex = detectionContext.lastProcessedAbsolute;
        matchOptions.bufferOffset = bufferOffset;
    }

    // FIX #4: Mask out reasoning/thinking blocks to prevent detection spam
    // We replace content with spaces to preserve indices for lastAcceptedIndex consistency.
    // Matches incomplete tags at end of string (open thinking block).
    const maskedBuffer = detectionBuffer.replace(
        /<(think|reasoning)>[\s\S]*?(<\/\1>|$)/gi,
        (match) => " ".repeat(match.length)
    );

    // NOTE: We intentionally do NOT pass startIndex here (Fix #1).
    // prompt: "ignore that not found error... I'd like to point out that... shido is the first one... only detect Fiore"
    // Explanation: Without masking, the detector finds "Fiore" in the thinking block (buffer start).
    // Because we process ONE match per chunk, we get stuck in the thinking block for seconds/minutes.
    // By masking, we skip the thinking block entirely and reach the real message immediately.

    const matches = findAllMatches(maskedBuffer, matchOptions);
    const bestMatch = findBestMatch(maskedBuffer, matches, matchOptions);

    if (bestMatch) {
        debugLog(`[STREAM] Buffer len: ${appended.length} (window ${detectionBuffer.length}). Match: ${bestMatch.name} (${bestMatch.matchKind})`);
    }


    flushWindow();
    scheduleStreamingDetectionPass(normalizedKey, { messageRole: messageRole || "assistant" });

    if (state.compiledRegexes.vetoRegex && state.compiledRegexes.vetoRegex.test(detectionBuffer)) {
        debugLog("Veto phrase matched. Halting detection for this message.");
        const vetoMatch = detectionBuffer.match(state.compiledRegexes.vetoRegex)?.[0] || 'unknown veto phrase';
        const recordedVeto = recordLastVetoMatch(vetoMatch, { source: 'live', persist: true });
        recordDecisionEvent({
            type: 'veto',
            match: recordedVeto.phrase,
            charIndex: newestAbsoluteIndex,
            timestamp: Date.now(),
        });
        showStatus(`Detection halted. Veto phrase <b>${escapeHtml(recordedVeto.phrase)}</b> matched.`, 'error', 5000);
        msgState.vetoed = true;
        return;
    }

    if (bestMatch) {
        const { name: matchedName, matchKind } = bestMatch;
        const now = Date.now();
        const suppressMs = profile.repeatSuppressMs;

        const matchLength = Number.isFinite(bestMatch.matchLength) && bestMatch.matchLength > 0
            ? Math.floor(bestMatch.matchLength)
            : 1;
        const matchEndRelative = Number.isFinite(bestMatch.matchIndex)
            ? bestMatch.matchIndex + matchLength
            : null;

        const absoluteIndex = Number.isFinite(matchEndRelative)
            ? bufferOffset + matchEndRelative
            : newestAbsoluteIndex;
        msgState.lastAcceptedIndex = absoluteIndex;
        msgState.processedLength = Math.max(msgState.processedLength || 0, absoluteIndex + 1);

        if (profile.enableSceneRoster) {
            const normalizedName = normalizeRosterKey(matchedName);
            // FIX #12: Only update roster if match is OUTSIDE quotes (Narrative)
            // Pass the current state (context at start of detectionBuffer)
            const isNarrative = !isMatchInsideQuote(detectionBuffer, bestMatch, msgState.quoteContext);

            if (normalizedName && isNarrative) {
                msgState.sceneRoster.add(normalizedName);
                if (!(msgState.rosterTurns instanceof Map)) {
                    msgState.rosterTurns = new Map();
                }
                const resolvedTTL = sanitizeRosterTurnValue(msgState.defaultRosterTTL ?? profile.sceneRosterTTL ?? PROFILE_DEFAULTS.sceneRosterTTL);
                if (resolvedTTL != null) {
                    msgState.rosterTurns.set(normalizedName, resolvedTTL);
                }
            } else if (!isNarrative && normalizedName) {
                debugLog(`[ROSTER] Refusing update for ${normalizedName}: Match is inside quotes (Dialogue).`);
            }
            msgState.outfitTTL = sanitizeRosterTurnValue(profile?.sceneRosterTTL ?? PROFILE_DEFAULTS.sceneRosterTTL);
        }
        if (matchKind !== 'pronoun') {
            confirmMessageSubject(msgState, matchedName);
        }

        if (msgState.lastAcceptedName?.toLowerCase() === matchedName.toLowerCase() && (now - msgState.lastAcceptedTs < suppressMs)) {
            if (matchKind !== 'pronoun') {
                recordDecisionEvent({
                    type: 'skipped',
                    name: matchedName,
                    matchKind,
                    reason: 'repeat-suppression',
                    charIndex: absoluteIndex,
                    timestamp: now,
                });
            }
            flushWindow();
            return;
        }

        msgState.lastAcceptedName = matchedName;
        msgState.lastAcceptedTs = now;
        issueCostumeForName(matchedName, {
            matchKind,
            bufKey,
            messageState: msgState,
            context: { text: detectionBuffer, matchKind, roster: msgState.sceneRoster },
            match: bestMatch,
        });
    }
}

const handleStream = (...args) => {
    try {
        const settings = getSettings();
        if (!settings?.enabled) {
            if (state.focusLockNotice?.character || state.focusLockNotice?.message) {
                state.focusLockNotice = createFocusLockNotice();
            }
            return;
        }

        const focusLockedName = String(settings?.focusLock?.character ?? "").trim();
        if (!focusLockedName && (state.focusLockNotice?.character || state.focusLockNotice?.message)) {
            state.focusLockNotice = createFocusLockNotice();
        }

        if (focusLockedName) {
            notifyFocusLockActive(focusLockedName);
            return;
        }

        let messageRole = state.currentGenerationRole;
        if (!messageRole) {
            const hasRoleCandidates = Array.isArray(args)
                && args.some((value) => value && typeof value === "object");
            if (hasRoleCandidates) {
                messageRole = resolveMessageRoleFromArgs(args);
                if (messageRole) {
                    state.currentGenerationRole = messageRole;
                }
            }
        }
        if (messageRole && messageRole !== "assistant") {
            debugLog("[STREAM] Skipping stream event due to role mismatch.", { messageRole });
            stopStreamSnapshotTimer();
            return;
        }

        const { chat, streamingProcessor } = resolveStreamingContext();

        const streamingMessage = resolveStreamingAssistantMessage(args, {
            chatOverride: chat,
            streamingProcessor,
        });
        let streamingKey = streamingMessage ? resolveStreamMessageKeyFromChatMessage(streamingMessage) : null;
        if (!streamingKey) {
            const parsedReference = parseMessageReference(args);
            const candidateKey = parsedReference.key
                ? normalizeMessageKey(parsedReference.key) || parsedReference.key
                : (Number.isFinite(parsedReference.messageId) ? `m${parsedReference.messageId}` : null);
            if (candidateKey && isLikelyMessageKey(candidateKey)) {
                const resolvedMessage = Number.isFinite(parsedReference.messageId)
                    ? (Array.isArray(chat) ? chat.find((message) => message?.mesId === parsedReference.messageId) : findChatMessageById(parsedReference.messageId))
                    : (Array.isArray(chat) ? findChatMessageByKey(candidateKey) : findChatMessageByKey(candidateKey));
                if (resolvedMessage && !isAssistantLikeMessage(resolvedMessage)) {
                    stopStreamSnapshotTimer();
                    return;
                }
                if (!resolvedMessage && Array.isArray(chat)) {
                    streamingKey = null;
                } else {
                    streamingKey = candidateKey;
                }
            }
        }
        if (!streamingKey && Number.isFinite(streamingProcessor?.messageId)) {
            const fallback = `m${streamingProcessor.messageId}`;
            streamingKey = normalizeMessageKey(fallback) || fallback;
        }
        if (streamingKey && isLikelyMessageKey(streamingKey)) {
            const normalizedKey = normalizeMessageKey(streamingKey) || streamingKey;
            const existingKey = state.currentGenerationKey ? (normalizeMessageKey(state.currentGenerationKey) || state.currentGenerationKey) : null;
            if (!existingKey || existingKey !== normalizedKey) {
                if (existingKey) {
                    remapMessageKey(existingKey, normalizedKey);
                }
                state.currentGenerationKey = normalizedKey;
                const locatedRole = streamingMessage ? resolveMessageRoleFromArgs([streamingMessage]) : null;
                state.currentGenerationRole = locatedRole || messageRole || "assistant";
                debugLog(`Adopted ${normalizedKey} as stream key from chat state.`);
            }
        }

        const tokenText = resolveStreamTokenText(args);

        if (!tokenText) {
            debugLog("[STREAM] No token text resolved from stream payload.", { messageKey: state.currentGenerationKey, messageRole });
        }

        if (tokenText && !state.currentGenerationKey) {
            debugLog("[STREAM] Stream payload resolved token text without a current generation key.", { messageRole });
        }

        if (state.currentGenerationKey) {
            startStreamSnapshotTimer();

            const effectiveRole = messageRole || "assistant";
            const streamingText = typeof streamingProcessor?.result === "string" ? streamingProcessor.result : "";
            if (streamingText) {
                processStreamSnapshotText(state.currentGenerationKey, streamingText, { messageRole: effectiveRole });
            } else if (tokenText) {
                const normalizedTokenText = normalizeStreamText(tokenText);
                const existingBuffer = state.perMessageBuffers instanceof Map
                    ? (state.perMessageBuffers.get(state.currentGenerationKey) || "")
                    : "";
                const looksLikeSnapshot = normalizedTokenText
                    && (!existingBuffer || normalizedTokenText.startsWith(existingBuffer));
                if (looksLikeSnapshot) {
                    processStreamSnapshotText(state.currentGenerationKey, normalizedTokenText, { messageRole: effectiveRole });
                } else if (!canUseStreamSnapshot(state.currentGenerationKey, { messageRole: effectiveRole })) {
                    const hasPendingQueue = state.pendingStreamBuffers instanceof Map && state.pendingStreamBuffers.size > 0;
                    if (!streamingProcessor && !hasPendingQueue) {
                        processStreamChunk(state.currentGenerationKey, tokenText, { messageRole: effectiveRole });
                    } else {
                        queueStreamChunk(state.currentGenerationKey, tokenText, { messageRole: effectiveRole });
                    }
                }
            }
        }
    } catch (err) { console.error(`${logPrefix} stream handler error:`, err); }
};

function resolveChatLog(chatOverride = null) {
    if (Array.isArray(chatOverride)) {
        return chatOverride;
    }
    let ctx = null;
    if (typeof getContext === "function") {
        ctx = getContext();
    } else if (typeof window !== "undefined" && window.SillyTavern && typeof window.SillyTavern.getContext === "function") {
        ctx = window.SillyTavern.getContext();
    }
    if (!ctx || !Array.isArray(ctx.chat)) {
        return null;
    }
    return ctx.chat;
}

function findAssistantMessageBeforeIndex(index, chatOverride = null) {
    const chat = resolveChatLog(chatOverride);
    if (!Array.isArray(chat) || chat.length === 0) {
        return null;
    }
    const startIndex = Number.isFinite(index) ? Math.min(index, chat.length - 1) : chat.length - 1;
    if (startIndex < 0) {
        return null;
    }
    for (let i = startIndex; i >= 0; i -= 1) {
        const candidate = chat[i];
        if (isAssistantLikeMessage(candidate)) {
            return candidate;
        }
    }
    return null;
}

function resolveAssistantHistoryMessage({ chat = null, candidate = null, beforeIndex = null } = {}) {
    const chatLog = resolveChatLog(chat);
    if (!Array.isArray(chatLog) || chatLog.length === 0) {
        return null;
    }
    if (candidate && isAssistantLikeMessage(candidate) && chatLog.includes(candidate)) {
        return candidate;
    }
    let searchIndex = Number.isFinite(beforeIndex) ? beforeIndex : null;
    if (!Number.isFinite(searchIndex) && candidate) {
        const candidateIndex = chatLog.indexOf(candidate);
        if (candidateIndex >= 0) {
            searchIndex = candidateIndex - 1;
        }
    }
    if (!Number.isFinite(searchIndex)) {
        searchIndex = chatLog.length - 1;
    }
    if (searchIndex < 0) {
        return null;
    }
    return findAssistantMessageBeforeIndex(searchIndex, chatLog);
}

function getLatestStoredSceneTimestamp() {
    try {
        let ctx = null;
        if (typeof getContext === "function") {
            ctx = getContext();
        } else if (typeof window !== "undefined" && window.SillyTavern && typeof window.SillyTavern.getContext === "function") {
            ctx = window.SillyTavern.getContext();
        }
        const chatLog = ctx?.chat;
        if (!Array.isArray(chatLog) || chatLog.length === 0) {
            return null;
        }
        const latestAssistant = findAssistantMessageBeforeIndex(chatLog.length - 1);
        if (!latestAssistant) {
            return null;
        }
        const stored = getStoredSceneOutcome(latestAssistant);
        if (Number.isFinite(stored?.updatedAt)) {
            return stored.updatedAt;
        }
    } catch (error) {
        debugLog("Failed to resolve latest stored scene timestamp.", error);
    }
    return null;
}

function restoreLatestSceneOutcome({ immediateRender = true, preserveStateOnFailure = false } = {}) {
    try {
        const chatLog = resolveChatLog();
        if (!Array.isArray(chatLog) || chatLog.length === 0) {
            if (!preserveStateOnFailure) {
                resetSceneState();
                replaceLiveTesterOutputs([], { roster: [], preprocessedText: "" });
            }
            if (immediateRender) {
                requestScenePanelRender("history-reset", { immediate: true });
            }
            return false;
        }
        const latestAssistant = resolveAssistantHistoryMessage({ chat: chatLog });
        if (!latestAssistant) {
            if (!preserveStateOnFailure) {
                resetSceneState();
                replaceLiveTesterOutputs([], { roster: [], preprocessedText: "" });
            }
            if (immediateRender) {
                requestScenePanelRender("history-reset", { immediate: true });
            }
            return false;
        }
        return restoreSceneOutcomeForMessage(latestAssistant, {
            immediateRender,
            preserveStateOnFailure,
        });
    } catch (error) {
        console.warn(`${logPrefix} Failed to restore latest scene outcome:`, error);
        if (!preserveStateOnFailure) {
            resetSceneState();
            replaceLiveTesterOutputs([], { roster: [], preprocessedText: "" });
        }
        if (immediateRender) {
            requestScenePanelRender("history-reset", { immediate: true });
        }
        return false;
    }
}

function resolveHistoryTargetMessage(args) {
    const chat = resolveChatLog();
    if (!Array.isArray(chat) || chat.length === 0) {
        return null;
    }
    const values = Array.isArray(args) ? args : [];
    let target = null;
    let fallbackIndex = null;

    const captureIndexHint = (index) => {
        if (!Number.isFinite(index)) {
            return;
        }
        const normalized = Math.max(0, Math.min(index, chat.length - 1));
        fallbackIndex = normalized;
    };

    const tryAssign = (message) => {
        if (!message) {
            return;
        }
        const messageIndex = chat.indexOf(message);
        if (messageIndex >= 0) {
            captureIndexHint(messageIndex);
        }
        if (!target && !isSystemOrNarratorMessage(message)) {
            target = message;
        }
    };

    values.forEach((arg) => {
        if (target) {
            return;
        }
        if (typeof arg === "number" && chat[arg]) {
            captureIndexHint(arg);
            tryAssign(chat[arg]);
            return;
        }
        if (!arg || typeof arg !== "object") {
            if (typeof arg === "string") {
                tryAssign(findChatMessageByKey(arg));
            }
            return;
        }
        if (Number.isFinite(arg.index) && chat[arg.index]) {
            captureIndexHint(arg.index);
            tryAssign(chat[arg.index]);
        }
        if (target) {
            return;
        }
        if (Number.isFinite(arg.messageId)) {
            tryAssign(findChatMessageById(arg.messageId));
        }
        if (target) {
            return;
        }
        if (Number.isFinite(arg.mesId)) {
            tryAssign(findChatMessageById(arg.mesId));
        }
        if (target) {
            return;
        }
        if (Number.isFinite(arg.id)) {
            tryAssign(findChatMessageById(arg.id));
        }
        if (target) {
            return;
        }
        if (typeof arg.key === "string") {
            tryAssign(findChatMessageByKey(arg.key));
        }
        if (target) {
            return;
        }
        if (typeof arg.messageKey === "string") {
            tryAssign(findChatMessageByKey(arg.messageKey));
        }
        if (target) {
            return;
        }
        if (typeof arg.bufKey === "string") {
            tryAssign(findChatMessageByKey(arg.bufKey));
        }
        if (target) {
            return;
        }
        if (arg.detail && typeof arg.detail === "object") {
            const nested = resolveHistoryTargetMessage([arg.detail]);
            if (nested) {
                tryAssign(nested);
            }
        }
        if (target) {
            return;
        }
        if (arg.message && typeof arg.message === "object") {
            const nestedMessage = resolveHistoryTargetMessage([arg.message]);
            if (nestedMessage) {
                tryAssign(nestedMessage);
            }
        }
        if (target) {
            return;
        }
        if (Array.isArray(arg.messages) && arg.messages.length) {
            const nested = resolveHistoryTargetMessage(arg.messages);
            if (nested) {
                tryAssign(nested);
            }
        }
    });

    if (!target && values.length === 1 && Array.isArray(values[0])) {
        return resolveHistoryTargetMessage(values[0]);
    }

    return resolveAssistantHistoryMessage({
        chat,
        candidate: target,
        beforeIndex: fallbackIndex,
    });
}

function hasForceSceneRefreshFlag(value, depth = 0) {
    if (value == null) {
        return false;
    }
    if (value === true) {
        return true;
    }
    if (typeof value === "string") {
        const normalized = value.toLowerCase();
        if (normalized.includes("chat") && (normalized.includes("load") || normalized.includes("switch"))) {
            return true;
        }
        return false;
    }
    if (typeof value !== "object") {
        return false;
    }
    if (value.forceSceneRefresh === true || value.forceScenePanelRefresh === true) {
        return true;
    }
    const inspectString = (candidate) => {
        if (typeof candidate !== "string") {
            return false;
        }
        const normalized = candidate.toLowerCase();
        return normalized.includes("chat") && (normalized.includes("load") || normalized.includes("switch"));
    };
    if (inspectString(value.type) || inspectString(value.reason) || inspectString(value.name)) {
        return true;
    }
    if (depth < 3) {
        if (Array.isArray(value) && value.some((entry) => hasForceSceneRefreshFlag(entry, depth + 1))) {
            return true;
        }
        const nestedKeys = ["detail", "payload", "data", "args", "event", "value"];
        if (nestedKeys.some((key) => hasForceSceneRefreshFlag(value[key], depth + 1))) {
            return true;
        }
    }
    return false;
}

function shouldForceSceneRefresh(args = []) {
    return args.some((arg) => hasForceSceneRefreshFlag(arg));
}

const handleChatChanged = (...args) => {
    try {
        const forceRefresh = shouldForceSceneRefresh(args);
        let ctx = null;
        if (typeof getContext === "function") {
            ctx = getContext();
        } else if (typeof window !== "undefined" && window.SillyTavern && typeof window.SillyTavern.getContext === "function") {
            ctx = window.SillyTavern.getContext();
        }
        const chatLog = ctx?.chat;
        const latestAssistant = Array.isArray(chatLog) && chatLog.length
            ? findAssistantMessageBeforeIndex(chatLog.length - 1)
            : null;

        if (!forceRefresh) {
            const latestKey = latestAssistant ? normalizeMessageKey(`m${latestAssistant.mesId}`) : null;
            const latestSwipe = Number.isFinite(latestAssistant?.swipe_id) ? latestAssistant.swipe_id : null;
            const latestDigest = extractSceneMessageDigest(latestAssistant);
            const currentScene = typeof getCurrentSceneSnapshot === "function" ? getCurrentSceneSnapshot() : {};
            const currentKey = normalizeMessageKey(currentScene?.key);
            const sessionKey = normalizeMessageKey(ensureSessionData()?.lastMessageKey);
            const lastSwipe = Number.isFinite(state.lastSceneSwipeId) ? state.lastSceneSwipeId : null;
            const lastDigest = state.lastSceneDigest ?? null;

            if (!latestAssistant && !currentKey) {
                return;
            }

            if (latestKey && (latestKey === currentKey || latestKey === sessionKey)) {
                const swipeMatches = latestSwipe == null || lastSwipe == null || latestSwipe === lastSwipe;
                const digestMatches = latestDigest === lastDigest;
                if (swipeMatches && digestMatches) {
                    return;
                }
            }
        }

        resetGlobalState({ immediateRender: false });
        if (latestAssistant) {
            const restored = restoreSceneOutcomeForMessage(latestAssistant, { immediateRender: true });
            if (!restored) {
                restoreLatestSceneOutcome({ immediateRender: true });
            }
        } else {
            restoreLatestSceneOutcome({ immediateRender: true });
        }
    } catch (error) {
        console.warn(`${logPrefix} Failed to reconcile chat change:`, error);
        resetGlobalState({ immediateRender: false });
        restoreLatestSceneOutcome({ immediateRender: true });
    }
};

const handleHistoryChange = (...args) => {
    try {
        const target = resolveHistoryTargetMessage(args);
        if (target) {
            restoreSceneOutcomeForMessage(target);
            return;
        }

        let ctx = null;
        if (typeof getContext === "function") {
            ctx = getContext();
        } else if (typeof window !== "undefined" && window.SillyTavern && typeof window.SillyTavern.getContext === "function") {
            ctx = window.SillyTavern.getContext();
        }
        const chatLog = ctx?.chat;
        const hasAssistantMessages = Array.isArray(chatLog)
            && chatLog.some((message) => isAssistantLikeMessage(message));

        if (!hasAssistantMessages) {
            resetSceneState();
            replaceLiveTesterOutputs([], { roster: [], preprocessedText: "" });
            requestScenePanelRender("history-reset", { immediate: true });
        } else {
            debugLog("History change did not resolve to an assistant message; preserving scene panel state.", args);
        }
    } catch (error) {
        console.warn(`${logPrefix} Failed to reconcile history change:`, error);
    }
};

__testables.handleHistoryChange = handleHistoryChange;

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

    args.forEach((arg) => mergeReference(arg));

    if (!resolvedKey && tempKey) {
        mergeReference(tempKey);
    }

    const resolvedFinalKey = Number.isFinite(resolvedId)
        ? `m${resolvedId}`
        : (resolvedKey || tempKey);
    const finalKey = normalizeMessageKey(resolvedFinalKey) || resolvedFinalKey;

    if (tempKey && finalKey && normalizeMessageKey(tempKey) !== finalKey) {
        remapMessageKey(tempKey, finalKey);
    }

    if (resolvedKey && finalKey && normalizeMessageKey(resolvedKey) !== finalKey) {
        remapMessageKey(resolvedKey, finalKey);
    }
    if (!finalKey) {
        debugLog("Message rendered without a resolvable key.", args);
        stopStreamSnapshotTimer();
        state.currentGenerationKey = null;
        state.currentGenerationRole = null;
        return;
    }

    let renderedMessage = null;
    if (Number.isFinite(resolvedId)) {
        renderedMessage = findChatMessageById(resolvedId);
    }
    if (!renderedMessage && finalKey) {
        renderedMessage = findChatMessageByKey(finalKey);
    }

    if (renderedMessage?.is_user || isSystemOrNarratorMessage(renderedMessage)) {
        debugLog(`Skipping scene panel sync for non-assistant message ${finalKey}.`);
        stopStreamSnapshotTimer();
        state.currentGenerationKey = null;
        state.currentGenerationRole = null;
        return;
    }

    stopStreamSnapshotTimer({
        finalSnapshot: true,
        finalKey,
        finalRole: state.currentGenerationRole,
    });
    flushStreamQueue({ keys: [finalKey] });
    flushStreamingDetectionPass({ forceKey: finalKey, forceRole: state.currentGenerationRole });

    const hasTrackedState = Boolean(
        (state.perMessageBuffers instanceof Map && state.perMessageBuffers.has(finalKey))
        || (state.perMessageStates instanceof Map && state.perMessageStates.has(finalKey))
        || (state.messageStats instanceof Map && state.messageStats.has(finalKey))
    );

    if (!renderedMessage && !hasTrackedState) {
        debugLog(`Skipping scene panel sync for ${finalKey}; no tracked generation state found.`, args);
        stopStreamSnapshotTimer();
        state.currentGenerationKey = null;
        state.currentGenerationRole = null;
        return;
    }

    debugLog(`Message ${finalKey} rendered, calculating final stats from buffer.`);
    calculateFinalMessageStats({ key: finalKey, messageId: resolvedId });
    const rosterTimestamp = Date.now();
    const sceneSnapshot = typeof getCurrentSceneSnapshot === "function" ? getCurrentSceneSnapshot() : null;
    const messageState = state.perMessageStates instanceof Map ? state.perMessageStates.get(finalKey) || null : null;
    const testersSnapshot = typeof getLiveTesterOutputsSnapshot === "function"
        ? getLiveTesterOutputsSnapshot()
        : null;
    const derivedRoster = deriveSceneRosterState({
        messageState,
        sceneSnapshot: sceneSnapshot
            ? {
                ...sceneSnapshot,
                key: finalKey,
                messageId: Number.isFinite(resolvedId)
                    ? resolvedId
                    : (sceneSnapshot?.messageId ?? extractMessageIdFromKey(finalKey)),
            }
            : null,
        testerSnapshot: testersSnapshot,
        now: rosterTimestamp,
    });
    applySceneRosterUpdate({
        key: derivedRoster.key,
        messageId: derivedRoster.messageId,
        roster: derivedRoster.roster,
        displayNames: derivedRoster.displayNames,
        lastMatch: derivedRoster.lastEvent,
        updatedAt: rosterTimestamp,
        turnsByMember: messageState?.rosterTurns,
        turnsRemaining: messageState?.defaultRosterTTL,
    });
    captureSceneOutcomeForMessage({ key: finalKey, messageId: resolvedId });
    pruneMessageCaches();
    state.currentGenerationKey = null;
    state.currentGenerationRole = null;
    requestScenePanelRender("message-rendered", { immediate: true });
};

__testables.handleMessageRendered = handleMessageRendered;

const resetGlobalState = ({ immediateRender = true } = {}) => {
    resetSceneState();
    clearLiveTesterOutputs();
    if (immediateRender) {
        requestScenePanelRender("global-reset", { immediate: true });
    }
    if (state.statusTimer) {
        clearTimeout(state.statusTimer);
        state.statusTimer = null;
    }
    if (state.pendingStreamTimer) {
        clearTimeout(state.pendingStreamTimer);
        state.pendingStreamTimer = null;
    }
    if (state.streamSnapshotTimer) {
        clearInterval(state.streamSnapshotTimer);
        state.streamSnapshotTimer = null;
    }
    if (state.streamingDetectionTimer) {
        clearTimeout(state.streamingDetectionTimer);
        state.streamingDetectionTimer = null;
    }
    if (Array.isArray(state.testerTimers)) {
        state.testerTimers.forEach(clearTimeout);
        state.testerTimers.length = 0;
    }
    state.lastTesterReport = null;
    updateTesterCopyButton();
    state.recentDecisionEvents = [];
    state.lastVetoMatch = null;
    updateSkipReasonSummaryDisplay([]);
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
        topSceneRankingUpdatedAt: new Map(),
        latestTopRanking: { bufKey: null, ranking: [], fullRanking: [], updatedAt: Date.now() },
        currentGenerationKey: null,
        currentGenerationRole: null,
        messageKeyQueue: [],
        draftMappingIds: new Set(),
        draftPatternIds: new Set(),
        focusLockNotice: createFocusLockNotice(),
        lastSceneSwipeId: null,
        lastSceneDigest: null,
        pendingStreamBuffers: new Map(),
        pendingStreamRoles: new Map(),
        pendingStreamTimer: null,
        streamSnapshotTimer: null,
        streamingDetectionTimer: null,
        streamingDetectionKey: null,
        streamingDetectionRole: null,
        streamingDetectionLastAt: 0,
        streamingDetectionLastKey: null,
        streamingDetectionLastLength: null,
    });
    clearSessionTopCharacters();
    if (!immediateRender) {
        requestScenePanelRender("global-reset", { immediate: true });
    }
};

__testables.resetGlobalState = resetGlobalState;

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
    rankSceneCharacters,
    updateMessageAnalytics,
    adjustWindowForTrim,
    simulateTesterStream,
    buildVariantFolderPath,
    handleStream,
    remapMessageKey,
    restoreSceneOutcomeForMessage,
    collectScenePanelState,
    computeAnalyticsUpdatedAt,
    __testables,
};

async function mountScenePanelTemplate() {
    try {
        const $existingPanel = $("#cs-scene-panel").first();
        if ($existingPanel.length > 0) {
            setScenePanelContainer($existingPanel);
            setScenePanelContent($existingPanel.find('[data-scene-panel="content"]'));
            setSceneCollapseToggle($existingPanel.find('[data-scene-panel="collapse-toggle"]'));
            setSceneSectionsContainer($existingPanel.find('[data-scene-panel="sections"]'));
            setSceneToolbar($existingPanel.find('[data-scene-panel="toolbar"]'));
            setSceneRosterList($existingPanel.find('[data-scene-panel="roster-list"]'));
            setSceneRosterSection($existingPanel.find('[data-scene-panel="roster"]'));
            setSceneActiveCards($existingPanel.find('[data-scene-panel="active-cards"]'));
            setSceneActiveSection($existingPanel.find('[data-scene-panel="active-characters"]'));
            setSceneLiveLog($existingPanel.find('[data-scene-panel="log-viewport"]'));
            setSceneLiveLogSection($existingPanel.find('[data-scene-panel="live-log"]'));
            setSceneCoverageSection($existingPanel.find('[data-scene-panel="coverage"]'));
            setSceneCoveragePronouns($existingPanel.find('[data-scene-panel="coverage-pronouns"]'));
            setSceneCoverageAttribution($existingPanel.find('[data-scene-panel="coverage-attribution"]'));
            setSceneCoverageAction($existingPanel.find('[data-scene-panel="coverage-action"]'));
            setSceneFooterButton($existingPanel.find('[data-scene-panel="open-settings"]'));
            setSceneStatusText($existingPanel.find('[data-scene-panel="status-text"]'));
            initializeScenePanelUI();
            requestScenePanelRender("mount", { immediate: true });
            return;
        }

        let templateHtml;
        try {
            templateHtml = await renderExtensionTemplateAsync(extensionTemplateNamespace, "ui/templates/scenePanel");
        } catch (primaryError) {
            console.warn(`${logPrefix} Scene panel template missing at ui/templates/scenePanel.html, attempting fallback.`, primaryError);
            try {
                templateHtml = await renderExtensionTemplateAsync(extensionTemplateNamespace, "src/ui/templates/scenePanel");
            } catch (fallbackError) {
                console.error(`${logPrefix} Failed to load scene panel template from both primary and fallback locations.`, fallbackError);
                return;
            }
        }

        if (!templateHtml) {
            console.warn(`${logPrefix} Scene panel template did not return any markup.`);
            return;
        }

        const $fragment = $(templateHtml.trim());
        const $panel = $fragment.filter("#cs-scene-panel").length > 0
            ? $fragment.filter("#cs-scene-panel").first()
            : $fragment.find("#cs-scene-panel").first();

        if ($panel.length === 0) {
            console.warn(`${logPrefix} Scene panel template is missing the #cs-scene-panel root node.`);
            return;
        }

        const candidateSelectors = ["#sheld", "#st-chat-column", "#chat-column", "#st-chat"];
        let $chatColumn = $();
        for (const selector of candidateSelectors) {
            $chatColumn = $(selector).first();
            if ($chatColumn.length > 0) {
                break;
            }
        }

        if ($chatColumn.length > 0) {
            $panel.insertAfter($chatColumn);
        } else {
            const workspaceSelectors = ["#st-workspace", "#st-container"];
            let $workspace = $();
            for (const selector of workspaceSelectors) {
                $workspace = $(selector).first();
                if ($workspace.length > 0) {
                    break;
                }
            }

            if ($workspace.length === 0) {
                $workspace = $("body");
            }

            $workspace.append($panel);
        }

        setScenePanelContainer($panel);
        setScenePanelContent($panel.find('[data-scene-panel="content"]'));
        setSceneCollapseToggle($panel.find('[data-scene-panel="collapse-toggle"]'));
        setSceneSectionsContainer($panel.find('[data-scene-panel="sections"]'));
        setSceneToolbar($panel.find('[data-scene-panel="toolbar"]'));
        setSceneRosterList($panel.find('[data-scene-panel="roster-list"]'));
        setSceneRosterSection($panel.find('[data-scene-panel="roster"]'));
        setSceneActiveCards($panel.find('[data-scene-panel="active-cards"]'));
        setSceneActiveSection($panel.find('[data-scene-panel="active-characters"]'));
        setSceneLiveLog($panel.find('[data-scene-panel="log-viewport"]'));
        setSceneLiveLogSection($panel.find('[data-scene-panel="live-log"]'));
        setSceneCoverageSection($panel.find('[data-scene-panel="coverage"]'));
        setSceneCoveragePronouns($panel.find('[data-scene-panel="coverage-pronouns"]'));
        setSceneCoverageAttribution($panel.find('[data-scene-panel="coverage-attribution"]'));
        setSceneCoverageAction($panel.find('[data-scene-panel="coverage-action"]'));
        setSceneFooterButton($panel.find('[data-scene-panel="open-settings"]'));
        setSceneStatusText($panel.find('[data-scene-panel="status-text"]'));
        initializeScenePanelUI();
        requestScenePanelRender("mount", { immediate: true });
    } catch (error) {
        console.warn(`${logPrefix} Failed to mount scene panel:`, error);
    }
}

function load() {
    state.eventHandlers = {};
    if (state.integrationHandlers) {
        unregisterSillyTavernIntegration(state.integrationHandlers);
        state.integrationHandlers = null;
    }
    state.integrationHandlers = registerSillyTavernIntegration({
        eventSource,
        eventTypes: event_types,
        onGenerationStarted: handleGenerationStart,
        onStreamStarted: handleGenerationStart,
        onStreamToken: handleStream,
        onMessageFinished: handleMessageRendered,
        onChatChanged: handleChatChanged,
        onHistoryChanged: handleHistoryChange,
    });
}

function unload() {
    if (state.integrationHandlers) {
        unregisterSillyTavernIntegration(state.integrationHandlers, { eventSource });
        state.integrationHandlers = null;
    }
    if (typeof state.autoSaveCleanup === "function") {
        try {
            state.autoSaveCleanup();
        } catch (err) {
            console.warn(`${logPrefix} Failed to clean up auto-save guards:`, err);
        }
        state.autoSaveCleanup = null;
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
    ensureScenePanelSettings(storeSource[extensionName]);

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

            await mountScenePanelTemplate();
            addSceneControlCenterMenuButton();

            const buildMeta = await fetchBuildMetadata();
            renderBuildMetadata(buildMeta);

            populateProfileDropdown();
            populatePresetDropdown();
            populateScorePresetDropdown();
            loadProfile(getSettings().activeProfile);
            wireUI();
            registerCommands();
            load();
            restoreLatestSceneOutcome({ immediateRender: true });

            window[`__${extensionName}_unload`] = unload;
            console.log(`${logPrefix} ${buildMeta?.label || 'dev build'} loaded successfully.`);
        } catch (error) {
            console.error(`${logPrefix} failed to initialize:`, error);
            alert(`Failed to initialize Character Visuals. Check console (F12) for details.`);
        }
    });
}
