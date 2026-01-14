import {
    resolveContainer,
    clearContainer,
    createElement,
} from "./utils.js";

function renderPlaceholder(target, message, tone = "muted") {
    const container = resolveContainer(target);
    if (!container.$ && !container.el) {
        return;
    }
    clearContainer(container);
    const wrapper = createElement("div", "cs-scene-panel__placeholder");
    if (!wrapper) {
        return;
    }
    if (tone) {
        wrapper.dataset.tone = tone;
    }
    wrapper.textContent = message;
    if (container.$ && typeof container.$.append === "function") {
        container.$.append(wrapper);
    } else if (container.el) {
        container.el.appendChild(wrapper);
    }
}

function normalizeValues(values) {
    if (!Array.isArray(values)) {
        return [];
    }
    return values
        .map((value) => typeof value === "string" ? value.trim() : "")
        .filter(Boolean);
}

function renderList(target, values = [], type, { hasBuffer }) {
    const container = resolveContainer(target);
    if (!container.$ && !container.el) {
        return;
    }
    clearContainer(container);
    const normalizedValues = normalizeValues(values);
    if (normalizedValues.length === 0) {
        const message = hasBuffer
            ? "No coverage gaps detected."
            : "Coverage suggestions will appear after the next assistant message.";
        const tone = hasBuffer ? "informative" : "muted";
        renderPlaceholder(container, message, tone);
        return;
    }
    const list = createElement("div", "cs-coverage-list");
    if (!list) {
        return;
    }
    normalizedValues.forEach((value) => {
        const pill = createElement("button", "cs-coverage-pill");
        if (!pill) {
            return;
        }
        pill.type = "button";
        pill.dataset.type = type;
        pill.dataset.value = value;
        pill.textContent = value;
        list.appendChild(pill);
    });
    if (container.$ && typeof container.$.append === "function") {
        container.$.append(list);
        return;
    }
    if (container.el) {
        container.el.appendChild(list);
    }
}

function applySectionState(wrapper, { hasSuggestions, hasBuffer }) {
    if (!wrapper.$ && !wrapper.el) {
        return;
    }
    const state = hasSuggestions
        ? "ready"
        : hasBuffer
            ? "complete"
            : "pending";
    const hasContent = hasSuggestions ? "true" : "false";
    if (wrapper.el) {
        wrapper.el.dataset.state = state;
        wrapper.el.setAttribute("data-has-content", hasContent);
    }
    if (wrapper.$ && typeof wrapper.$.attr === "function") {
        wrapper.$.attr("data-state", state);
        wrapper.$.attr("data-has-content", hasContent);
    }
}

export function renderCoverageSection(targets = {}, coverage = {}, { hasBuffer = false } = {}) {
    const normalizedCoverage = coverage && typeof coverage === "object"
        ? coverage
        : {};
    const pronouns = normalizeValues(normalizedCoverage.missingPronouns);
    const attribution = normalizeValues(normalizedCoverage.missingAttributionVerbs);
    const action = normalizeValues(normalizedCoverage.missingActionVerbs);
    const hasSuggestions = pronouns.length > 0 || attribution.length > 0 || action.length > 0;

    const wrapper = resolveContainer(targets.section);
    applySectionState(wrapper, { hasSuggestions, hasBuffer });

    renderList(targets.pronouns, pronouns, "pronoun", { hasBuffer });
    renderList(targets.attribution, attribution, "attribution", { hasBuffer });
    renderList(targets.action, action, "action", { hasBuffer });
}

export function renderCoverageSuggestions(targets = {}, panelState = {}) {
    const coverage = panelState.coverage || {};
    const hasBuffer = typeof panelState.analytics?.buffer === "string"
        ? panelState.analytics.buffer.trim().length > 0
        : false;
    renderCoverageSection(targets, coverage, { hasBuffer });
}
