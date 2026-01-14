function createSceneSnapshot() {
    return {
        key: null,
        messageId: null,
        roster: [],
        displayNames: [],
        lastEvent: null,
        updatedAt: 0,
    };
}

function normalizeKey(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.trim().toLowerCase();
}

function cloneEvent(event) {
    if (!event || typeof event !== "object") {
        return null;
    }
    const copy = {
        ...event,
    };
    if (event.outfit && typeof event.outfit === "object") {
        copy.outfit = { ...event.outfit };
    }
    return copy;
}

function normalizeDisplayNameMap(displayNames) {
    if (!displayNames) {
        return new Map();
    }
    if (displayNames instanceof Map) {
        return new Map(displayNames);
    }
    if (Array.isArray(displayNames)) {
        const pairs = displayNames.filter((entry) => Array.isArray(entry) && entry.length >= 2);
        return new Map(pairs.map(([key, value]) => [normalizeKey(key), value]));
    }
    if (typeof displayNames === "object") {
        return new Map(Object.entries(displayNames).map(([key, value]) => [normalizeKey(key), value]));
    }
    return new Map();
}

function normalizeEvent(event, fallbackTimestamp) {
    if (!event || typeof event !== "object") {
        return null;
    }
    const normalized = normalizeKey(event.name);
    const hasDetails = normalized || typeof event.matchKind === "string" || Number.isFinite(event.charIndex);
    if (!hasDetails) {
        return null;
    }
    return {
        name: typeof event.name === "string" ? event.name : normalized || null,
        normalized: normalized || null,
        matchKind: typeof event.matchKind === "string" ? event.matchKind : null,
        charIndex: Number.isFinite(event.charIndex) ? event.charIndex : null,
        timestamp: Number.isFinite(event.timestamp) ? event.timestamp : fallbackTimestamp,
    };
}

let currentScene = createSceneSnapshot();
const sceneMembers = new Map();
const sceneDisplayNames = new Map();
let rosterUpdatedAt = 0;
const liveTesterOutputs = new Map();
let liveTesterUpdatedAt = 0;
let liveTesterPreprocessedText = "";

function resolveDisplayName(normalized, displayNames) {
    if (displayNames.has(normalized)) {
        return displayNames.get(normalized);
    }
    if (sceneDisplayNames.has(normalized)) {
        return sceneDisplayNames.get(normalized);
    }
    const existing = sceneMembers.get(normalized);
    if (existing?.name) {
        return existing.name;
    }
    return normalized;
}

function cloneRosterEntry(entry) {
    return {
        name: entry.name,
        normalized: entry.normalized,
        joinedAt: entry.joinedAt,
        lastSeenAt: entry.lastSeenAt,
        lastLeftAt: entry.lastLeftAt,
        active: Boolean(entry.active),
        turnsRemaining: Number.isFinite(entry.turnsRemaining) ? entry.turnsRemaining : null,
    };
}

function normalizeTurnsByMember(value) {
    if (!value) {
        return null;
    }
    const map = new Map();
    const assign = (key, raw) => {
        const normalized = normalizeKey(key);
        if (!normalized || !Number.isFinite(raw)) {
            return;
        }
        map.set(normalized, Math.max(0, Math.floor(raw)));
    };
    if (value instanceof Map) {
        value.forEach((raw, key) => assign(key, raw));
        return map.size ? map : null;
    }
    if (Array.isArray(value)) {
        value.forEach((entry) => {
            if (Array.isArray(entry) && entry.length >= 2) {
                assign(entry[0], entry[1]);
            } else if (entry && typeof entry === "object") {
                const key = entry.normalized ?? entry.name;
                assign(key, entry.turnsRemaining);
            }
        });
        return map.size ? map : null;
    }
    if (typeof value === "object") {
        Object.entries(value).forEach(([key, raw]) => assign(key, raw));
        return map.size ? map : null;
    }
    return null;
}

function cloneTesterOutput(entry) {
    return {
        name: entry.name,
        normalized: entry.normalized,
        events: entry.events.map(cloneEvent),
        summary: { ...entry.summary },
        lastEvent: entry.lastEvent ? cloneEvent(entry.lastEvent) : null,
        activeInRoster: entry.activeInRoster,
        updatedAt: entry.updatedAt,
    };
}

function sanitizeTurnValue(value) {
    if (!Number.isFinite(value)) {
        return null;
    }
    return Math.max(0, Math.floor(value));
}

export function resetSceneState() {
    currentScene = createSceneSnapshot();
    sceneMembers.clear();
    sceneDisplayNames.clear();
    rosterUpdatedAt = Date.now();
    return getCurrentSceneSnapshot();
}

export function getCurrentSceneSnapshot() {
    return {
        key: currentScene.key,
        messageId: currentScene.messageId,
        roster: Array.from(sceneMembers.values()).map(cloneRosterEntry),
        displayNames: new Map(sceneDisplayNames),
        lastEvent: currentScene.lastEvent ? { ...currentScene.lastEvent } : null,
        updatedAt: currentScene.updatedAt,
    };
}

export function applySceneRosterUpdate({
    key = currentScene.key,
    messageId = currentScene.messageId,
    roster = [],
    displayNames = null,
    lastMatch = null,
    updatedAt = null,
    turnsRemaining = null,
    turnsByMember = null,
} = {}, options = {}) {
    const { preserveActiveOnEmpty = false } = options || {};
    const normalizedDisplayNames = normalizeDisplayNameMap(displayNames);
    const activeSet = new Set();
    const sanitizedTurns = Number.isFinite(turnsRemaining) ? Math.max(0, Math.floor(turnsRemaining)) : null;
    const perMemberTurns = normalizeTurnsByMember(turnsByMember);

    const timestampFallback = Number.isFinite(currentScene?.updatedAt) && currentScene.updatedAt > 0
        ? currentScene.updatedAt
        : Date.now();
    const timestamp = Number.isFinite(updatedAt) ? updatedAt : timestampFallback;

    const values = Array.isArray(roster) ? roster : [];
    const shouldPreserveExisting = preserveActiveOnEmpty && values.length === 0;
    values.forEach((value) => {
        let normalized = null;
        let providedName = null;
        let providedJoinedAt = null;
        let providedLastSeenAt = null;
        let providedLastLeftAt = null;
        let providedTurns = null;
        if (value && typeof value === "object") {
            if (typeof value.normalized === "string" && value.normalized.trim()) {
                normalized = value.normalized.trim().toLowerCase();
            } else if (typeof value.name === "string" && value.name.trim()) {
                normalized = value.name.trim().toLowerCase();
            }
            if (typeof value.name === "string" && value.name.trim()) {
                providedName = value.name.trim();
            }
            if (Number.isFinite(value.joinedAt)) {
                providedJoinedAt = value.joinedAt;
            }
            if (Number.isFinite(value.lastSeenAt)) {
                providedLastSeenAt = value.lastSeenAt;
            }
            if (Number.isFinite(value.lastLeftAt)) {
                providedLastLeftAt = value.lastLeftAt;
            }
            if (Number.isFinite(value.turnsRemaining)) {
                providedTurns = Math.max(0, Math.floor(value.turnsRemaining));
            }
        } else {
            normalized = normalizeKey(value);
        }
        if (!normalized || activeSet.has(normalized)) {
            return;
        }
        activeSet.add(normalized);
        if (providedName) {
            normalizedDisplayNames.set(normalized, providedName);
        }
        const name = providedName || resolveDisplayName(normalized, normalizedDisplayNames);
        const existing = sceneMembers.get(normalized);
        const joinedAt = providedJoinedAt ?? existing?.joinedAt ?? timestamp;
        const lastSeenAt = Number.isFinite(providedLastSeenAt)
            ? providedLastSeenAt
            : (Number.isFinite(existing?.lastSeenAt) ? Math.max(existing.lastSeenAt, timestamp) : timestamp);
        const lastLeftAt = Number.isFinite(providedLastLeftAt)
            ? providedLastLeftAt
            : (Number.isFinite(existing?.lastLeftAt) ? existing.lastLeftAt : null);
        let entryTurns = providedTurns;
        if (!Number.isFinite(entryTurns) && perMemberTurns?.has(normalized)) {
            entryTurns = perMemberTurns.get(normalized);
        }
        if (!Number.isFinite(entryTurns)) {
            entryTurns = sanitizedTurns;
        }
        sceneMembers.set(normalized, {
            name,
            normalized,
            joinedAt,
            lastSeenAt,
            lastLeftAt,
            active: true,
            turnsRemaining: Number.isFinite(entryTurns) ? entryTurns : null,
        });
        sceneDisplayNames.set(normalized, name);
    });

    if (!shouldPreserveExisting) {
        for (const [normalized, member] of sceneMembers.entries()) {
            if (!activeSet.has(normalized) && member.active) {
                sceneMembers.set(normalized, {
                    ...member,
                    active: false,
                    lastLeftAt: timestamp,
                    turnsRemaining: null,
                });
            }
        }
    } else {
        for (const normalized of activeSet.values()) {
            const member = sceneMembers.get(normalized);
            if (member) {
                member.active = true;
            }
        }
    }

    normalizedDisplayNames.forEach((value, normalized) => {
        if (!sceneDisplayNames.has(normalized)) {
            sceneDisplayNames.set(normalized, value);
        }
    });

    rosterUpdatedAt = timestamp;

    const normalizedEvent = normalizeEvent(lastMatch, timestamp);

    currentScene = {
        key: key || null,
        messageId: Number.isFinite(messageId) ? messageId : null,
        roster: Array.from(sceneMembers.values()).map(cloneRosterEntry),
        displayNames: Array.from(sceneDisplayNames.entries()),
        lastEvent: normalizedEvent ? { ...normalizedEvent } : null,
        updatedAt: timestamp,
    };

    return getCurrentSceneSnapshot();
}

export function getRosterMembershipSnapshot() {
    return {
        updatedAt: rosterUpdatedAt,
        members: Array.from(sceneMembers.values()).map(cloneRosterEntry),
    };
}

export function listRosterMembers() {
    return Array.from(sceneMembers.values()).map(cloneRosterEntry);
}

export function setRosterMember(name, data = {}) {
    const normalized = normalizeKey(name || data.name);
    if (!normalized) {
        return null;
    }
    const now = Date.now();
    const existing = sceneMembers.get(normalized);
    const turnsRemaining = Number.isFinite(data.turnsRemaining)
        ? Math.max(0, Math.floor(data.turnsRemaining))
        : Number.isFinite(existing?.turnsRemaining)
            ? existing.turnsRemaining
            : null;
    const entry = {
        name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : existing?.name || normalized,
        normalized,
        joinedAt: Number.isFinite(data.joinedAt) ? data.joinedAt : existing?.joinedAt ?? now,
        lastSeenAt: Number.isFinite(data.lastSeenAt) ? data.lastSeenAt : existing?.lastSeenAt ?? now,
        lastLeftAt: Number.isFinite(data.lastLeftAt) ? data.lastLeftAt : existing?.lastLeftAt ?? null,
        active: typeof data.active === "boolean" ? data.active : existing?.active ?? true,
        turnsRemaining,
    };
    if (!entry.active && entry.lastLeftAt == null) {
        entry.lastLeftAt = entry.lastSeenAt;
        entry.turnsRemaining = null;
    }
    sceneMembers.set(normalized, entry);
    sceneDisplayNames.set(normalized, entry.name);
    rosterUpdatedAt = now;
    currentScene = {
        ...currentScene,
        roster: Array.from(sceneMembers.values()).map(cloneRosterEntry),
        displayNames: Array.from(sceneDisplayNames.entries()),
        updatedAt: now,
    };
    return cloneRosterEntry(entry);
}

export function removeRosterMember(name) {
    const normalized = normalizeKey(name);
    if (!normalized) {
        return false;
    }
    const removed = sceneMembers.delete(normalized);
    if (removed) {
        rosterUpdatedAt = Date.now();
        sceneDisplayNames.delete(normalized);
        currentScene = {
            ...currentScene,
            roster: Array.from(sceneMembers.values()).map(cloneRosterEntry),
            displayNames: Array.from(sceneDisplayNames.entries()),
            updatedAt: rosterUpdatedAt,
        };
    }
    return removed;
}

export function clearRosterMembership() {
    sceneMembers.clear();
    sceneDisplayNames.clear();
    rosterUpdatedAt = Date.now();
    currentScene = {
        ...currentScene,
        roster: [],
        displayNames: [],
        updatedAt: rosterUpdatedAt,
    };
    return rosterUpdatedAt;
}

export function replaceLiveTesterOutputs(events = [], {
    roster = [],
    displayNames = null,
    timestamp = Date.now(),
    preprocessedText = null,
} = {}) {
    liveTesterOutputs.clear();
    const normalizedDisplayNames = normalizeDisplayNameMap(displayNames);
    const activeRoster = new Set();
    const rosterValues = Array.isArray(roster) ? roster : [];
    rosterValues.forEach((value) => {
        const normalized = normalizeKey(value);
        if (normalized) {
            activeRoster.add(normalized);
            if (!normalizedDisplayNames.has(normalized)) {
                normalizedDisplayNames.set(normalized, value);
            }
        }
    });

    const aggregator = new Map();
    events.forEach((event) => {
        if (!event || typeof event !== "object") {
            return;
        }
        const normalized = normalizeKey(event.name);
        if (!normalized) {
            return;
        }
        const bucket = aggregator.get(normalized) || {
            name: normalizedDisplayNames.get(normalized) || event.name || normalized,
            normalized,
            events: [],
            summary: { switches: 0, skips: 0, vetoes: 0 },
            lastEvent: null,
        };
        bucket.events.push(event);
        bucket.lastEvent = event;
        if (event.type === "switch") {
            bucket.summary.switches += 1;
        } else if (event.type === "skipped") {
            bucket.summary.skips += 1;
        } else if (event.type === "veto") {
            bucket.summary.vetoes += 1;
        }
        aggregator.set(normalized, bucket);
    });

    for (const [normalized, bucket] of aggregator.entries()) {
        const name = normalizedDisplayNames.get(normalized) || bucket.name || normalized;
        liveTesterOutputs.set(normalized, {
            name,
            normalized,
            events: bucket.events.map(cloneEvent),
            summary: { ...bucket.summary },
            lastEvent: bucket.lastEvent ? cloneEvent(bucket.lastEvent) : null,
            activeInRoster: activeRoster.has(normalized),
            updatedAt: timestamp,
        });
        activeRoster.delete(normalized);
    }

    for (const normalized of activeRoster.values()) {
        const name = normalizedDisplayNames.get(normalized) || normalized;
        liveTesterOutputs.set(normalized, {
            name,
            normalized,
            events: [],
            summary: { switches: 0, skips: 0, vetoes: 0 },
            lastEvent: null,
            activeInRoster: true,
            updatedAt: timestamp,
        });
    }

    liveTesterUpdatedAt = timestamp;
    liveTesterPreprocessedText = typeof preprocessedText === "string" ? preprocessedText : "";
    return getLiveTesterOutputsSnapshot();
}

export function getLiveTesterOutputsSnapshot() {
    return {
        updatedAt: liveTesterUpdatedAt,
        entries: Array.from(liveTesterOutputs.values()).map(cloneTesterOutput),
        preprocessedText: liveTesterPreprocessedText,
    };
}

export function getLiveTesterOutput(name) {
    const normalized = normalizeKey(name);
    if (!normalized) {
        return null;
    }
    const entry = liveTesterOutputs.get(normalized);
    return entry ? cloneTesterOutput(entry) : null;
}

export function clearLiveTesterOutputs() {
    liveTesterOutputs.clear();
    liveTesterUpdatedAt = Date.now();
    liveTesterPreprocessedText = "";
    return liveTesterUpdatedAt;
}

export function listLiveTesterOutputs() {
    return Array.from(liveTesterOutputs.values()).map(cloneTesterOutput);
}

export function getLiveTesterOutputsMap() {
    return new Map(Array.from(liveTesterOutputs.entries()).map(([key, value]) => [key, cloneTesterOutput(value)]));
}

export function getRosterMember(name) {
    const normalized = normalizeKey(name);
    if (!normalized) {
        return null;
    }
    const entry = sceneMembers.get(normalized);
    return entry ? cloneRosterEntry(entry) : null;
}

export function getRosterMembersMap() {
    return new Map(Array.from(sceneMembers.entries()).map(([key, value]) => [key, cloneRosterEntry(value)]));
}

export function deriveSceneRosterState({
    messageState = null,
    sceneSnapshot = null,
    testerSnapshot = null,
    now = Date.now(),
} = {}) {
    const scene = sceneSnapshot || getCurrentSceneSnapshot();
    const displayNames = scene.displayNames instanceof Map
        ? new Map(scene.displayNames)
        : Array.isArray(scene.displayNames)
            ? new Map(scene.displayNames)
            : new Map();

    const removedNames = messageState?.removedRoster instanceof Set
        ? new Set(Array.from(messageState.removedRoster).map(normalizeKey).filter(Boolean))
        : null;
    const rosterByName = new Map();
    const baseRoster = Array.isArray(scene.roster) ? scene.roster : [];
    baseRoster.forEach((entry) => {
        if (!entry || typeof entry !== "object") {
            return;
        }
        const normalized = normalizeKey(entry.normalized ?? entry.name);
        if (!normalized) {
            return;
        }
        if (removedNames?.has(normalized)) {
            return;
        }
        const name = entry.name || displayNames.get(normalized) || normalized;
        displayNames.set(normalized, name);
        rosterByName.set(normalized, {
            name,
            normalized,
            joinedAt: Number.isFinite(entry.joinedAt) ? entry.joinedAt : null,
            lastSeenAt: Number.isFinite(entry.lastSeenAt) ? entry.lastSeenAt : null,
            lastLeftAt: Number.isFinite(entry.lastLeftAt) ? entry.lastLeftAt : null,
            active: Boolean(entry.active),
            turnsRemaining: Number.isFinite(entry.turnsRemaining)
                ? Math.max(0, Math.floor(entry.turnsRemaining))
                : null,
        });
    });

    const testerMap = new Map();
    if (testerSnapshot && Array.isArray(testerSnapshot.entries)) {
        testerSnapshot.entries.forEach((entry) => {
            if (!entry || typeof entry !== "object") {
                return;
            }
            const normalized = normalizeKey(entry.normalized ?? entry.name);
            if (!normalized) {
                return;
            }
            testerMap.set(normalized, cloneTesterOutput(entry));
            if (entry.name && !displayNames.has(normalized)) {
                displayNames.set(normalized, entry.name);
            }
        });
    }

    const activeNames = new Set();
    if (messageState?.sceneRoster instanceof Set) {
        messageState.sceneRoster.forEach((value) => {
            const normalized = normalizeKey(value);
            if (!normalized) {
                return;
            }
            if (removedNames?.has(normalized)) {
                return;
            }
            activeNames.add(normalized);
            const current = rosterByName.get(normalized) || {
                name: displayNames.get(normalized) || (typeof value === "string" ? value : normalized),
                normalized,
                joinedAt: null,
                lastSeenAt: null,
                lastLeftAt: null,
                active: true,
                turnsRemaining: null,
            };
            current.active = true;
            if (!Number.isFinite(current.lastSeenAt)) {
                const fallback = Number.isFinite(scene.updatedAt) ? scene.updatedAt : now;
                current.lastSeenAt = fallback;
            }
            rosterByName.set(normalized, current);
        });
    }

    if (messageState?.sceneRoster instanceof Set) {
        rosterByName.forEach((entry, normalized) => {
            if (!activeNames.has(normalized)) {
                entry.active = false;
            }
        });
    }

    const perMemberTurns = messageState?.rosterTurns instanceof Map
        ? messageState.rosterTurns
        : null;
    if (perMemberTurns) {
        perMemberTurns.forEach((value, key) => {
            const normalized = normalizeKey(key);
            if (!normalized) {
                return;
            }
            const entry = rosterByName.get(normalized);
            if (!entry) {
                return;
            }
            const sanitized = sanitizeTurnValue(value);
            if (sanitized != null) {
                entry.turnsRemaining = sanitized;
            }
        });
    }

    const defaultTurns = sanitizeTurnValue(messageState?.defaultRosterTTL);
    if (defaultTurns != null) {
        rosterByName.forEach((entry, normalized) => {
            if (activeNames.has(normalized) && !Number.isFinite(entry.turnsRemaining)) {
                entry.turnsRemaining = defaultTurns;
            }
        });
    }

    const latestNormalized = scene?.lastEvent?.normalized
        ? normalizeKey(scene.lastEvent.normalized)
        : null;

    rosterByName.forEach((entry, normalized) => {
        if (!displayNames.has(normalized)) {
            displayNames.set(normalized, entry.name || normalized);
        }
        entry.tester = testerMap.get(normalized) || null;
        entry.isLatest = latestNormalized ? normalized === latestNormalized : false;
    });

    const finalRoster = Array.from(rosterByName.entries())
        .filter(([normalized]) => !(removedNames && removedNames.has(normalized)))
        .map(([, entry]) => entry);
    finalRoster.sort((a, b) => {
        if (a.active !== b.active) {
            return a.active ? -1 : 1;
        }
        const aSeen = Number.isFinite(a.lastSeenAt) ? a.lastSeenAt : 0;
        const bSeen = Number.isFinite(b.lastSeenAt) ? b.lastSeenAt : 0;
        if (aSeen !== bSeen) {
            return bSeen - aSeen;
        }
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    return {
        key: scene.key || null,
        messageId: Number.isFinite(scene.messageId) ? scene.messageId : null,
        roster: finalRoster,
        displayNames,
        lastEvent: scene.lastEvent ? { ...scene.lastEvent } : null,
        updatedAt: Number.isFinite(scene.updatedAt) ? scene.updatedAt : null,
    };
}

