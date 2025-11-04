function safeClone(value) {
    if (value === undefined) {
        return undefined;
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

function cloneOutfits(outfits) {
    if (!Array.isArray(outfits)) {
        return [];
    }

    const result = [];
    outfits.forEach((item) => {
        if (item == null) {
            return;
        }
        if (typeof item === 'string') {
            const trimmed = item.trim();
            if (trimmed) {
                result.push(trimmed);
            }
            return;
        }
        if (typeof item === 'object') {
            const cloned = safeClone(item);
            if (cloned && typeof cloned === 'object') {
                result.push(cloned);
            }
        }
    });
    return result;
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
