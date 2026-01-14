import {
    resolveContainer,
    clearContainer,
    appendContent,
    createElement,
    createTextElement,
    createPlaceholder,
    formatRelativeTime,
} from "./utils.js";

const SKIP_REASON_LABELS = {
    "already-active": "Already active",
    "outfit-unchanged": "Outfit unchanged",
    "global-cooldown": "Global cooldown",
    "per-trigger-cooldown": "Per-trigger cooldown",
    "failed-trigger-cooldown": "Retry cooldown",
    "repeat-suppression": "Repeat suppression",
    "focus-lock": "Focus lock",
    "no-profile": "Profile unavailable",
    "no-name": "No detected name",
};

function describeSkip(code) {
    return SKIP_REASON_LABELS[code] || code || "Unknown reason";
}

function renderMetric(label, value) {
    const wrapper = createElement("div", "cs-scene-log__metric");
    if (!wrapper) {
        return null;
    }
    const labelEl = createTextElement("span", "cs-scene-log__metric-label", label);
    const valueEl = createTextElement("span", "cs-scene-log__metric-value", value);
    if (labelEl) {
        wrapper.appendChild(labelEl);
    }
    if (valueEl) {
        wrapper.appendChild(valueEl);
    }
    return wrapper;
}

function renderStatsList(stats, displayNames) {
    if (!(stats instanceof Map) || stats.size === 0) {
        return null;
    }
    const list = createElement("ul", "cs-scene-log__stats");
    if (!list) {
        return null;
    }
    const entries = Array.from(stats.entries()).slice(0, 8);
    entries.forEach(([normalized, count]) => {
        const name = displayNames?.get(normalized) || normalized;
        const item = createElement("li");
        if (!item) {
            return;
        }
        item.textContent = `${name} × ${count}`;
        list.appendChild(item);
    });
    return list;
}

function selectEventsForDisplay(events, { limit = 25 } = {}) {
    if (!Array.isArray(events) || events.length === 0) {
        return [];
    }
    const selected = [];
    for (let index = events.length - 1; index >= 0 && selected.length < limit; index -= 1) {
        const event = events[index];
        if (!event || typeof event !== "object") {
            continue;
        }
        if (event.type === "skipped") {
            continue;
        }
        selected.push(event);
    }
    selected.reverse();
    return selected;
}

function renderEvent(entry, displayNames, now) {
    if (!entry || typeof entry !== "object") {
        return null;
    }
    const wrapper = createElement("div", "cs-scene-log__event");
    if (!wrapper) {
        return null;
    }
    if (entry.type) {
        wrapper.dataset.eventType = entry.type;
    }
    const title = createElement("div", "cs-scene-log__event-title");
    if (title) {
        if (entry.type === "switch") {
            const folder = entry.folder ? ` → ${entry.folder}` : "";
            title.textContent = `Switch${folder}`;
        } else if (entry.type === "skipped") {
            const reason = describeSkip(entry.reason);
            const name = entry.name ? ` ${entry.name}` : "";
            title.textContent = `Skipped${name} · ${reason}`;
        } else if (entry.type === "veto") {
            title.textContent = `Veto · ${entry.match || "unknown"}`;
        } else {
            title.textContent = entry.type;
        }
        wrapper.appendChild(title);
    }
    const metaParts = [];
    if (entry.name && entry.type !== "skipped") {
        const displayName = entry.normalized ? displayNames?.get(entry.normalized) || entry.name : entry.name;
        metaParts.push(displayName);
    }
    if (entry.matchKind) {
        metaParts.push(entry.matchKind);
    }
    if (Number.isFinite(entry.charIndex)) {
        metaParts.push(`#${entry.charIndex + 1}`);
    }
    if (Number.isFinite(entry.tokenIndex)) {
        const tokenStart = entry.tokenIndex + 1;
        const tokenLength = Number.isFinite(entry.tokenLength) && entry.tokenLength > 1
            ? entry.tokenLength
            : null;
        if (tokenLength) {
            const tokenEnd = tokenStart + tokenLength - 1;
            metaParts.push(`T#${tokenStart}…${tokenEnd}`);
        } else {
            metaParts.push(`T#${tokenStart}`);
        }
    }
    if (entry.outfit?.label) {
        metaParts.push(entry.outfit.label);
    }
    const when = Number.isFinite(entry.timestamp) ? formatRelativeTime(entry.timestamp, now) : null;
    if (when) {
        metaParts.push(when);
    }
    if (metaParts.length) {
        const meta = createTextElement("div", "cs-scene-log__event-meta", metaParts.join(" • "));
        if (meta) {
            wrapper.appendChild(meta);
        }
    }
    return wrapper;
}

export function renderLiveLog(target, panelState = {}) {
    if (typeof document === "undefined") {
        return;
    }
    const container = resolveContainer(target);
    if (!container.$ && !container.el) {
        return;
    }
    clearContainer(container);

    const analytics = panelState.analytics || {};
    const events = Array.isArray(analytics.events) ? analytics.events : [];
    const stats = analytics.stats instanceof Map ? analytics.stats : null;
    const buffer = typeof analytics.buffer === "string" ? analytics.buffer : "";
    const tokenCount = Number.isFinite(analytics.tokenCount)
        ? analytics.tokenCount
        : buffer.trim()
            ? buffer.trim().split(/\s+/).filter(Boolean).length
            : 0;
    const charCount = buffer.length;
    const now = Number.isFinite(panelState.now) ? panelState.now : Date.now();

    const metrics = createElement("div", "cs-scene-log__metrics");
    if (metrics) {
        if (tokenCount > 0) {
            const tokenMetric = renderMetric("Approx. tokens", tokenCount.toString());
            if (tokenMetric) {
                metrics.appendChild(tokenMetric);
            }
        }
        const charMetric = renderMetric("Characters", charCount.toString());
        if (charMetric) {
            metrics.appendChild(charMetric);
        }
        if (Number.isFinite(analytics.updatedAt)) {
            const updatedMetric = renderMetric("Updated", formatRelativeTime(analytics.updatedAt, now) || "just now");
            if (updatedMetric) {
                metrics.appendChild(updatedMetric);
            }
        }
        if (metrics.childNodes.length) {
            appendContent(container, metrics);
        }
    }

    const statsList = renderStatsList(stats, panelState.displayNames);
    if (statsList) {
        appendContent(container, statsList);
    }

    if (!events.length) {
        const placeholder = createPlaceholder(panelState.isStreaming
            ? "Awaiting detections for this message…"
            : "No live diagnostics recorded yet.");
        appendContent(container, placeholder);
        return;
    }

    const list = createElement("div", "cs-scene-log__events");
    if (!list) {
        return;
    }

    const displayable = selectEventsForDisplay(events, { limit: 25 });
    displayable.forEach((event) => {
        const item = renderEvent(event, panelState.displayNames, now);
        if (item) {
            list.appendChild(item);
        }
    });

    appendContent(container, list);
}
