function normalizeMatchIndex(value) {
    return Number.isFinite(value) ? value : null;
}

function buildKey(name, matchKind, index) {
    const normalizedName = String(name ?? "").trim().toLowerCase();
    const kindKey = String(matchKind ?? "").toLowerCase();
    const indexKey = Number.isFinite(index) ? index : "?";
    return `${normalizedName}|${kindKey}|${indexKey}`;
}

export function mergeDetectionsForReport(report = {}) {
    const merged = [];
    const seen = new Set();

    const add = (entry) => {
        if (!entry || !entry.name) {
            return;
        }
        const matchIndex = normalizeMatchIndex(entry.matchIndex ?? entry.charIndex);
        const priority = Number.isFinite(entry.priority) ? entry.priority : null;
        const key = buildKey(entry.name, entry.matchKind, matchIndex);
        if (seen.has(key)) {
            return;
        }
        merged.push({
            name: entry.name,
            matchKind: entry.matchKind || null,
            matchIndex,
            priority,
        });
        seen.add(key);
    };

    if (Array.isArray(report.matches)) {
        report.matches.forEach(match => add(match));
    }

    if (Array.isArray(report.scoreDetails)) {
        report.scoreDetails.forEach(detail => {
            add({
                name: detail.name,
                matchKind: detail.matchKind,
                matchIndex: normalizeMatchIndex(detail.charIndex ?? detail.matchIndex),
                priority: Number.isFinite(detail.priority) ? detail.priority : null,
            });
        });
    }

    if (Array.isArray(report.events)) {
        report.events.forEach(event => {
            add({
                name: event.name,
                matchKind: event.matchKind || null,
                matchIndex: normalizeMatchIndex(event.charIndex),
                priority: null,
            });
        });
    }

    merged.sort((a, b) => {
        const aIndex = Number.isFinite(a.matchIndex) ? a.matchIndex : Number.MAX_SAFE_INTEGER;
        const bIndex = Number.isFinite(b.matchIndex) ? b.matchIndex : Number.MAX_SAFE_INTEGER;
        if (aIndex !== bIndex) {
            return aIndex - bIndex;
        }
        const aPriority = Number.isFinite(a.priority) ? a.priority : -Infinity;
        const bPriority = Number.isFinite(b.priority) ? b.priority : -Infinity;
        if (bPriority !== aPriority) {
            return bPriority - aPriority;
        }
        return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
    });

    return merged;
}

export function summarizeDetections(matches = []) {
    const summaries = new Map();
    matches.forEach(match => {
        const key = String(match.name || "").toLowerCase();
        if (!key) {
            return;
        }
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
        const kind = match.matchKind || "unknown";
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
        if (b.total !== a.total) {
            return b.total - a.total;
        }
        const aPriority = Number.isFinite(a.highestPriority) ? a.highestPriority : -Infinity;
        const bPriority = Number.isFinite(b.highestPriority) ? b.highestPriority : -Infinity;
        if (bPriority !== aPriority) {
            return bPriority - aPriority;
        }
        const aEarliest = Number.isFinite(a.earliest) ? a.earliest : Number.MAX_SAFE_INTEGER;
        const bEarliest = Number.isFinite(b.earliest) ? b.earliest : Number.MAX_SAFE_INTEGER;
        if (aEarliest !== bEarliest) {
            return aEarliest - bEarliest;
        }
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
}
