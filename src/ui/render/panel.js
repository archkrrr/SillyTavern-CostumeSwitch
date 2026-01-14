import {
    getScenePanelContainer,
    getSceneCollapseToggle,
    getSceneRosterList,
    getSceneActiveCards,
    getSceneLiveLog,
    getSceneRosterSection,
    getSceneActiveSection,
    getSceneLiveLogSection,
    getSceneStatusText,
    getSceneCoverageSection,
    getSceneCoveragePronouns,
    getSceneCoverageAttribution,
    getSceneCoverageAction,
    getSceneSectionsContainer,
    getScenePanelContent,
} from "../scenePanelState.js";
import { renderSceneRoster } from "./sceneRoster.js";
import { renderActiveCharacters } from "./activeCharacters.js";
import { renderLiveLog } from "./liveLog.js";
import { renderCoverageSection } from "./coverage.js";
import { resolveContainer, clearContainer, createElement } from "./utils.js";

let scenePanelSummonButton = null;
let scenePanelSummonButtonObserver = null;
let scenePanelSummonParentObserver = null;
let scenePanelSummonParentObserverTarget = null;
let scenePanelSummonRestoring = false;
let scenePanelViewportQuery = null;
let scenePanelSheetMode = false;
let scenePanelSheetReturnFocus = null;
let scenePanelContentHome = null;
let lastPanelEnabledState = false;
let lastPanelCollapsedState = false;
let lastScenePanelSummonState = {
    enabled: false,
    collapsed: false,
};

function isHTMLElement(node) {
    return typeof HTMLElement !== "undefined" && node instanceof HTMLElement;
}

function applyScenePanelSummonInlineStyles(button) {
    if (!button || !button.style) {
        return;
    }
    try {
        button.style.setProperty("display", "inline-flex", "important");
        button.style.setProperty("visibility", "visible", "important");
        button.style.setProperty("opacity", "1", "important");
    } catch (err) {
    }
}

function getScenePanelSummonParent() {
    if (typeof document === "undefined") {
        return null;
    }
    return document.body || null;
}

function getScenePanelLayerElement() {
    if (typeof document === "undefined") {
        return null;
    }
    return document.getElementById("cs-scene-panel-layer");
}

function getScenePanelLayerSheetBody() {
    const layer = getScenePanelLayerElement();
    if (!layer) {
        return null;
    }
    return layer.querySelector('[data-scene-panel="sheet-body"]');
}

function getScenePanelLayerCloseButton() {
    const layer = getScenePanelLayerElement();
    if (!layer) {
        return null;
    }
    return layer.querySelector('[data-scene-panel="close-layer"]');
}

function rememberScenePanelContentHome(element) {
    if (!element || scenePanelContentHome) {
        return;
    }
    const parent = element.parentNode;
    const nextSibling = element.nextSibling;
    if (parent) {
        scenePanelContentHome = { parent, nextSibling };
    }
}

function restoreScenePanelContentHome(element) {
    if (!element || !scenePanelContentHome?.parent) {
        return;
    }
    const { parent, nextSibling } = scenePanelContentHome;
    if (nextSibling && nextSibling.parentNode === parent) {
        parent.insertBefore(element, nextSibling);
    } else {
        parent.appendChild(element);
    }
}

function moveScenePanelContentToSheet() {
    const content = getScenePanelContent?.();
    const { el } = resolveContainer(content);
    const sheetBody = getScenePanelLayerSheetBody();
    if (!el || !sheetBody) {
        return false;
    }
    rememberScenePanelContentHome(el);
    if (el.parentNode !== sheetBody) {
        sheetBody.appendChild(el);
    }
    return true;
}

function updateScenePanelSummonTarget() {
    const button = ensureScenePanelSummonButton();
    if (!button) {
        return;
    }
    const targetId = scenePanelSheetMode ? "cs-scene-panel-layer" : "cs-scene-panel";
    button.setAttribute("aria-controls", targetId);
    button.dataset.viewport = scenePanelSheetMode ? "compact" : "default";
}

function focusScenePanelLayerClose() {
    const closeButton = getScenePanelLayerCloseButton();
    if (!closeButton || typeof closeButton.focus !== "function") {
        return;
    }
    setTimeout(() => {
        try {
            closeButton.focus({ preventScroll: true });
        } catch (err) {
            closeButton.focus();
        }
    }, 0);
}

function openScenePanelSheetLayer() {
    const layer = getScenePanelLayerElement();
    if (!layer) {
        return;
    }
    layer.dataset.panelSheet = "true";
    layer.dataset.panelSheetState = "open";
    layer.hidden = false;
    layer.setAttribute("aria-hidden", "false");
    if (typeof document !== "undefined" && !scenePanelSheetReturnFocus) {
        scenePanelSheetReturnFocus = document.activeElement;
    }
    focusScenePanelLayerClose();
}

function closeScenePanelSheetLayer({ restoreFocus = true } = {}) {
    const layer = getScenePanelLayerElement();
    if (!layer || layer.dataset.panelSheet !== "true") {
        return;
    }
    layer.dataset.panelSheetState = "closed";
    layer.setAttribute("aria-hidden", "true");
    layer.hidden = true;
    if (restoreFocus && scenePanelSheetReturnFocus && typeof scenePanelSheetReturnFocus.focus === "function") {
        try {
            scenePanelSheetReturnFocus.focus({ preventScroll: true });
        } catch (err) {
            try {
                scenePanelSheetReturnFocus.focus();
            } catch (innerErr) {
            }
        }
    }
    scenePanelSheetReturnFocus = null;
}

function enterScenePanelSheetMode() {
    scenePanelSheetMode = true;
    const moved = moveScenePanelContentToSheet();
    const layer = getScenePanelLayerElement();
    if (moved && layer) {
        layer.dataset.panelSheet = "true";
        layer.dataset.panelSheetState = lastPanelEnabledState ? "open" : "closed";
        layer.hidden = !lastPanelEnabledState;
        layer.setAttribute("aria-hidden", lastPanelEnabledState ? "false" : "true");
    }
    updateScenePanelSummonTarget();
}

function exitScenePanelSheetMode() {
    scenePanelSheetMode = false;
    const content = getScenePanelContent?.();
    const { el } = resolveContainer(content);
    if (el) {
        restoreScenePanelContentHome(el);
    }
    const layer = getScenePanelLayerElement();
    if (layer) {
        delete layer.dataset.panelSheet;
        delete layer.dataset.panelSheetState;
        layer.setAttribute("aria-hidden", "true");
        layer.hidden = true;
    }
    scenePanelSheetReturnFocus = null;
    updateScenePanelSummonTarget();
}

function handleScenePanelViewportChange() {
    updateScenePanelViewportMode();
}

function setupScenePanelViewportQuery() {
    if (scenePanelViewportQuery || typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return;
    }
    scenePanelViewportQuery = window.matchMedia("(max-width: 900px)");
    if (scenePanelViewportQuery?.addEventListener) {
        scenePanelViewportQuery.addEventListener("change", handleScenePanelViewportChange, { passive: true });
    } else if (scenePanelViewportQuery?.addListener) {
        scenePanelViewportQuery.addListener(handleScenePanelViewportChange);
    }
}

function updateScenePanelViewportMode() {
    setupScenePanelViewportQuery();

    // Check if the panel is currently in a popup
    const container = getScenePanelContainer?.();
    const { el } = resolveContainer(container);
    const isPopup = el?.dataset?.csPopup === "true";

    // If in popup mode, force sheet mode off
    const shouldUseSheetMode = !isPopup && Boolean(scenePanelViewportQuery?.matches);

    if (shouldUseSheetMode === scenePanelSheetMode) {
        updateScenePanelSummonTarget();
        return shouldUseSheetMode;
    }
    if (shouldUseSheetMode) {
        enterScenePanelSheetMode();
    } else {
        closeScenePanelSheetLayer({ restoreFocus: false });
        exitScenePanelSheetMode();
    }
    applyPanelEnabledState(lastPanelEnabledState, { collapsed: lastPanelCollapsedState });
    return shouldUseSheetMode;
}

function restoreScenePanelSummonButton() {
    if (scenePanelSummonRestoring) {
        return;
    }
    scenePanelSummonRestoring = true;
    try {
        const button = ensureScenePanelSummonButton();
        if (!button) {
            return;
        }
        const parent = getScenePanelSummonParent();
        if (parent && (!button.parentElement || !button.parentElement.isConnected)) {
            parent.appendChild(button);
        }
        button.style.removeProperty("display");
        button.style.removeProperty("visibility");
        button.style.removeProperty("opacity");
        button.removeAttribute("hidden");
        button.removeAttribute("aria-hidden");
        if (!button.classList.contains("cs-scene-panel__summon")) {
            button.classList.add("cs-scene-panel__summon");
        }
        applyScenePanelSummonInlineStyles(button);
        updateScenePanelSummonVisibility(lastScenePanelSummonState.enabled, {
            collapsed: lastScenePanelSummonState.collapsed,
        });
    } finally {
        scenePanelSummonRestoring = false;
    }
}

function observeScenePanelSummonButton(button) {
    if (typeof MutationObserver === "undefined" || !button) {
        return;
    }
    if (!scenePanelSummonButtonObserver) {
        scenePanelSummonButtonObserver = new MutationObserver((mutations) => {
            if (scenePanelSummonRestoring) {
                return;
            }
            let requiresRestore = false;
            for (const mutation of mutations) {
                if (!mutation || mutation.type !== "attributes") {
                    continue;
                }
                const target = isHTMLElement(mutation.target) ? mutation.target : null;
                if (!target) {
                    continue;
                }
                if (mutation.attributeName === "hidden" && target.hidden) {
                    requiresRestore = true;
                    break;
                }
                if (mutation.attributeName === "aria-hidden") {
                    const ariaHidden = target.getAttribute("aria-hidden");
                    if (ariaHidden === "true") {
                        requiresRestore = true;
                        break;
                    }
                }
                if (mutation.attributeName === "style") {
                    const { display, visibility, opacity } = target.style;
                    if (
                        display === "none"
                        || visibility === "hidden"
                        || visibility === "collapse"
                        || opacity === "0"
                    ) {
                        requiresRestore = true;
                        break;
                    }
                }
                if (mutation.attributeName === "class" && !target.classList.contains("cs-scene-panel__summon")) {
                    requiresRestore = true;
                    break;
                }
            }
            if (requiresRestore) {
                restoreScenePanelSummonButton();
            }
        });
    }
    try {
        scenePanelSummonButtonObserver.disconnect();
    } catch (err) {
    }
    try {
        scenePanelSummonButtonObserver.observe(button, {
            attributes: true,
            attributeFilter: ["hidden", "aria-hidden", "style", "class"],
        });
    } catch (err) {
    }
}

function observeScenePanelSummonParent(button) {
    if (typeof MutationObserver === "undefined" || !button) {
        return;
    }
    const parent = isHTMLElement(button.parentNode) ? button.parentNode : getScenePanelSummonParent();
    if (!parent) {
        return;
    }
    if (!scenePanelSummonParentObserver) {
        scenePanelSummonParentObserver = new MutationObserver((mutations) => {
            if (scenePanelSummonRestoring) {
                return;
            }
            for (const mutation of mutations) {
                if (!mutation || mutation.type !== "childList") {
                    continue;
                }
                for (const removed of mutation.removedNodes) {
                    if (removed === scenePanelSummonButton) {
                        restoreScenePanelSummonButton();
                        return;
                    }
                }
            }
        });
    }
    if (scenePanelSummonParentObserverTarget && scenePanelSummonParentObserverTarget !== parent) {
        try {
            scenePanelSummonParentObserver.disconnect();
        } catch (err) {
        }
        scenePanelSummonParentObserverTarget = null;
    }
    if (scenePanelSummonParentObserverTarget === parent) {
        return;
    }
    try {
        scenePanelSummonParentObserver.observe(parent, { childList: true });
        scenePanelSummonParentObserverTarget = parent;
    } catch (err) {
    }
}

function startScenePanelSummonGuards(button) {
    if (!button) {
        return;
    }
    observeScenePanelSummonButton(button);
    observeScenePanelSummonParent(button);
}
let lastRosterRevision = null;
let lastActiveRevision = null;
let lastLogRevision = null;
let lastCoverageRevision = null;

function ensureScenePanelSummonButton() {
    if (typeof document === "undefined") {
        return null;
    }
    if (scenePanelSummonButton && scenePanelSummonButton.isConnected) {
        return scenePanelSummonButton;
    }
    const existing = document.getElementById("cs-scene-panel-summon");
    if (existing) {
        scenePanelSummonButton = existing;
        startScenePanelSummonGuards(scenePanelSummonButton);
        updateScenePanelSummonTarget();
        return scenePanelSummonButton;
    }
    const button = createElement("button", "cs-scene-panel__summon");
    if (!button) {
        return null;
    }
    button.id = "cs-scene-panel-summon";
    button.type = "button";
    button.setAttribute("data-scene-panel", "show-panel");
    button.setAttribute("aria-controls", "cs-scene-panel");
    button.setAttribute("aria-label", "Show scene panel");
    button.title = "Show scene panel";
    button.setAttribute("aria-pressed", "false");
    button.dataset.panelVisible = "false";
    button.dataset.panelCollapsed = "false";
    const icon = createElement("i", "fa-solid fa-masks-theater cs-scene-panel__summon-icon");
    if (icon) {
        icon.setAttribute("aria-hidden", "true");
        button.appendChild(icon);
    }
    const label = createElement("span", "cs-scene-panel__summon-label");
    if (label) {
        label.textContent = "Scene panel";
        button.appendChild(label);
    }
    button.hidden = true;
    button.setAttribute("aria-hidden", "true");
    const parent = getScenePanelSummonParent();
    if (parent) {
        parent.appendChild(button);
    }
    scenePanelSummonButton = button;
    startScenePanelSummonGuards(scenePanelSummonButton);
    updateScenePanelSummonTarget();
    return scenePanelSummonButton;
}

function updateScenePanelSummonVisibility(enabled, { collapsed = false } = {}) {
    lastScenePanelSummonState = {
        enabled: Boolean(enabled),
        collapsed: Boolean(collapsed),
    };
    updateScenePanelSummonTarget();
    const button = ensureScenePanelSummonButton();
    if (!button) {
        return;
    }
    if (!button.isConnected && typeof document !== "undefined" && document.body) {
        document.body.appendChild(button);
    }
    button.dataset.visible = "true";
    button.dataset.panelVisible = enabled ? "true" : "false";
    button.dataset.panelCollapsed = collapsed ? "true" : "false";
    button.hidden = false;
    button.removeAttribute("hidden");
    button.removeAttribute("aria-hidden");
    applyScenePanelSummonInlineStyles(button);
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
    button.setAttribute("aria-label", enabled ? "Hide scene panel" : "Show scene panel");
    button.title = enabled ? "Hide scene panel" : "Show scene panel";

    const icon = button.querySelector(".cs-scene-panel__summon-icon");
    if (icon) {
        icon.classList.remove("fa-eye", "fa-eye-slash", "fa-masks-theater");
        icon.classList.add(enabled ? "fa-eye-slash" : "fa-masks-theater");
    }

    const label = button.querySelector(".cs-scene-panel__summon-label");
    if (label) {
        label.textContent = enabled ? "Hide Scene Panel" : "Show Scene Panel";
    }

    if (!enabled) {
        try {
            button.focus({ preventScroll: true });
        } catch (err) {
            try {
                button.focus();
            } catch (innerErr) {
            }
        }
    }
}

function applyCollapsedState(collapsed) {
    const container = getScenePanelContainer?.();
    const toggle = getSceneCollapseToggle?.();
    if (container && typeof container.attr === "function") {
        container.attr("data-cs-collapsed", collapsed ? "true" : "false");
    } else if (container?.[0]) {
        container[0].setAttribute("data-cs-collapsed", collapsed ? "true" : "false");
    }
    if (toggle && typeof toggle.attr === "function") {
        toggle.attr("aria-expanded", collapsed ? "false" : "true");
        toggle.attr("title", collapsed ? "Expand scene roster" : "Collapse scene roster");
    } else if (toggle?.[0]) {
        toggle[0].setAttribute("aria-expanded", collapsed ? "false" : "true");
        toggle[0].setAttribute("title", collapsed ? "Expand scene roster" : "Collapse scene roster");
    }
}

function applyPanelEnabledState(enabled, { collapsed = false } = {}) {
    lastPanelEnabledState = Boolean(enabled);
    lastPanelCollapsedState = Boolean(collapsed);
    const container = getScenePanelContainer?.();
    const { $, el } = resolveContainer(container);
    const value = enabled ? "false" : "true";
    if ($ && typeof $.attr === "function") {
        $.attr("data-cs-disabled", value);
        $.attr("aria-disabled", enabled ? "false" : "true");
        $.attr("aria-hidden", enabled ? "false" : "true");
    } else if (el) {
        el.setAttribute("data-cs-disabled", value);
        el.setAttribute("aria-disabled", enabled ? "false" : "true");
        el.setAttribute("aria-hidden", enabled ? "false" : "true");
    }
    if (el) {
        if (enabled) {
            el.removeAttribute("hidden");
        } else {
            el.setAttribute("hidden", "");
        }
    }
    if (scenePanelSheetMode) {
        const layer = getScenePanelLayerElement();
        if (layer) {
            layer.dataset.panelSheet = "true";
            layer.dataset.panelSheetState = enabled ? "open" : "closed";
            layer.setAttribute("aria-hidden", enabled ? "false" : "true");
            if (enabled) {
                layer.removeAttribute("hidden");
            } else {
                layer.setAttribute("hidden", "");
            }
        }
        if (enabled) {
            openScenePanelSheetLayer();
        } else {
            closeScenePanelSheetLayer();
        }
    } else {
        closeScenePanelSheetLayer({ restoreFocus: false });
    }
    updateScenePanelSummonVisibility(enabled, { collapsed });
}

function applyAutoPinMode(active) {
    const container = getScenePanelContainer?.();
    const { $, el } = resolveContainer(container);
    const value = active ? "true" : "false";
    if ($ && typeof $.attr === "function") {
        $.attr("data-cs-auto-pin", value);
    } else if (el) {
        el.setAttribute("data-cs-auto-pin", value);
    }
}

function applySectionVisibility(target, visible) {
    const { $, el } = resolveContainer(target);
    const value = visible ? "false" : "true";
    if ($ && typeof $.attr === "function") {
        $.attr("data-scene-panel-hidden", value);
        $.attr("aria-hidden", visible ? "false" : "true");
    } else if (el) {
        el.setAttribute("data-scene-panel-hidden", value);
        el.setAttribute("aria-hidden", visible ? "false" : "true");
    }
}

function applySectionLayoutState(visibleCount) {
    const sectionsContainer = getSceneSectionsContainer?.();
    const { $, el } = resolveContainer(sectionsContainer);
    if (!$ && !el) {
        return;
    }

    const sanitizedVisible = Math.max(0, Number.isFinite(visibleCount) ? Math.floor(visibleCount) : 0);

    let totalSections = 0;
    let domVisibleCount = 0;

    if ($ && typeof $.find === "function") {
        const $sections = $.find(".cs-scene-panel__section");
        totalSections = $sections.length;
        if (typeof $sections.filter === "function") {
            domVisibleCount = $sections.filter(function filterVisibleSection() {
                if (!this || typeof this.getAttribute !== "function") {
                    return false;
                }
                return this.getAttribute("data-scene-panel-hidden") !== "true";
            }).length;
        } else {
            domVisibleCount = totalSections;
        }
    } else if (el && typeof el.querySelectorAll === "function") {
        const sections = Array.from(el.querySelectorAll(".cs-scene-panel__section"));
        totalSections = sections.length;
        domVisibleCount = sections.filter((section) => {
            if (!section || typeof section.getAttribute !== "function") {
                return false;
            }
            return section.getAttribute("data-scene-panel-hidden") !== "true";
        }).length;
    }

    const resolvedVisible = domVisibleCount > 0 ? domVisibleCount : sanitizedVisible;
    const expanded = resolvedVisible > 0
        && ((totalSections > 0 && resolvedVisible < totalSections) || sanitizedVisible > resolvedVisible);
    const roundedVisible = Math.max(0, Number.isFinite(resolvedVisible) ? Math.round(resolvedVisible) : 0);
    const safeVisible = expanded ? Math.max(1, roundedVisible) : roundedVisible;
    const visibleValue = String(safeVisible);
    const expandedValue = expanded ? "true" : "false";

    if ($ && typeof $.attr === "function") {
        $.attr("data-visible-sections", visibleValue);
        $.attr("data-sections-expanded", expandedValue);
        if (typeof $.css === "function") {
            $.css("--cs-scene-visible-section-count", visibleValue);
        }
    }

    if (el) {
        el.setAttribute("data-visible-sections", visibleValue);
        el.setAttribute("data-sections-expanded", expandedValue);
        if (el.style && typeof el.style.setProperty === "function") {
            el.style.setProperty("--cs-scene-visible-section-count", visibleValue);
        }
    }
}

function updateToolbarToggleState(buttonId, pressed, { pressedTitle, unpressedTitle } = {}) {
    if (typeof document === "undefined") {
        return;
    }
    const button = document.getElementById(buttonId);
    if (!button) {
        return;
    }
    if (button.classList && typeof button.classList.remove === "function") {
        button.classList.remove("cs-scene-panel__icon-button--disabled");
    }
    if (typeof button.removeAttribute === "function") {
        button.removeAttribute("hidden");
        button.removeAttribute("aria-hidden");
        button.removeAttribute("disabled");
        button.removeAttribute("tabindex");
    }
    if (button.style && typeof button.style.removeProperty === "function") {
        button.style.removeProperty("display");
    }
    if ("hidden" in button) {
        try {
            button.hidden = false;
        } catch (err) {
        }
    }
    button.setAttribute("aria-hidden", "false");
    button.setAttribute("aria-pressed", pressed ? "true" : "false");
    const title = pressed ? pressedTitle : unpressedTitle;
    if (title) {
        button.setAttribute("title", title);
    }
}

function updateStatusCopy(enabled) {
    const statusTarget = getSceneStatusText?.();
    const { $, el } = resolveContainer(statusTarget);
    const copy = enabled
        ? "Mirrors the live tester timeline while tracking actual chat results."
        : "Scene panel is hidden. Use the mask button to bring it back when you need it.";
    if ($ && typeof $.text === "function") {
        $.text(copy);
    } else if (el) {
        el.textContent = copy;
    }
}

export function renderScenePanel(panelState = {}, { source = "scene" } = {}) {
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
    const { el: containerElement } = resolveContainer(container);
    const isPopup = containerElement?.dataset?.csPopup === "true";

    const collapsed = Boolean(panelState.collapsed);
    const settings = panelState.settings || {};
    const enabled = isPopup ? true : settings.enabled !== false;

    lastPanelEnabledState = enabled;
    lastPanelCollapsedState = collapsed;
    updateScenePanelViewportMode();

    applyCollapsedState(collapsed);
    applyPanelEnabledState(enabled, { collapsed });
    applyAutoPinMode(settings.autoPinActive !== false);
    updateStatusCopy(enabled);

    const sections = settings.sections || {};
    const showRoster = enabled && sections.roster !== false;
    const showActive = enabled && sections.activeCharacters !== false;
    const showLog = enabled && sections.liveLog !== false;
    const showCoverage = enabled && sections.coverage !== false;

    applySectionVisibility(getSceneRosterSection?.(), showRoster);
    applySectionVisibility(getSceneActiveSection?.(), showActive);
    applySectionVisibility(getSceneLiveLogSection?.(), showLog);
    applySectionVisibility(getSceneCoverageSection?.(), showCoverage);
    const visibleSections = [showRoster, showActive, showLog, showCoverage].filter(Boolean).length;
    applySectionLayoutState(visibleSections);

    updateToolbarToggleState("cs-scene-panel-toggle", enabled, {
        pressedTitle: "Hide scene panel",
        unpressedTitle: "Show scene panel",
    });
    updateToolbarToggleState("cs-scene-section-toggle-roster", showRoster, {
        pressedTitle: "Hide roster section",
        unpressedTitle: "Show roster section",
    });
    updateToolbarToggleState("cs-scene-section-toggle-active", showActive, {
        pressedTitle: "Hide active characters section",
        unpressedTitle: "Show active characters section",
    });
    updateToolbarToggleState("cs-scene-section-toggle-log", showLog, {
        pressedTitle: "Hide live log section",
        unpressedTitle: "Show live log section",
    });
    updateToolbarToggleState("cs-scene-section-toggle-coverage", showCoverage, {
        pressedTitle: "Hide coverage suggestions section",
        unpressedTitle: "Show coverage suggestions section",
    });
    updateToolbarToggleState("cs-scene-panel-toggle-auto-open", settings.autoOpenOnResults !== false, {
        pressedTitle: "Disable auto-open on new results",
        unpressedTitle: "Enable auto-open on new results",
    });

    const rosterTarget = getSceneRosterList?.();
    const rosterRevision = showRoster
        ? [
            panelState.scene?.updatedAt ?? 0,
            panelState.membership?.updatedAt ?? 0,
            panelState.isStreaming ? 1 : 0,
            settings.showRosterAvatars !== false ? 1 : 0,
        ].join(":")
        : null;
    if (rosterTarget && showRoster) {
        if (lastRosterRevision !== rosterRevision) {
            renderSceneRoster(rosterTarget, panelState);
            lastRosterRevision = rosterRevision;
        }
    } else if (rosterTarget) {
        if (lastRosterRevision != null) {
            clearContainer(rosterTarget);
            lastRosterRevision = null;
        }
    }

    const activeTarget = getSceneActiveCards?.();
    const activeRevision = showActive
        ? [
            panelState.analytics?.updatedAt ?? 0,
            Array.isArray(panelState.ranking) ? panelState.ranking.length : 0,
            settings.autoPinActive !== false ? 1 : 0,
        ].join(":")
        : null;
    if (activeTarget && showActive) {
        if (lastActiveRevision !== activeRevision) {
            renderActiveCharacters(activeTarget, panelState);
            lastActiveRevision = activeRevision;
        }
    } else if (activeTarget) {
        if (lastActiveRevision != null) {
            clearContainer(activeTarget);
            lastActiveRevision = null;
        }
    }

    const liveLogTarget = getSceneLiveLog?.();
    const logRevision = showLog
        ? [
            panelState.analytics?.updatedAt ?? 0,
            Array.isArray(panelState.analytics?.events) ? panelState.analytics.events.length : 0,
            Array.isArray(panelState.analytics?.matches) ? panelState.analytics.matches.length : 0,
            panelState.analytics?.messageKey || "",
        ].join(":")
        : null;
    if (liveLogTarget && showLog) {
        if (lastLogRevision !== logRevision) {
            renderLiveLog(liveLogTarget, panelState);
            lastLogRevision = logRevision;
        }
    } else if (liveLogTarget) {
        if (lastLogRevision != null) {
            clearContainer(liveLogTarget);
            lastLogRevision = null;
        }
    }

    const coverageSection = getSceneCoverageSection?.();
    const coveragePronouns = getSceneCoveragePronouns?.();
    const coverageAttribution = getSceneCoverageAttribution?.();
    const coverageAction = getSceneCoverageAction?.();
    const hasCoverageBuffer = typeof panelState.analytics?.buffer === "string"
        ? panelState.analytics.buffer.trim().length > 0
        : false;
    const coverageRevision = showCoverage
        ? JSON.stringify({
            coverage: panelState.coverage || null,
            hasBuffer: hasCoverageBuffer,
        })
        : null;
    if (coverageSection && showCoverage) {
        if (lastCoverageRevision !== coverageRevision) {
            renderCoverageSection({
                section: coverageSection,
                pronouns: coveragePronouns,
                attribution: coverageAttribution,
                action: coverageAction,
            }, panelState.coverage || {}, { hasBuffer: hasCoverageBuffer });
            lastCoverageRevision = coverageRevision;
        }
    } else {
        if (lastCoverageRevision != null) {
            if (coveragePronouns) {
                clearContainer(coveragePronouns);
            }
            if (coverageAttribution) {
                clearContainer(coverageAttribution);
            }
            if (coverageAction) {
                clearContainer(coverageAction);
            }
            if (coverageSection) {
                const wrapper = resolveContainer(coverageSection);
                if (wrapper.el) {
                    wrapper.el.removeAttribute("data-state");
                    wrapper.el.setAttribute("data-has-content", "false");
                }
                if (wrapper.$ && typeof wrapper.$.attr === "function") {
                    wrapper.$.removeAttr?.("data-state");
                    wrapper.$.attr("data-has-content", "false");
                }
            }
            lastCoverageRevision = null;
        }
    }
}

export function createScenePanelRefreshHandler({
    restoreLatestSceneOutcome,
    requestScenePanelRender,
    rerenderScenePanelLayer,
    showStatus,
    getCurrentSceneSnapshot,
    getLatestStoredSceneTimestamp,
} = {}) {
    return function handleScenePanelRefresh(event) {
        event?.preventDefault?.();

        let currentTimestamp = null;
        if (typeof getCurrentSceneSnapshot === "function") {
            try {
                const scene = getCurrentSceneSnapshot();
                if (Number.isFinite(scene?.updatedAt) && scene.updatedAt > 0) {
                    currentTimestamp = scene.updatedAt;
                }
            } catch (err) {
            }
        }

        let storedTimestamp = null;
        if (typeof getLatestStoredSceneTimestamp === "function") {
            try {
                const value = getLatestStoredSceneTimestamp();
                if (Number.isFinite(value) && value > 0) {
                    storedTimestamp = value;
                }
            } catch (err) {
            }
        }

        let restored = false;
        if (currentTimestamp != null && storedTimestamp != null && currentTimestamp === storedTimestamp) {
            restored = true;
        } else if (typeof restoreLatestSceneOutcome === "function") {
            restored = restoreLatestSceneOutcome({
                immediateRender: true,
                preserveStateOnFailure: true,
            });
        }

        if (!restored && typeof requestScenePanelRender === "function") {
            requestScenePanelRender("manual-refresh", { immediate: true });
        }

        if (typeof showStatus === "function") {
            showStatus("Scene panel refreshed.", "info");
        }

        if (typeof rerenderScenePanelLayer === "function") {
            rerenderScenePanelLayer();
        }
    };
}
