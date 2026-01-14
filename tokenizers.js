const tokenizers = {
    DEFAULT: "basic-whitespace",
};

const registry = new Map();

function normalizeTokenizerId(value) {
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) {
            return trimmed;
        }
    }
    return tokenizers.DEFAULT;
}

function ensureTokenizer(id) {
    const normalized = normalizeTokenizerId(id);
    if (registry.has(normalized)) {
        return registry.get(normalized);
    }
    return registry.get(tokenizers.DEFAULT);
}

function defineHiddenProperty(target, key, value) {
    try {
        Object.defineProperty(target, key, {
            value,
            enumerable: false,
            configurable: true,
            writable: true,
        });
    } catch (err) {
        target[key] = value;
    }
}

function tokenizeWhitespace(text) {
    const input = typeof text === "string" ? text : String(text ?? "");
    if (!input) {
        return { ids: [], offsets: [], chunks: [] };
    }
    const ids = [];
    const offsets = [];
    const chunks = [];
    const pattern = /\S+/g;
    let match;
    while ((match = pattern.exec(input)) !== null) {
        const token = match[0];
        const start = match.index;
        const end = start + token.length;
        ids.push(ids.length + 1);
        offsets.push({ start, end });
        chunks.push(token);
    }
    return { ids, offsets, chunks };
}

export function registerTokenizer(id, implementation) {
    const normalized = normalizeTokenizerId(id);
    if (!implementation || typeof implementation.tokenize !== "function") {
        throw new TypeError("Tokenizer implementation must expose a tokenize(text) function");
    }
    registry.set(normalized, implementation);
}

function bootstrapDefaults() {
    if (registry.has(tokenizers.DEFAULT)) {
        return;
    }
    registerTokenizer(tokenizers.DEFAULT, {
        name: "Whitespace",
        tokenize: tokenizeWhitespace,
    });
}

bootstrapDefaults();

export function getTextTokens(tokenizerId, text) {
    bootstrapDefaults();
    const tokenizer = ensureTokenizer(tokenizerId);
    if (!tokenizer || typeof tokenizer.tokenize !== "function") {
        return [];
    }
    const result = tokenizer.tokenize(text);
    if (!result || !Array.isArray(result.ids)) {
        return [];
    }
    const ids = result.ids.slice();
    if (Array.isArray(result.chunks)) {
        defineHiddenProperty(ids, "chunks", result.chunks.slice());
    }
    if (Array.isArray(result.offsets)) {
        defineHiddenProperty(ids, "offsets", result.offsets.map(({ start, end }) => ({
            start: Number.isFinite(start) ? start : 0,
            end: Number.isFinite(end) ? end : 0,
        })));
    }
    return ids;
}

// FIX #9: Import global tokenizer for accuracy
import { getTokenCountAsync as globalGetTokenCountAsync, getTokenCount as globalGetTokenCount } from "../../../tokenizers.js";

export async function getTokenCountAsync(text, tokenizerId = null) {
    if (typeof globalGetTokenCountAsync === "function") {
        return globalGetTokenCountAsync(text);
    }

    const tokens = getTextTokens(tokenizerId, text);
    if (Array.isArray(tokens) && tokens.length > 0) {
        return tokens.length;
    }
    const input = typeof text === "string" ? text : String(text ?? "");
    if (!input) {
        return 0;
    }
    return tokenizeWhitespace(input).ids.length;
}

export function getFriendlyTokenizerName(mainApi = "") {
    bootstrapDefaults();
    const tokenizer = ensureTokenizer(mainApi);
    const label = typeof tokenizer?.name === "string" && tokenizer.name
        ? tokenizer.name
        : "Whitespace";
    return {
        tokenizerName: label,
        tokenizerId: normalizeTokenizerId(mainApi),
    };
}

export { tokenizers };
