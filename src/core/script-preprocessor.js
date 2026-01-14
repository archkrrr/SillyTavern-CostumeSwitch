import { getScriptsByType, runRegexScript, SCRIPT_TYPES } from "../../../../regex/engine.js";

const SCRIPT_COLLECTION_DEFINITIONS = [
    { key: "global", type: SCRIPT_TYPES.GLOBAL },
    { key: "preset", type: SCRIPT_TYPES.PRESET },
    { key: "scoped", type: SCRIPT_TYPES.SCOPED },
];

function normalizeCollectionKey(value) {
    if (typeof value !== "string") {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    return SCRIPT_COLLECTION_DEFINITIONS.some(entry => entry.key === normalized)
        ? normalized
        : null;
}

export function resolveProfileScriptCollections(source) {
    const selections = new Set();
    if (!source) {
        return [];
    }
    if (Array.isArray(source)) {
        source.forEach((entry) => {
            const normalized = normalizeCollectionKey(entry);
            if (normalized) {
                selections.add(normalized);
            }
        });
    } else if (typeof source === "object") {
        Object.entries(source).forEach(([key, value]) => {
            if (!value) {
                return;
            }
            const normalized = normalizeCollectionKey(key);
            if (normalized) {
                selections.add(normalized);
            }
        });
    } else {
        const normalized = normalizeCollectionKey(source);
        if (normalized) {
            selections.add(normalized);
        }
    }
    if (!selections.size) {
        return [];
    }
    return SCRIPT_COLLECTION_DEFINITIONS
        .map(entry => entry.key)
        .filter(key => selections.has(key));
}

export function collectProfilePreprocessorScripts(profile) {
    const selections = resolveProfileScriptCollections(profile?.scriptCollections);
    if (!selections.length) {
        return [];
    }
    const pipeline = [];
    selections.forEach((key) => {
        const definition = SCRIPT_COLLECTION_DEFINITIONS.find(entry => entry.key === key);
        if (!definition) {
            return;
        }
        const scripts = getScriptsByType(definition.type, { allowedOnly: true }) || [];
        scripts.forEach((script) => {
            if (!script || typeof script !== "object") {
                return;
            }
            pipeline.push({ collection: key, script });
        });
    });
    return pipeline;
}

export function applyPreprocessorScripts(text, pipeline = [], options = {}) {
    const initial = typeof text === "string" ? text : String(text ?? "");
    if (!Array.isArray(pipeline) || pipeline.length === 0) {
        return { text: initial, applied: [] };
    }
    const applied = [];
    let output = initial;
    pipeline.forEach((entry) => {
        if (!entry || typeof entry !== "object") {
            return;
        }
        const script = entry.script;
        if (!script || typeof script !== "object") {
            return;
        }
        try {
            output = runRegexScript(script, output, options);
            applied.push({ collection: entry.collection, script });
        } catch (err) {
            console.warn("applyPreprocessorScripts: failed to run regex script", err);
        }
    });
    return { text: output, applied };
}
