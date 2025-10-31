import baseCatalog from "./verbCatalogBase.js";
import { createConjugatedEntry } from "./verbEntryHelpers.js";

// NOTE: verbCatalogBase.js is generated from verbCatalog.json to keep the
// runtime bundle compatible with browser environments that cannot access Node
// built-ins like `module`.

const ACTION_EXTENDED_ONLY = {
    attribution: {
        default: false,
        extended: false,
    },
    action: {
        default: false,
        extended: true,
    },
};

const ACTION_DEFAULT_AND_EXTENDED = {
    attribution: {
        default: false,
        extended: false,
    },
    action: {
        default: true,
        extended: true,
    },
};

const ATTRIBUTION_EXTENDED_ONLY = {
    attribution: {
        default: false,
        extended: true,
    },
    action: {
        default: false,
        extended: false,
    },
};

const curatedPhrasalVerbs = [
    createConjugatedEntry({
        lemma: "perk",
        particle: "up",
        categories: ACTION_DEFAULT_AND_EXTENDED,
    }),
    createConjugatedEntry({
        lemma: "lash",
        particle: "out",
        categories: ACTION_EXTENDED_ONLY,
    }),
    createConjugatedEntry({
        lemma: "drift",
        particle: "off",
        categories: ACTION_EXTENDED_ONLY,
    }),
    createConjugatedEntry({
        lemma: "double",
        particle: "down",
        categories: ACTION_EXTENDED_ONLY,
    }),
    createConjugatedEntry({
        lemma: "trail",
        particle: "off",
        categories: ATTRIBUTION_EXTENDED_ONLY,
    }),
    createConjugatedEntry({
        lemma: "point",
        particle: "out",
        categories: ATTRIBUTION_EXTENDED_ONLY,
    }),
    createConjugatedEntry({
        lemma: "fall",
        particle: "apart",
        categories: ACTION_EXTENDED_ONLY,
        overrides: {
            past: "fell",
            pastParticiple: "fallen",
        },
    }),
    createConjugatedEntry({
        lemma: "lie",
        particle: "down",
        categories: ACTION_EXTENDED_ONLY,
        overrides: {
            past: "lay",
            pastParticiple: "lain",
        },
    }),
];

const curatedIrregularVerbs = [
    createConjugatedEntry({
        lemma: "arise",
        categories: ACTION_EXTENDED_ONLY,
        overrides: {
            past: "arose",
            pastParticiple: "arisen",
        },
    }),
    createConjugatedEntry({
        lemma: "befall",
        categories: ACTION_EXTENDED_ONLY,
        overrides: {
            past: "befell",
            pastParticiple: "befallen",
        },
    }),
    createConjugatedEntry({
        lemma: "overcome",
        categories: ACTION_EXTENDED_ONLY,
        overrides: {
            past: "overcame",
            pastParticiple: "overcome",
        },
    }),
    createConjugatedEntry({
        lemma: "withstand",
        categories: ACTION_EXTENDED_ONLY,
        overrides: {
            past: "withstood",
            pastParticiple: "withstood",
        },
    }),
];

export default [
    ...baseCatalog,
    ...curatedPhrasalVerbs,
    ...curatedIrregularVerbs,
];
