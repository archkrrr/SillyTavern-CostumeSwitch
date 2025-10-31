import verbCatalog from "./verbCatalogData.js";

const CATEGORY_KEYS = new Set(["attribution", "action"]);
const EDITION_KEYS = new Set(["default", "extended"]);

export const VERB_CATALOG = verbCatalog;

function normalizeOptions(options = {}) {
    const category = options.category || "attribution";
    const edition = options.edition || "default";
    if (!CATEGORY_KEYS.has(category)) {
        throw new Error(`Unknown verb category: ${category}`);
    }
    if (!EDITION_KEYS.has(edition)) {
        throw new Error(`Unknown verb edition: ${edition}`);
    }
    return { category, edition };
}

function getEntries(options = {}) {
    const { category, edition } = normalizeOptions(options);
    return VERB_CATALOG
        .filter(entry => Boolean(entry?.categories?.[category]?.[edition]))
        .sort((a, b) => a.base.localeCompare(b.base));
}

function buildUniqueList(entries, selector) {
    const seen = new Set();
    const list = [];
    for (const entry of entries) {
        const value = selector(entry);
        if (!value || seen.has(value)) {
            continue;
        }
        seen.add(value);
        list.push(value);
    }
    return list;
}

export function buildVerbSlices(options = {}) {
    const entries = getEntries(options);
    return {
        base: buildUniqueList(entries, entry => entry.forms.base),
        thirdPerson: buildUniqueList(entries, entry => entry.forms.thirdPerson),
        past: buildUniqueList(entries, entry => entry.forms.past),
        pastParticiple: buildUniqueList(entries, entry => entry.forms.pastParticiple),
        presentParticiple: buildUniqueList(entries, entry => entry.forms.presentParticiple),
    };
}

export function buildLegacyVerbList(options = {}) {
    const { category, edition } = normalizeOptions(options);
    const entries = getEntries({ category, edition });

    if (category === "action") {
        if (edition === "default") {
            const legacy = [];
            for (const entry of entries) {
                const baseForm = entry.forms.base;
                const pastForm = entry.forms.past;
                if (baseForm) {
                    legacy.push(baseForm);
                }
                if (pastForm && pastForm !== baseForm) {
                    legacy.push(pastForm);
                }
            }
            return legacy;
        }
        return buildUniqueList(entries, entry => entry.forms.past);
    }

    return buildUniqueList(entries, entry => entry.forms.past);
}

export function getVerbEntries(options = {}) {
    return getEntries(options);
}
