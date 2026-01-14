import {
    resolveContainer,
    clearContainer,
    appendContent,
    createElement,
    createTextElement,
    createPlaceholder,
    formatRelativeTime,
} from "./utils.js";

function renderCard(entry, { displayNames, now, pinned = false }) {
    const container = createElement("article", "cs-scene-active__card");
    if (!container) {
        return null;
    }
    if (entry.normalized) {
        container.dataset.character = entry.normalized;
    }
    if (entry.inSceneRoster) {
        container.dataset.roster = "true";
    }
    if (pinned) {
        if (container.classList && typeof container.classList.add === "function") {
            container.classList.add("cs-scene-active__card--pinned");
        } else {
            const classes = new Set(String(container.className || "").split(/\s+/).filter(Boolean));
            classes.add("cs-scene-active__card--pinned");
            container.className = Array.from(classes).join(" ");
        }
        const badge = createElement("span", "cs-scene-active__pin");
        if (badge) {
            const icon = createElement("i", "fa-solid fa-thumbtack");
            if (icon) {
                icon.setAttribute("aria-hidden", "true");
                badge.appendChild(icon);
            }
            const label = createElement("span");
            if (label) {
                label.textContent = "Pinned focus";
                badge.appendChild(label);
            }
            container.appendChild(badge);
        }
    }
    const name = entry.name || (entry.normalized ? displayNames?.get(entry.normalized) : null) || entry.normalized || "Unknown";
    const title = createTextElement("h5", "cs-scene-active__name", name);
    if (title) {
        container.appendChild(title);
    }
    const detailParts = [];
    if (Number.isFinite(entry.count)) {
        detailParts.push(`${entry.count} detection${entry.count === 1 ? "" : "s"}`);
    }
    if (Number.isFinite(entry.score)) {
        detailParts.push(`Score ${entry.score}`);
    } else if (Number.isFinite(entry.bestPriority)) {
        detailParts.push(`Priority ${entry.bestPriority}`);
    }
    if (detailParts.length) {
        const detail = createTextElement("p", "cs-scene-active__details", detailParts.join(" • "));
        if (detail) {
            container.appendChild(detail);
        }
    }
    if (Array.isArray(entry.events) && entry.events.length) {
        const lastEvent = entry.events[entry.events.length - 1];
        const when = Number.isFinite(lastEvent.timestamp) ? formatRelativeTime(lastEvent.timestamp, now) : null;
        const eventParts = [];
        if (lastEvent.type) {
            eventParts.push(lastEvent.type);
        }
        if (lastEvent.matchKind) {
            eventParts.push(lastEvent.matchKind);
        }
        if (Number.isFinite(lastEvent.charIndex)) {
            eventParts.push(`#${lastEvent.charIndex + 1}`);
        }
        if (Number.isFinite(lastEvent.tokenIndex)) {
            const tokenStart = lastEvent.tokenIndex + 1;
            const tokenLength = Number.isFinite(lastEvent.tokenLength) && lastEvent.tokenLength > 1
                ? lastEvent.tokenLength
                : null;
            if (tokenLength) {
                const tokenEnd = tokenStart + tokenLength - 1;
                eventParts.push(`T#${tokenStart}…${tokenEnd}`);
            } else {
                eventParts.push(`T#${tokenStart}`);
            }
        }
        if (when) {
            eventParts.push(when);
        }
        const eventLine = createTextElement("p", "cs-scene-active__event", eventParts.join(" · "));
        if (eventLine) {
            container.appendChild(eventLine);
        }
    }
    return container;
}

export function renderActiveCharacters(target, panelState = {}) {
    if (typeof document === "undefined") {
        return;
    }
    const container = resolveContainer(target);
    if (!container.$ && !container.el) {
        return;
    }
    clearContainer(container);

    const ranking = Array.isArray(panelState.ranking) ? panelState.ranking : [];
    const autoPinActive = panelState.settings?.autoPinActive !== false;
    if (container.el) {
        if (autoPinActive) {
            container.el.setAttribute("data-pin-mode", "true");
        } else {
            container.el.removeAttribute("data-pin-mode");
        }
    } else if (container.$ && typeof container.$.attr === "function") {
        if (autoPinActive) {
            container.$.attr("data-pin-mode", "true");
        } else if (typeof container.$.removeAttr === "function") {
            container.$.removeAttr("data-pin-mode");
        } else {
            container.$.attr("data-pin-mode", "false");
        }
    }
    if (!ranking.length) {
        const placeholder = createPlaceholder("No recent detections to highlight.");
        appendContent(container, placeholder);
        return;
    }

    const fragment = document.createDocumentFragment();
    const now = Number.isFinite(panelState.now) ? panelState.now : Date.now();
    ranking.forEach((entry, index) => {
        if (!entry || typeof entry !== "object") {
            return;
        }
        const card = renderCard(entry, {
            displayNames: panelState.displayNames,
            now,
            pinned: autoPinActive && index === 0,
        });
        if (card) {
            fragment.appendChild(card);
        }
    });

    appendContent(container, fragment);
}
