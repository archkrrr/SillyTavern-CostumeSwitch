const avatarCache = new Map();

function isElement(value) {
    return typeof Element !== "undefined" && value instanceof Element;
}

function isJQueryLike(value) {
    return value && typeof value === "object" && typeof value.jquery === "string";
}

export function resolveContainer(target) {
    const result = { $: null, el: null };
    if (!target) {
        return result;
    }

    if (typeof target === "object" && target !== null) {
        const hasJQuery = Object.prototype.hasOwnProperty.call(target, "$") && target.$;
        const hasElement = Object.prototype.hasOwnProperty.call(target, "el") && target.el;

        if (hasJQuery || hasElement) {
            if (hasJQuery) {
                result.$ = target.$;
                if (!result.el && target.$ && typeof target.$.length === "number" && target.$.length > 0) {
                    result.el = target.$[0] || null;
                }
            }

            if (hasElement && !result.el) {
                result.el = target.el;
            }

            if (result.el && !result.$ && typeof window !== "undefined" && typeof window.jQuery === "function") {
                const $instance = window.jQuery(result.el);
                if ($instance && $instance.length) {
                    result.$ = $instance;
                }
            }

            return result;
        }
    }

    if (isJQueryLike(target)) {
        result.$ = target;
        result.el = target[0] || null;
        return result;
    }

    if (typeof window !== "undefined" && typeof window.jQuery === "function") {
        const $instance = window.jQuery(target);
        if ($instance && $instance.length) {
            result.$ = $instance;
            result.el = $instance[0] || null;
            return result;
        }
    }

    if (isElement(target)) {
        result.el = target;
        return result;
    }

    return result;
}

export function clearContainer(target) {
    const { $, el } = resolveContainer(target);
    if ($ && $.length) {
        $.empty();
        return;
    }
    if (el) {
        while (el.firstChild) {
            el.removeChild(el.firstChild);
        }
    }
}

export function appendContent(target, node) {
    if (!node) {
        return;
    }
    const { $, el } = resolveContainer(target);
    if ($ && $.length) {
        $.append(node);
        return;
    }
    if (el) {
        el.appendChild(node);
    }
}

export function createElement(tagName, className = null) {
    if (typeof document === "undefined" || typeof document.createElement !== "function") {
        return null;
    }
    const el = document.createElement(tagName);
    if (className) {
        el.className = className;
    }
    return el;
}

export function createTextElement(tagName, className, text) {
    const el = createElement(tagName, className);
    if (!el) {
        return null;
    }
    el.textContent = text;
    return el;
}

export function formatRelativeTime(timestamp, now = Date.now()) {
    if (!Number.isFinite(timestamp)) {
        return null;
    }
    const delta = Math.max(0, now - timestamp);
    const seconds = Math.round(delta / 1000);
    if (seconds <= 1) {
        return "just now";
    }
    if (seconds < 60) {
        return `${seconds}s ago`;
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return `${hours}h ago`;
    }
    const days = Math.round(hours / 24);
    if (days < 14) {
        return `${days}d ago`;
    }
    const weeks = Math.round(days / 7);
    if (weeks < 8) {
        return `${weeks}w ago`;
    }
    const months = Math.round(days / 30);
    if (months < 18) {
        return `${months}mo ago`;
    }
    const years = Math.round(days / 365);
    return `${years}y ago`;
}

function findAvatarInCollection(collection, normalizedName) {
    if (!collection) {
        return null;
    }
    if (collection instanceof Map) {
        const entry = collection.get(normalizedName);
        if (entry && typeof entry === "object") {
            return entry.avatar || entry.thumbnail || entry.img || entry.image || null;
        }
        return null;
    }
    if (!Array.isArray(collection)) {
        return null;
    }
    for (const entry of collection) {
        if (!entry || typeof entry !== "object") {
            continue;
        }
        const name = String(entry.name || entry.display_name || entry.nickname || "").toLowerCase();
        if (name && name === normalizedName) {
            return entry.avatar || entry.thumbnail || entry.img || entry.image || entry.portrait || null;
        }
    }
    return null;
}

export function resolveAvatarUrl(name) {
    if (typeof name !== "string" || !name.trim()) {
        return null;
    }
    const normalized = name.trim().toLowerCase();
    if (avatarCache.has(normalized)) {
        return avatarCache.get(normalized);
    }
    let resolved = null;
    if (typeof window !== "undefined") {
        try {
            if (typeof window.getThumbnail === "function") {
                resolved = window.getThumbnail(name) || null;
            }
        } catch (err) {
        }
        if (!resolved) {
            const candidates = [
                window.characters,
                window.SillyTavern?.characters,
                window.SillyTavern?.characterCache,
                window.SillyTavern?.characterController?.characters,
            ];
            for (const candidate of candidates) {
                resolved = findAvatarInCollection(candidate, normalized);
                if (resolved) {
                    break;
                }
            }
        }
    }
    avatarCache.set(normalized, resolved);
    return resolved;
}

export function createPlaceholder(message, { tone = "neutral" } = {}) {
    const el = createElement("div", "cs-scene-panel__placeholder");
    if (!el) {
        return null;
    }
    el.dataset.tone = tone;
    el.textContent = message;
    return el;
}

export function capitalizeName(name) {
    if (typeof name !== "string") {
        return "";
    }
    if (!name.length) {
        return "";
    }
    return name.charAt(0).toUpperCase() + name.slice(1);
}
