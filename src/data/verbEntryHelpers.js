const FORM_KEYS = [
    "base",
    "thirdPerson",
    "past",
    "pastParticiple",
    "presentParticiple",
];

function isConsonant(letter) {
    return /[bcdfghjklmnpqrstvwxyz]/i.test(letter);
}

function isVowel(letter) {
    return /[aeiou]/i.test(letter);
}

function toThirdPerson(lemma) {
    if (lemma.endsWith("ie")) {
        return `${lemma.slice(0, -2)}ies`;
    }

    if (/[^aeiou]y$/i.test(lemma)) {
        return `${lemma.slice(0, -1)}ies`;
    }

    if (/(?:s|sh|ch|x|z|o)$/i.test(lemma)) {
        return `${lemma}es`;
    }

    return `${lemma}s`;
}

function shouldDoubleFinalConsonant(lemma) {
    if (lemma.length < 3) {
        return false;
    }

    const last = lemma.slice(-1);
    const secondLast = lemma.slice(-2, -1);
    const thirdLast = lemma.slice(-3, -2);
    return (
        isConsonant(last)
        && !/[wxy]/i.test(last)
        && isVowel(secondLast)
        && isConsonant(thirdLast)
    );
}

function toPastTense(lemma) {
    if (lemma.endsWith("e")) {
        return `${lemma}d`;
    }

    if (/[^aeiou]y$/i.test(lemma)) {
        return `${lemma.slice(0, -1)}ied`;
    }

    if (shouldDoubleFinalConsonant(lemma)) {
        return `${lemma}${lemma.slice(-1)}ed`;
    }

    return `${lemma}ed`;
}

function toPresentParticiple(lemma) {
    if (lemma.endsWith("ie")) {
        return `${lemma.slice(0, -2)}ying`;
    }

    if (lemma.endsWith("ee") || lemma.endsWith("oe") || lemma.endsWith("ye")) {
        return `${lemma}ing`;
    }

    if (lemma.endsWith("e")) {
        return `${lemma.slice(0, -1)}ing`;
    }

    if (shouldDoubleFinalConsonant(lemma)) {
        return `${lemma}${lemma.slice(-1)}ing`;
    }

    return `${lemma}ing`;
}

function buildInflections(lemma) {
    return {
        base: lemma,
        thirdPerson: toThirdPerson(lemma),
        past: toPastTense(lemma),
        pastParticiple: toPastTense(lemma),
        presentParticiple: toPresentParticiple(lemma),
    };
}

function applyParticle(forms, particle, lemma) {
    const baseForm = particle ? `${lemma} ${particle}` : lemma;
    const inflected = {};
    for (const key of FORM_KEYS) {
        const value = key === "base" ? baseForm : forms[key];
        if (!value) {
            inflected[key] = value;
            continue;
        }
        if (key === "base" || !particle) {
            inflected[key] = value;
            continue;
        }
        inflected[key] = `${value} ${particle}`;
    }
    return inflected;
}

export function createConjugatedEntry({ lemma, categories, particle = "", overrides = {} }) {
    if (!lemma || typeof lemma !== "string") {
        throw new Error("lemma must be a non-empty string");
    }
    const forms = { ...buildInflections(lemma), ...overrides };
    const inflectedForms = applyParticle(forms, particle.trim(), lemma);
    return {
        base: inflectedForms.base,
        categories,
        forms: inflectedForms,
    };
}

export function createManualEntry({ lemma, categories, particle = "", forms }) {
    if (!forms) {
        throw new Error("forms must be provided for manual entries");
    }
    const normalizedForms = { ...forms };
    for (const key of FORM_KEYS) {
        if (!normalizedForms[key]) {
            throw new Error(`forms.${key} is required for manual entries`);
        }
    }
    const inflectedForms = applyParticle(normalizedForms, particle.trim(), lemma);
    return {
        base: inflectedForms.base,
        categories,
        forms: inflectedForms,
    };
}

export { FORM_KEYS };
