function safeClone(value) {
    if (value === undefined) {
        return undefined;
    }

    if (value instanceof RegExp) {
        return new RegExp(value.source, value.flags || "");
    }

    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch (err) {
            // Fall back to manual cloning below
        }
    }

    try {
        const json = JSON.stringify(value);
        return json === undefined ? undefined : JSON.parse(json);
    } catch (err) {
        if (value instanceof RegExp) {
            return new RegExp(value.source, value.flags || "");
        }
        if (Array.isArray(value)) {
            return value.map((item) => safeClone(item));
        }
        if (value && typeof value === 'object') {
            return Object.keys(value).reduce((acc, key) => {
                acc[key] = safeClone(value[key]);
                return acc;
            }, {});
        }
        return value;
    }
}

function normalizeOutfitVariantForSave(rawVariant = {}) {
    if (rawVariant == null) {
        return { folder: "", triggers: [] };
    }

    if (typeof rawVariant === "string") {
        const folder = rawVariant.trim();
        return { folder, triggers: [], priority: 0 };
    }

    const variant = safeClone(rawVariant) || {};

    const folder = typeof variant.folder === "string" ? variant.folder.trim() : "";
    const slot = typeof variant.slot === "string" ? variant.slot.trim() : "";
    const name = typeof variant.name === "string" ? variant.name.trim() : "";
    const label = typeof variant.label === "string" ? variant.label.trim() : (name || slot);

    const triggers = cloneStringList([
        variant.triggers,
        variant.patterns,
        variant.matchers,
        variant.trigger,
        variant.matcher,
    ]);

    const matchKinds = cloneStringList([
        variant.matchKinds,
        variant.matchKind,
        variant.kinds,
        variant.kind,
    ]).map(value => value.toLowerCase());

    const awarenessSource = typeof variant.awareness === "object" && variant.awareness !== null
        ? variant.awareness
        : {};
    const awareness = {};
    const requires = cloneStringList([
        awarenessSource.requires,
        awarenessSource.requiresAll,
        awarenessSource.all,
        variant.requires,
        variant.requiresAll,
        variant.all,
    ]);
    if (requires.length) {
        awareness.requires = requires;
    }
    const requiresAny = cloneStringList([
        awarenessSource.requiresAny,
        awarenessSource.any,
        awarenessSource.oneOf,
        variant.requiresAny,
        variant.any,
        variant.oneOf,
    ]);
    if (requiresAny.length) {
        awareness.requiresAny = requiresAny;
    }
    const excludes = cloneStringList([
        awarenessSource.excludes,
        awarenessSource.absent,
        awarenessSource.none,
        awarenessSource.forbid,
        variant.excludes,
        variant.absent,
        variant.none,
        variant.forbid,
    ]);
    if (excludes.length) {
        awareness.excludes = excludes;
    }

    const prioritySource = variant.priority ?? variant.order ?? variant.weight ?? 0;
    const priority = Number(prioritySource);

    const normalized = {
        folder,
        triggers,
        priority: Number.isFinite(priority) ? priority : 0,
    };

    if (slot) {
        normalized.slot = slot;
    }
    if (label) {
        normalized.label = label;
    }
    if (matchKinds.length) {
        normalized.matchKinds = [...new Set(matchKinds)];
    }
    if (Object.keys(awareness).length) {
        normalized.awareness = awareness;
    }

    return normalized;
}

function cloneOutfits(outfits) {
    if (!Array.isArray(outfits)) {
        return [];
    }

    const result = [];
    outfits.forEach((item) => {
        if (item == null) {
            return;
        }
        if (typeof item === "string") {
            const normalized = normalizeOutfitVariantForSave(item);
            if (normalized.folder) {
                result.push(normalized);
            }
            return;
        }
        if (typeof item === "object") {
            const normalized = normalizeOutfitVariantForSave(item);
            if (normalized && typeof normalized === "object") {
                result.push(normalized);
            }
        }
    });
    return result;
}

function cloneStringList(source) {
    if (!source) {
        return [];
    }

    const items = Array.isArray(source) ? source : [source];
    const result = [];
    items.forEach((item) => {
        if (item == null) {
            return;
        }
        if (Array.isArray(item)) {
            item.forEach((nested) => {
                if (nested == null) {
                    return;
                }
                if (nested instanceof RegExp) {
                    const pattern = nested.source;
                    const flags = nested.flags || "";
                    const literal = `/${pattern}/${flags}`;
                    const trimmed = literal.trim();
                    if (trimmed) {
                        result.push(trimmed);
                    }
                    return;
                }
                if (typeof nested === 'string') {
                    const trimmed = nested.trim();
                    if (trimmed) {
                        result.push(trimmed);
                    }
                }
            });
            return;
        }
        if (item instanceof RegExp) {
            const pattern = item.source;
            const flags = item.flags || "";
            const literal = `/${pattern}/${flags}`;
            const trimmed = literal.trim();
            if (trimmed) {
                result.push(trimmed);
            }
            return;
        }
        if (typeof item === 'string') {
            const trimmed = item.trim();
            if (trimmed) {
                result.push(trimmed);
            }
        }
    });
    return result;
}

const SCRIPT_COLLECTION_ORDER = ["global", "preset", "scoped"];

export function normalizeScriptCollections(raw, defaults = []) {
    const selections = new Set();
    const applyValue = (value) => {
        if (typeof value !== "string") {
            return;
        }
        const normalized = value.trim().toLowerCase();
        if (SCRIPT_COLLECTION_ORDER.includes(normalized)) {
            selections.add(normalized);
        }
    };

    if (Array.isArray(defaults)) {
        defaults.forEach(applyValue);
    } else if (typeof defaults === "string") {
        applyValue(defaults);
    }

    if (Array.isArray(raw)) {
        raw.forEach(applyValue);
    } else if (raw && typeof raw === "object") {
        Object.entries(raw).forEach(([key, value]) => {
            if (value) {
                applyValue(key);
            }
        });
    } else {
        applyValue(raw);
    }

    return SCRIPT_COLLECTION_ORDER.filter(key => selections.has(key));
}

export function normalizePatternSlot(entry = {}) {
    const source = entry && typeof entry === 'object' ? entry : {};
    const cloned = safeClone(source) || {};
    let fallbackName = '';
    if (typeof entry === "string") {
        fallbackName = entry.trim();
    } else if (entry instanceof RegExp) {
        fallbackName = `/${entry.source}/${entry.flags || ""}`;
    }

    const name = typeof cloned.name === 'string' ? cloned.name.trim() : fallbackName;
    const folderCandidates = [cloned.folder, cloned.path, cloned.directory, cloned.defaultFolder];
    const folderList = cloneStringList(folderCandidates);
    const folder = folderList.length ? folderList[0] : '';

    const aliasSources = [
        cloned.aliases,
        cloned.alias,
        cloned.patterns,
        cloned.names,
        cloned.variants,
        cloned.alternateNames,
        cloned.triggers,
        cloned.detect,
        cloned.detects,
    ];
    const aliases = cloneStringList(aliasSources);

    const normalized = {
        ...cloned,
        name,
        folder,
        aliases,
    };

    if (!aliases.length) {
        delete normalized.aliases;
    }

    if (!folder) {
        delete normalized.folder;
    }

    const existingId = typeof source.__slotId === 'string'
        ? source.__slotId
        : typeof cloned.__slotId === 'string'
            ? cloned.__slotId
            : null;

    if (existingId) {
        try {
            Object.defineProperty(normalized, "__slotId", {
                value: existingId,
                enumerable: false,
                configurable: true,
                writable: true,
            });
        } catch (err) {
            normalized.__slotId = existingId;
        }
    }

    return normalized;
}

export function patternSlotHasIdentity(entry = {}, { normalized = false } = {}) {
    if (!entry || typeof entry !== 'object') {
        return false;
    }

    const source = normalized ? entry : normalizePatternSlot(entry);
    if (!source || typeof source !== 'object') {
        return false;
    }

    const name = typeof source.name === 'string' ? source.name.trim() : '';
    const folder = typeof source.folder === 'string' ? source.folder.trim() : '';
    const aliases = Array.isArray(source.aliases) ? source.aliases.map((alias) => String(alias ?? '').trim()).filter(Boolean) : [];

    return Boolean(name || folder || aliases.length);
}

function cloneSlotValue(value) {
    if (Array.isArray(value)) {
        return value.map((item) => cloneSlotValue(item));
    }
    if (value && typeof value === 'object') {
        return { ...value };
    }
    return value;
}

function syncPatternSlotReference(target, source) {
    if (!target || typeof target !== 'object') {
        return source;
    }
    if (!source || typeof source !== 'object') {
        return target;
    }

    const reservedKeys = new Set(['__slotId']);
    const sourceKeys = Object.keys(source);

    for (const key of Object.keys(target)) {
        if (reservedKeys.has(key)) {
            continue;
        }
        if (!sourceKeys.includes(key)) {
            delete target[key];
        }
    }

    for (const key of sourceKeys) {
        if (reservedKeys.has(key)) {
            continue;
        }
        const value = source[key];
        if (value === undefined) {
            delete target[key];
            continue;
        }
        target[key] = cloneSlotValue(value);
    }

    return target;
}

export function reconcilePatternSlotReferences(existingSlots = [], nextSlots = []) {
    if (!Array.isArray(nextSlots)) {
        return [];
    }

    const lookup = new Map();
    if (Array.isArray(existingSlots)) {
        existingSlots.forEach((slot) => {
            if (!slot || typeof slot !== 'object') {
                return;
            }
            const slotId = typeof slot.__slotId === 'string' ? slot.__slotId : null;
            if (slotId) {
                lookup.set(slotId, slot);
            }
        });
    }

    return nextSlots.map((slot) => {
        if (!slot || typeof slot !== 'object') {
            return slot;
        }
        const slotId = typeof slot.__slotId === 'string' ? slot.__slotId : null;
        if (slotId && lookup.has(slotId)) {
            return syncPatternSlotReference(lookup.get(slotId), slot);
        }
        return slot;
    });
}

export function flattenPatternSlots(slots = []) {
    const result = [];
    const seen = new Set();

    if (!Array.isArray(slots)) {
        return result;
    }

    const addValue = (value) => {
        const trimmed = String(value ?? '').trim();
        if (!trimmed || seen.has(trimmed)) {
            return;
        }
        seen.add(trimmed);
        result.push(trimmed);
    };

    slots.forEach((slot) => {
        if (!slot || typeof slot !== 'object') {
            addValue(slot);
            return;
        }

        const normalized = normalizePatternSlot(slot);
        if (normalized.name) {
            addValue(normalized.name);
        }
        if (Array.isArray(normalized.aliases)) {
            normalized.aliases.forEach(addValue);
        }
        if (Array.isArray(normalized.patterns)) {
            normalized.patterns.forEach(addValue);
        }
    });

    return result;
}

export function preparePatternSlotsForSave(slots = [], draftIds = new Set()) {
    if (!Array.isArray(slots)) {
        return [];
    }

    const drafts = draftIds instanceof Set ? draftIds : new Set();

    return slots
        .map((slot) => {
            const normalized = normalizePatternSlot(slot);
            const slotId = typeof normalized?.__slotId === 'string'
                ? normalized.__slotId
                : typeof slot?.__slotId === 'string'
                    ? slot.__slotId
                    : null;
            const hasIdentity = patternSlotHasIdentity(normalized, { normalized: true });

            if (!hasIdentity) {
                if (slotId && drafts.has(slotId)) {
                    normalized.aliases = Array.isArray(normalized.aliases) ? [...normalized.aliases] : [];
                    return normalized;
                }
                if (slotId) {
                    drafts.delete(slotId);
                }
                return null;
            }

            if (slotId) {
                drafts.delete(slotId);
            }

            normalized.aliases = Array.isArray(normalized.aliases) ? [...normalized.aliases] : [];
            return normalized;
        })
        .filter(Boolean);
}

export function normalizeMappingEntry(entry = {}) {
    const source = entry && typeof entry === 'object' ? entry : {};
    const cloned = safeClone(source) || {};
    const name = typeof cloned.name === 'string' ? cloned.name.trim() : '';

    let defaultFolder = typeof cloned.defaultFolder === 'string' ? cloned.defaultFolder.trim() : '';
    if (!defaultFolder && typeof cloned.folder === 'string') {
        defaultFolder = cloned.folder.trim();
    }
    const outfits = cloneOutfits(cloned.outfits);

    const normalized = {
        ...cloned,
        name,
        defaultFolder,
        outfits,
    };

    const existingCardId = typeof source.__cardId === 'string'
        ? source.__cardId
        : typeof cloned.__cardId === 'string'
            ? cloned.__cardId
            : null;

    if (existingCardId) {
        try {
            Object.defineProperty(normalized, "__cardId", {
                value: existingCardId,
                enumerable: false,
                configurable: true,
                writable: true,
            });
        } catch (err) {
            normalized.__cardId = existingCardId;
        }
    }

    if (defaultFolder) {
        normalized.folder = defaultFolder;
    } else if (typeof normalized.folder === 'string') {
        normalized.folder = normalized.folder.trim();
        if (!normalized.defaultFolder && normalized.folder) {
            normalized.defaultFolder = normalized.folder;
        }
    }

    return normalized;
}

export function normalizeProfile(profile = {}, defaults = {}) {
    const base = defaults && typeof defaults === 'object' ? (safeClone(defaults) || {}) : {};
    const source = profile && typeof profile === 'object' ? (safeClone(profile) || {}) : {};
    const merged = Object.assign(base, source);

    const defaultScriptCollections = Array.isArray(defaults?.scriptCollections)
        ? defaults.scriptCollections
        : [];
    merged.scriptCollections = normalizeScriptCollections(source.scriptCollections, defaultScriptCollections);

    const originalPatternSlots = Array.isArray(profile?.patternSlots) ? profile.patternSlots : [];

    if (Array.isArray(source.patternSlots)) {
        merged.patternSlots = source.patternSlots.map((slot, index) => {
            const normalized = normalizePatternSlot(slot);
            const original = originalPatternSlots[index];
            const originalId = typeof original?.__slotId === 'string' ? original.__slotId : null;
            if (originalId && typeof normalized.__slotId !== 'string') {
                try {
                    Object.defineProperty(normalized, "__slotId", {
                        value: originalId,
                        enumerable: false,
                        configurable: true,
                    });
                } catch (err) {
                    normalized.__slotId = originalId;
                }
            }
            return normalized;
        });
    } else if (Array.isArray(source.patterns)) {
        merged.patternSlots = source.patterns.map((value) => normalizePatternSlot({ name: value }));
    } else {
        merged.patternSlots = [];
    }

    if (!Array.isArray(merged.patternSlots)) {
        merged.patternSlots = [];
    }

    merged.patterns = flattenPatternSlots(merged.patternSlots);

    const originalMappings = Array.isArray(profile?.mappings) ? profile.mappings : [];

    if (Array.isArray(source.mappings)) {
        merged.mappings = source.mappings.map((mapping, index) => {
            const normalized = normalizeMappingEntry(mapping);
            const original = originalMappings[index];
            const originalCardId = typeof original?.__cardId === 'string' ? original.__cardId : null;
            if (originalCardId && typeof normalized.__cardId !== 'string') {
                try {
                    Object.defineProperty(normalized, "__cardId", {
                        value: originalCardId,
                        enumerable: false,
                        configurable: true,
                    });
                } catch (err) {
                    normalized.__cardId = originalCardId;
                }
            }
            return normalized;
        });
    } else {
        merged.mappings = [];
    }

    merged.enableOutfits = true;

    return merged;
}

export function loadProfiles(rawProfiles = {}, defaults = {}) {
    const normalized = {};
    if (!rawProfiles || typeof rawProfiles !== 'object') {
        return normalized;
    }

    for (const [name, profile] of Object.entries(rawProfiles)) {
        normalized[name] = normalizeProfile(profile, defaults);
    }

    return normalized;
}

export function prepareMappingsForSave(mappings = [], draftIds = new Set()) {
    if (!Array.isArray(mappings)) {
        return [];
    }

    const drafts = draftIds instanceof Set ? draftIds : new Set();

    return mappings
        .map((entry) => {
            const normalized = normalizeMappingEntry(entry);
            const cardId = typeof normalized?.__cardId === 'string'
                ? normalized.__cardId
                : typeof entry?.__cardId === 'string'
                    ? entry.__cardId
                    : null;
            const hasIdentity = mappingHasIdentity(normalized, { normalized: true });

            if (!hasIdentity) {
                if (cardId && drafts.has(cardId)) {
                    normalized.outfits = cloneOutfits(normalized.outfits);
                    return normalized;
                }
                if (cardId) {
                    drafts.delete(cardId);
                }
                return null;
            }

            if (cardId) {
                drafts.delete(cardId);
            }

            normalized.outfits = cloneOutfits(normalized.outfits);
            return normalized;
        })
        .filter(Boolean);
}

export function mappingHasIdentity(entry = {}, { normalized = false } = {}) {
    if (!entry || typeof entry !== 'object') {
        return false;
    }

    const source = normalized ? entry : normalizeMappingEntry(entry);
    if (!source || typeof source !== 'object') {
        return false;
    }

    const name = typeof source.name === 'string' ? source.name.trim() : '';
    const defaultFolder = typeof source.defaultFolder === 'string' ? source.defaultFolder.trim() : '';
    const folder = typeof source.folder === 'string' ? source.folder.trim() : '';

    return Boolean(name || defaultFolder || folder);
}
