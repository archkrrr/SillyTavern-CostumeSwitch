const SAMPLE_THRESHOLD = 500;
const HALF_THRESHOLD = Math.floor(SAMPLE_THRESHOLD / 2);

function stripMarkup(text) {
    if (!text) {
        return "";
    }
    const input = String(text);
    return input.replace(/[\*\"]+/g, "");
}

function trimToSentenceStart(text) {
    if (!text) {
        return "";
    }
    const trimmed = String(text).trim();
    const boundary = trimmed.search(/[.!?]\s+[A-Z]/);
    if (boundary === -1) {
        return trimmed;
    }
    return trimmed.slice(boundary + 1).trimStart();
}

function trimToSentenceEnd(text) {
    if (!text) {
        return "";
    }
    const trimmed = String(text).trim();
    const boundary = trimmed.lastIndexOf(".");
    if (boundary === -1) {
        return trimmed;
    }
    return trimmed.slice(0, boundary + 1).trim();
}

export function sampleClassifyText(text) {
    if (!text) {
        return "";
    }
    const stripped = stripMarkup(text);
    if (stripped.length <= SAMPLE_THRESHOLD) {
        return trimToSentenceEnd(stripped);
    }
    const start = trimToSentenceEnd(stripped.slice(0, HALF_THRESHOLD));
    const end = trimToSentenceStart(stripped.slice(-HALF_THRESHOLD));
    return `${start} ${end}`.trim();
}

export default sampleClassifyText;
