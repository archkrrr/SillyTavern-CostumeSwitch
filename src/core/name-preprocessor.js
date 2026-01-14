import { sampleClassifyText } from "./sample-text.js";

function toTrimmedString(value) {
    if (value == null) {
        return "";
    }
    return String(value).trim();
}

export function stripDiacritics(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.normalize("NFD").replace(/\p{M}+/gu, "");
}

function stripPossessiveSuffix(value) {
    const trimmed = toTrimmedString(value);
    if (!trimmed) {
        return "";
    }
    const withoutSuffix = trimmed.replace(/(?:['’](?:s)?|s['’])$/u, "");
    return withoutSuffix ? withoutSuffix : trimmed;
}

function buildCandidateMaps(candidates) {
    const direct = new Map();
    const accentless = new Map();
    candidates.forEach((candidate) => {
        const trimmed = toTrimmedString(candidate);
        if (!trimmed) {
            return;
        }
        const lowered = trimmed.toLowerCase();
        if (!direct.has(lowered)) {
            direct.set(lowered, trimmed);
        }
        const accentKey = stripDiacritics(trimmed).toLowerCase();
        if (accentKey && !accentless.has(accentKey)) {
            accentless.set(accentKey, trimmed);
        }
    });
    return { direct, accentless };
}

export function createNamePreprocessor({
    candidates = [],
    translate = false,
    sample = sampleClassifyText,
    aliasMap = null,
} = {}) {
    const uniqueCandidates = Array.from(new Set(candidates.map(toTrimmedString).filter(Boolean)));
    const maps = buildCandidateMaps(uniqueCandidates);
    const aliasLookup = aliasMap instanceof Map
        ? aliasMap
        : aliasMap && typeof aliasMap === "object"
            ? new Map(Object.entries(aliasMap).map(([key, value]) => [String(key ?? "").toLowerCase(), String(value ?? "")]))
            : new Map();

    return function preprocess(rawName, meta = {}) {
        const raw = toTrimmedString(rawName);
        if (!raw) {
            return {
                raw: "",
                normalized: "",
                canonical: "",
                method: "empty",
                score: null,
                applied: false,
                changed: false,
            };
        }

        const sampled = sample(raw) || raw;
        const sampledTrimmed = toTrimmedString(sampled);
        const normalizedBase = stripPossessiveSuffix(sampledTrimmed);
        const normalized = translate ? stripDiacritics(normalizedBase) : normalizedBase;
        const lowered = normalized.toLowerCase();
        let canonical = null;
        let method = "raw";

        if (aliasLookup.has(lowered)) {
            canonical = aliasLookup.get(lowered);
            method = "alias";
        } else if (maps.direct.has(lowered)) {
            canonical = maps.direct.get(lowered);
            method = "direct";
        }

        if (!canonical) {
            const accentKey = stripDiacritics(normalized).toLowerCase();
            if (aliasLookup.has(accentKey)) {
                canonical = aliasLookup.get(accentKey);
                method = "alias";
            } else if (maps.accentless.has(accentKey)) {
                canonical = maps.accentless.get(accentKey);
                method = "accent-fold";
            }
        }

        if (!canonical) {
            canonical = normalized;
        }

        const changed = canonical.toLowerCase() !== raw.toLowerCase();
        const applied = method !== "raw";

        return {
            raw,
            normalized,
            canonical,
            method,
            score: null,
            applied,
            changed,
        };
    };
}
