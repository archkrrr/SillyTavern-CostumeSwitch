import { collectProfilePreprocessorScripts, applyPreprocessorScripts } from "./core/script-preprocessor.js";
import { createNamePreprocessor, stripDiacritics } from "./core/name-preprocessor.js";
import { getTextTokens, getTokenCountAsync } from "../tokenizers.js";

const DEFAULT_UNICODE_WORD_PATTERN = "[\\p{L}\\p{M}\\p{N}_]";
const WORD_CHAR_REGEX = /[\p{L}\p{M}\p{N}]/u;
const DEFAULT_BOUNDARY_LOOKBEHIND = "(?<![A-Za-z0-9_'’])";
const PROPER_NOUN_CHAR_REGEX = /\p{Lu}/u;

const PROFILE_TOKENIZER_CACHE = new WeakMap();
function normalizeTokenizerPreference(value) {
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) {
            return trimmed;
        }
    }
    return null;
}

function resolveProfileTokenizer(profile) {
    if (!profile || typeof profile !== "object") {
        return null;
    }
    const candidates = [
        profile.tokenizerId,
        profile.tokenizer,
        profile.tokenizerPreference,
        profile.tokenPreference,
        profile.tokenizerName,
    ];
    const signature = candidates.map((candidate) => (candidate == null ? "" : String(candidate))).join("|");
    const cached = PROFILE_TOKENIZER_CACHE.get(profile);
    if (cached && cached.signature === signature) {
        return cached.id;
    }
    let resolved = null;
    for (const candidate of candidates) {
        const normalized = normalizeTokenizerPreference(candidate);
        if (normalized) {
            resolved = normalized;
            break;
        }
    }
    PROFILE_TOKENIZER_CACHE.set(profile, { id: resolved, signature });
    return resolved;
}

function cloneTokenOffsets(offsets) {
    if (!Array.isArray(offsets) || offsets.length === 0) {
        return [];
    }
    return offsets.map((entry) => {
        if (!entry || typeof entry !== "object") {
            return { start: 0, end: 0 };
        }
        const start = Number.isFinite(entry.start) ? Math.max(0, Math.floor(entry.start)) : 0;
        const end = Number.isFinite(entry.end) ? Math.max(start, Math.floor(entry.end)) : start;
        return { start, end };
    });
}

function deriveTokenOffsets(tokens, text) {
    if (Array.isArray(tokens) && tokens.length > 0) {
        const descriptor = Object.getOwnPropertyDescriptor(tokens, "offsets");
        if (descriptor && Array.isArray(descriptor.value)) {
            return cloneTokenOffsets(descriptor.value);
        }
    }
    const input = typeof text === "string" ? text : String(text ?? "");
    if (!input) {
        return [];
    }
    const fallbackOffsets = [];
    const pattern = /\S+/g;
    let match;
    while ((match = pattern.exec(input)) !== null) {
        const token = match[0];
        const start = match.index;
        const end = start + token.length;
        fallbackOffsets.push({ start, end });
    }
    return fallbackOffsets;
}

function findTokenIndexCeil(offsets, charIndex) {
    if (!Array.isArray(offsets) || offsets.length === 0) {
        return null;
    }
    if (!Number.isFinite(charIndex)) {
        return null;
    }
    const target = Math.max(0, Math.floor(charIndex));
    for (let i = 0; i < offsets.length; i += 1) {
        const { start, end } = offsets[i];
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
            continue;
        }
        if (target <= start) {
            return i;
        }
        if (target >= start && target < end) {
            return i;
        }
    }
    return offsets.length;
}

function findTokenIndexFloor(offsets, charIndex) {
    if (!Array.isArray(offsets) || offsets.length === 0) {
        return null;
    }
    if (!Number.isFinite(charIndex)) {
        return null;
    }
    const target = Math.max(0, Math.floor(charIndex));
    let candidate = -1;
    for (let i = 0; i < offsets.length; i += 1) {
        const { start, end } = offsets[i];
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
            continue;
        }
        if (target >= start) {
            candidate = i;
        }
        if (target < end) {
            break;
        }
    }
    return candidate;
}

function tokenIndexToCharStart(offsets, tokenIndex, textLength = 0) {
    if (!Array.isArray(offsets) || offsets.length === 0) {
        return null;
    }
    if (!Number.isFinite(tokenIndex)) {
        return null;
    }
    const index = Math.max(0, Math.floor(tokenIndex));
    if (index <= 0) {
        const start = offsets[0]?.start;
        return Number.isFinite(start) ? start : 0;
    }
    if (index >= offsets.length) {
        const last = offsets[offsets.length - 1];
        const end = Number.isFinite(last?.end) ? last.end : textLength;
        return Number.isFinite(end) ? end : textLength;
    }
    const start = offsets[index]?.start;
    return Number.isFinite(start) ? start : 0;
}

function computeMatchTokenSpan(offsets, startChar, matchLength) {
    if (!Array.isArray(offsets) || offsets.length === 0) {
        return { start: null, length: null };
    }
    if (!Number.isFinite(startChar)) {
        return { start: null, length: null };
    }
    const safeStart = Math.max(0, Math.floor(startChar));
    const safeLength = Number.isFinite(matchLength) && matchLength > 0
        ? Math.max(0, Math.floor(matchLength))
        : 0;
    const inclusiveEnd = safeLength > 0 ? safeStart + safeLength - 1 : safeStart;
    const tokenStart = findTokenIndexCeil(offsets, safeStart);
    if (tokenStart == null || tokenStart >= offsets.length) {
        return { start: null, length: null };
    }
    let tokenEnd = findTokenIndexFloor(offsets, inclusiveEnd);
    if (tokenEnd == null || tokenEnd < tokenStart) {
        tokenEnd = tokenStart;
    }
    return {
        start: tokenStart,
        length: Math.max(1, tokenEnd - tokenStart + 1),
    };
}

function sliceTextRange(text, start, end) {
    if (typeof text !== "string") {
        return "";
    }
    const safeStart = Number.isFinite(start) ? Math.max(0, Math.min(text.length, Math.floor(start))) : 0;
    const safeEnd = Number.isFinite(end) ? Math.max(safeStart, Math.min(text.length, Math.floor(end))) : safeStart;
    return text.slice(safeStart, safeEnd);
}

function readTokenText(text, offsets, index) {
    if (!Array.isArray(offsets) || !offsets.length) {
        return "";
    }
    if (!Number.isFinite(index) || index < 0 || index >= offsets.length) {
        return "";
    }
    const entry = offsets[index];
    if (!entry || !Number.isFinite(entry.start) || !Number.isFinite(entry.end)) {
        return "";
    }
    return sliceTextRange(text, entry.start, entry.end);
}

function hasSpeakerCueContext(text, tokenOffsets, matchStart, matchLength, cachedSpan = null) {
    if (typeof text !== "string" || !text) {
        return false;
    }
    const safeStart = Number.isFinite(matchStart) ? Math.max(0, Math.floor(matchStart)) : 0;
    const safeLength = Number.isFinite(matchLength) && matchLength > 0 ? Math.max(0, Math.floor(matchLength)) : 0;
    const safeEnd = Math.min(text.length, safeStart + safeLength);
    const trailingSlice = sliceTextRange(text, safeEnd, safeEnd + 2);
    if (/^\s*[:：]/.test(trailingSlice)) {
        return true;
    }
    let span = null;
    if (Array.isArray(tokenOffsets) && tokenOffsets.length) {
        span = cachedSpan || computeMatchTokenSpan(tokenOffsets, safeStart, safeLength || 1);
        if (span && Number.isFinite(span.start) && span.start >= 0 && span.start < tokenOffsets.length) {
            const tokenText = readTokenText(text, tokenOffsets, span.start);
            if (tokenText && /[：:]\s*$/.test(tokenText)) {
                return true;
            }
            const prevTokenIndex = span.start - 1;
            if (prevTokenIndex >= 0) {
                const prevText = readTokenText(text, tokenOffsets, prevTokenIndex).trim();
                if (prevText && /^(?:>{1,3}|[>\]\[])\s*$/u.test(prevText)) {
                    return true;
                }
            }
        }
    }
    let cursor = safeStart - 1;
    while (cursor >= 0) {
        const char = text[cursor];
        if (char === "\n" || char === "\r") {
            break;
        }
        if (!char || !/\s/.test(char)) {
            if (char && /[>\]\[(){}]/.test(char)) {
                return true;
            }
            break;
        }
        cursor -= 1;
    }
    return false;
}

function buildTokenProjection(profile, text) {
    if (!text) {
        return null;
    }
    const tokenizerId = resolveProfileTokenizer(profile);
    let tokens = null;
    try {
        tokens = getTextTokens(tokenizerId, text);
    } catch (error) {
        tokens = null;
    }
    if (!Array.isArray(tokens)) {
        return null;
    }
    const offsets = deriveTokenOffsets(tokens, text);
    let countPromise = null;
    if (!offsets.length) {
        try {
            countPromise = getTokenCountAsync(text, tokenizerId);
        } catch (error) {
            countPromise = null;
        }
    }
    return {
        tokenizerId: tokenizerId || null,
        tokens,
        offsets,
        count: offsets.length,
        countPromise,
    };
}

export function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}

export function parsePatternEntry(raw) {
    const text = String(raw ?? "").trim();
    if (!text) {
        return null;
    }
    const regexMatch = text.match(/^\/((?:\\.|[^\/])+)\/([gimsuy]*)$/);
    if (regexMatch) {
        return { body: regexMatch[1], flags: regexMatch[2] || "", raw: text };
    }
    return { body: escapeRegex(text), flags: "", raw: text };
}

export function computeFlags(entries, requireI = true) {
    const flags = new Set(requireI ? ["i"] : []);
    for (const entry of entries || []) {
        if (!entry) {
            continue;
        }
        for (const flag of entry.flags || "") {
            if ("gimsuy".includes(flag)) {
                flags.add(flag);
            }
        }
    }
    return Array.from(flags).join("");
}

export function buildRegex(patternList, template, options = {}) {
    const entries = (patternList || []).map(parsePatternEntry).filter(Boolean);
    if (!entries.length) {
        return null;
    }
    const patternBody = entries.map(entry => `(?:${entry.body})`).join("|");
    const finalBody = template.replace("{{PATTERNS}}", patternBody);
    let finalFlags = computeFlags(entries, options.requireI !== false);
    if (options.extraFlags) {
        for (const flag of options.extraFlags) {
            if (flag && !finalFlags.includes(flag)) {
                finalFlags += flag;
            }
        }
    }
    return new RegExp(finalBody, finalFlags);
}

export function buildGenericRegex(patternList) {
    if (!patternList || !patternList.length) {
        return null;
    }
    const entries = patternList.map(parsePatternEntry).filter(Boolean);
    if (!entries.length) {
        return null;
    }
    const body = entries.map(entry => entry.body).join("|");
    return new RegExp(`(?:${body})`, computeFlags(entries));
}

function buildAlternation(list) {
    const seen = new Set();
    return (list || [])
        .map(parsePatternEntry)
        .filter(Boolean)
        .map(entry => entry.body)
        .filter(body => {
            if (!body || seen.has(body)) {
                return false;
            }
            seen.add(body);
            return true;
        })
        .join("|");
}

function buildFallbackTokenPattern(unicodeWordPattern = DEFAULT_UNICODE_WORD_PATTERN) {
    const pattern = typeof unicodeWordPattern === "string" && unicodeWordPattern.trim()
        ? unicodeWordPattern.trim()
        : DEFAULT_UNICODE_WORD_PATTERN;
    return `${pattern}+?(?:['’\-]${pattern}+?)*`;
}

function buildFallbackRegexFromTemplate(template, unicodeWordPattern = DEFAULT_UNICODE_WORD_PATTERN, options = {}) {
    if (typeof template !== "string" || !template.includes("{{PATTERNS}}")) {
        return null;
    }
    const captureBase = buildFallbackTokenPattern(unicodeWordPattern);
    const captureGroup = `(${captureBase})`;
    const wrappedPlaceholder = "({{PATTERNS}})";
    const body = template.includes(wrappedPlaceholder)
        ? template.replace(wrappedPlaceholder, captureGroup)
        : template.replace("{{PATTERNS}}", captureGroup);
    const flagSet = new Set(options.requireI === false ? [] : ["i"]);
    const extraFlags = typeof options.extraFlags === "string" ? options.extraFlags : "";
    for (const flag of extraFlags) {
        if (flag && !flagSet.has(flag) && "gimsuyd".includes(flag)) {
            flagSet.add(flag);
        }
    }
    return new RegExp(body, Array.from(flagSet).join(""));
}

function tokenLooksLikeProperNoun(value, { allowLowercaseTokens = false } = {}) {
    if (!value || typeof value !== "string") {
        return false;
    }
    if (allowLowercaseTokens) {
        return true;
    }
    return PROPER_NOUN_CHAR_REGEX.test(value);
}

function scanNameLikeTokens(text, unicodeWordPattern = DEFAULT_UNICODE_WORD_PATTERN, options = {}) {
    if (!text) {
        return [];
    }
    const pattern = new RegExp(`\\b(${unicodeWordPattern}+?(?:['’\-]${unicodeWordPattern}+?)*)\\b`, "gu");
    const matches = [];
    const allowLowercaseTokens = Boolean(options?.allowLowercaseTokens);
    let match;
    while ((match = pattern.exec(text)) !== null) {
        const value = match[1] ?? match[0];
        if (!value || value.length < 3) {
            continue;
        }
        if (!tokenLooksLikeProperNoun(value, { allowLowercaseTokens })) {
            continue;
        }
        matches.push({ value, index: match.index, length: value.length });
    }
    return matches;
}

function rangesOverlap(existingRanges, start, end) {
    if (!existingRanges || !existingRanges.length) {
        return false;
    }
    const safeStart = Math.max(0, start);
    const safeEnd = Math.max(safeStart, end);
    return existingRanges.some((range) => {
        if (!range) {
            return false;
        }
        const rangeStart = Number.isFinite(range.start) ? range.start : null;
        const rangeEnd = Number.isFinite(range.end) ? range.end : null;
        if (rangeStart == null || rangeEnd == null) {
            return false;
        }
        return safeStart < rangeEnd && safeEnd > rangeStart;
    });
}

function gatherProfilePatterns(profile) {
    const result = [];
    const seen = new Set();

    const add = (value) => {
        const trimmed = String(value ?? "").trim();
        if (!trimmed || seen.has(trimmed)) {
            return;
        }
        seen.add(trimmed);
        result.push(trimmed);
    };

    if (profile && Array.isArray(profile.patternSlots)) {
        profile.patternSlots.forEach((slot) => {
            if (!slot) {
                return;
            }
            if (typeof slot === "string") {
                add(slot);
                return;
            }
            if (Array.isArray(slot)) {
                slot.forEach(add);
                return;
            }
            const name = typeof slot.name === "string" ? slot.name : null;
            if (name) {
                add(name);
            }
            const aliasSources = [
                slot.aliases,
                slot.patterns,
                slot.alternateNames,
                slot.names,
                slot.variants,
            ];
            aliasSources.forEach((source) => {
                if (!source) {
                    return;
                }
                if (Array.isArray(source)) {
                    source.forEach(add);
                } else {
                    add(source);
                }
            });
        });
    }

    if (profile && Array.isArray(profile.patterns)) {
        profile.patterns.forEach(add);
    }

    return result;
}

function buildAliasCanonicalMap(profile) {
    const map = new Map();
    if (!profile || !Array.isArray(profile.patternSlots)) {
        return map;
    }

    profile.patternSlots.forEach((slot) => {
        if (!slot) {
            return;
        }
        const canonical = typeof slot.name === "string" ? slot.name.trim() : "";
        if (!canonical) {
            return;
        }
        const aliasSources = [
            slot.aliases,
            slot.patterns,
            slot.alternateNames,
            slot.names,
            slot.variants,
        ];
        aliasSources.forEach((source) => {
            if (!source) {
                return;
            }
            const values = Array.isArray(source) ? source : [source];
            values.forEach((value) => {
                const alias = typeof value === "string" ? value.trim() : "";
                if (!alias) {
                    return;
                }
                const lowered = alias.toLowerCase();
                if (!map.has(lowered)) {
                    map.set(lowered, canonical);
                }
                const accentKey = stripDiacritics(alias).toLowerCase();
                if (accentKey && !map.has(accentKey)) {
                    map.set(accentKey, canonical);
                }
            });
        });
    });

    return map;
}

const QUOTE_PAIRS = [
    { open: "\"", close: "\"", symmetric: true },
    { open: "＂", close: "＂", symmetric: true },
    { open: "“", close: "”" },
    { open: "„", close: "”" },
    { open: "‟", close: "”" },
    { open: "«", close: "»" },
    { open: "‹", close: "›" },
    { open: "「", close: "」" },
    { open: "『", close: "』" },
    { open: "｢", close: "｣" },
    { open: "《", close: "》" },
    { open: "〈", close: "〉" },
    { open: "﹁", close: "﹂" },
    { open: "﹃", close: "﹄" },
    { open: "〝", close: "〞" },
    { open: "‘", close: "’" },
    { open: "‚", close: "’" },
    { open: "‛", close: "’" },
    { open: "'", close: "'", symmetric: true, apostropheSensitive: true },
];

const QUOTE_OPENERS = new Map();
const QUOTE_CLOSERS = new Map();

QUOTE_PAIRS.forEach((pair) => {
    const info = {
        close: pair.close,
        symmetric: Boolean(pair.symmetric),
        apostropheSensitive: Boolean(pair.apostropheSensitive),
    };
    QUOTE_OPENERS.set(pair.open, info);
    if (info.symmetric) {
        return;
    }
    if (!QUOTE_CLOSERS.has(pair.close)) {
        QUOTE_CLOSERS.set(pair.close, []);
    }
    QUOTE_CLOSERS.get(pair.close).push(pair.open);
});

function createQuoteState(bufferOffset = 0) {
    const offset = Number.isFinite(bufferOffset) ? Math.max(0, Math.floor(bufferOffset)) : 0;
    return {
        ranges: [],
        stack: [],
        windowOffset: offset,
        lastIndex: offset - 1,
    };
}

function projectQuoteRanges(state, bufferOffset, textLength) {
    if (!state || !Array.isArray(state.ranges)) {
        return [];
    }
    const offset = Number.isFinite(bufferOffset) ? Math.max(0, Math.floor(bufferOffset)) : 0;
    const limit = offset + Math.max(0, textLength);
    return state.ranges
        .filter((range) => {
            if (!Array.isArray(range) || range.length < 2) {
                return false;
            }
            const [start, end] = range;
            if (!Number.isFinite(start) || !Number.isFinite(end)) {
                return false;
            }
            return end >= offset && start < limit;
        })
        .map(([start, end]) => [
            Math.max(0, start - offset),
            Math.max(0, Math.min(limit - offset - 1, end - offset)),
        ])
        .sort((a, b) => a[0] - b[0]);
}

function scanQuotes(text, quoteState, options = {}) {
    const state = quoteState || createQuoteState(options.bufferOffset);
    const offset = Number.isFinite(options.bufferOffset) ? Math.max(0, Math.floor(options.bufferOffset)) : 0;
    const startIndex = Number.isFinite(options.startIndex) && options.startIndex >= 0
        ? Math.min(Math.floor(options.startIndex), text.length)
        : 0;
    const reset = Boolean(options.reset);

    if (reset) {
        state.ranges = [];
        state.stack = [];
        state.lastIndex = offset - 1;
    } else {
        if (!Array.isArray(state.ranges)) {
            state.ranges = [];
        }
        if (!Array.isArray(state.stack)) {
            state.stack = [];
        }
    }

    const isLikelyApostrophe = (index) => {
        if (index < 0 || index >= text.length) {
            return false;
        }
        const prev = index > 0 ? text[index - 1] : "";
        const next = index + 1 < text.length ? text[index + 1] : "";
        return WORD_CHAR_REGEX.test(prev) && WORD_CHAR_REGEX.test(next);
    };

    let absoluteIndex = offset + startIndex;
    for (let i = startIndex; i < text.length; i += 1, absoluteIndex += 1) {
        const ch = text[i];
        const openerInfo = QUOTE_OPENERS.get(ch);
        if (openerInfo) {
            if (openerInfo.symmetric) {
                if (openerInfo.apostropheSensitive && isLikelyApostrophe(i)) {
                    continue;
                }
                const top = state.stack[state.stack.length - 1];
                if (top && top.open === ch && top.symmetric) {
                    state.stack.pop();
                    state.ranges.push([top.index, absoluteIndex]);
                } else {
                    state.stack.push({
                        open: ch,
                        close: openerInfo.close,
                        index: absoluteIndex,
                        symmetric: true,
                        apostropheSensitive: openerInfo.apostropheSensitive,
                    });
                }
                continue;
            }
            state.stack.push({ open: ch, close: openerInfo.close, index: absoluteIndex, symmetric: false });
            continue;
        }

        const closeCandidates = QUOTE_CLOSERS.get(ch);
        if (closeCandidates && state.stack.length) {
            for (let j = state.stack.length - 1; j >= 0; j -= 1) {
                const candidate = state.stack[j];
                if (!candidate.symmetric && candidate.close === ch && closeCandidates.includes(candidate.open)) {
                    state.stack.splice(j, 1);
                    state.ranges.push([candidate.index, absoluteIndex]);
                    break;
                }
            }
            continue;
        }

        const top = state.stack[state.stack.length - 1];
        if (top && top.symmetric && ch === top.close) {
            state.stack.pop();
            state.ranges.push([top.index, absoluteIndex]);
        }
    }

    state.lastIndex = Math.max(state.lastIndex, text.length > 0 ? offset + text.length - 1 : offset - 1);
    state.windowOffset = offset;
    return state;
}

export function getQuoteRanges(text) {
    if (!text) {
        return [];
    }
    const input = typeof text === "string" ? text : String(text ?? "");
    const state = createQuoteState(0);
    scanQuotes(input, state, { startIndex: 0, bufferOffset: 0, reset: true });
    return projectQuoteRanges(state, 0, input.length);
}

export function isIndexInsideQuotes(index, quoteRanges) {
    for (const [start, end] of quoteRanges) {
        if (index > start && index < end) {
            return true;
        }
    }
    return false;
}

export function findMatches(text, regex, quoteRanges, options = {}) {
    if (!text || !regex) {
        return [];
    }
    const results = [];
    const searchInsideQuotes = Boolean(options.searchInsideQuotes);
    const tokenOffsets = Array.isArray(options.tokenOffsets) && options.tokenOffsets.length
        ? options.tokenOffsets
        : null;
    const startTokenIndex = Number.isFinite(options.startTokenIndex)
        ? Math.max(0, Math.floor(options.startTokenIndex))
        : null;
    const minTokenIndex = Number.isFinite(options.minTokenIndex)
        ? Math.max(-1, Math.floor(options.minTokenIndex))
        : null;
    const fallbackStartIndex = Number.isFinite(options.startIndex) && options.startIndex > 0
        ? Math.max(0, Math.floor(options.startIndex))
        : 0;
    const fallbackMinIndex = Number.isFinite(options.minIndex)
        ? Math.max(0, Math.floor(options.minIndex))
        : null;
    const resolvedStartIndex = tokenOffsets && startTokenIndex != null
        ? Math.max(0, tokenIndexToCharStart(tokenOffsets, startTokenIndex, text.length) ?? fallbackStartIndex)
        : fallbackStartIndex;
    const resolvedMinIndex = fallbackMinIndex;
    const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
    const matcher = new RegExp(regex.source, flags);
    if (resolvedStartIndex > 0) {
        matcher.lastIndex = resolvedStartIndex;
    }
    let match;
    while ((match = matcher.exec(text)) !== null) {
        const matchLength = typeof match[0] === "string" ? match[0].length : 0;
        let shouldSkip = false;
        if (resolvedMinIndex != null && match.index + matchLength <= resolvedMinIndex) {
            shouldSkip = true;
        }
        if (shouldSkip) {
            continue;
        }
        if (searchInsideQuotes || !isIndexInsideQuotes(match.index, quoteRanges)) {
            results.push({ match: match[0], groups: match.slice(1), index: match.index });
        }
    }
    return results;
}

export function compileProfileRegexes(profile = {}, options = {}) {
    const unicodeWordPattern = options.unicodeWordPattern || DEFAULT_UNICODE_WORD_PATTERN;
    const boundaryLookbehind = options.boundaryLookbehind || DEFAULT_BOUNDARY_LOOKBEHIND;
    const defaultPronouns = Array.isArray(options.defaultPronouns) && options.defaultPronouns.length
        ? options.defaultPronouns
        : ["he", "she", "they"];

    const honorificParticles = [
        "san",
        "sama",
        "chan",
        "kun",
        "dono",
        "sensei",
        "senpai",
        "shi",
        "씨",
        "さま",
        "さん",
        "くん",
        "ちゃん",
        "様",
        "殿",
        "先輩",
    ];
    const honorificAlternation = honorificParticles.map(particle => escapeRegex(particle)).join("|");
    const honorificPattern = honorificAlternation
        ? `(?:\\s*[-‐‑–—―~]?\\s*(?:${honorificAlternation}))?`
        : "";
    const punctuationSegment = "(?:\\s*[，,、‧·\\u2013\\u2014\\u2026]+\\s*)";
    const punctuationSpacer = `(?:${punctuationSegment})*`;
    const compoundTokenPattern = `(?:(?:\\s+|[-‐‑–—―]\\s*)(?=[\\p{Lu}\\p{Lt}\\p{Lo}])(?:${unicodeWordPattern}+))`;
    const compoundBridge = `(?:${punctuationSpacer}${compoundTokenPattern})?`;
    const descriptorWordPattern = `(?:${unicodeWordPattern}+(?:[-‐‑–—―]${unicodeWordPattern}+)*)`;
    const descriptorSequence = `(?:${descriptorWordPattern}(?:\\s+${descriptorWordPattern}){0,7})`;
    const commaDescriptor = `(?:,\\s*(?:${descriptorSequence}))`;
    const parentheticalDescriptor = `(?:\\s*\\(\\s*(?:${descriptorSequence})\\s*\\))`;
    const descriptorPattern = `(?:${commaDescriptor}|${parentheticalDescriptor}){0,3}`;
    const separatorPattern = `(?:${punctuationSegment}|\\s+)+`;
    const nameTailPattern = `${honorificPattern}(?:['’]s)?${compoundBridge}${descriptorPattern}${separatorPattern}`;

    const ignored = (profile.ignorePatterns || []).map(value => String(value ?? "").trim().toLowerCase()).filter(Boolean);
    const effectivePatterns = gatherProfilePatterns(profile)
        .map(value => String(value ?? "").trim())
        .filter(value => value && !ignored.includes(value.toLowerCase()));

    const attributionVerbsPattern = buildAlternation(profile.attributionVerbs);
    const actionVerbsPattern = buildAlternation(profile.actionVerbs);
    const pronounVocabulary = Array.isArray(profile.pronounVocabulary) && profile.pronounVocabulary.length
        ? profile.pronounVocabulary
        : defaultPronouns;
    const pronounPattern = buildAlternation(pronounVocabulary);

    const speakerTemplate = "(?:^|[\\r\\n]+|[>\\]]\\s*)({{PATTERNS}})\\s*:";
    const fillerRunupPattern = `(?:${unicodeWordPattern}+\\s+){0,7}?`;
    const attributionTemplate = attributionVerbsPattern
        ? `${boundaryLookbehind}({{PATTERNS}})${nameTailPattern}${fillerRunupPattern}(?:${attributionVerbsPattern})`
        : null;
    const actionTemplate = actionVerbsPattern
        ? `${boundaryLookbehind}({{PATTERNS}})${nameTailPattern}${fillerRunupPattern}(?:${actionVerbsPattern})`
        : null;

    const pronounLeadBoundary = `(?<!${unicodeWordPattern})\\b`;

    const regexes = {
        speakerRegex: buildRegex(effectivePatterns, speakerTemplate),
        speakerFallbackRegex: speakerTemplate
            ? buildFallbackRegexFromTemplate(speakerTemplate, unicodeWordPattern)
            : null,
        attributionRegex: attributionTemplate ? buildRegex(effectivePatterns, attributionTemplate, { extraFlags: "u" }) : null,
        attributionFallbackRegex: attributionTemplate
            ? buildFallbackRegexFromTemplate(attributionTemplate, unicodeWordPattern, { extraFlags: "u" })
            : null,
        actionRegex: actionTemplate ? buildRegex(effectivePatterns, actionTemplate, { extraFlags: "u" }) : null,
        actionFallbackRegex: actionTemplate
            ? buildFallbackRegexFromTemplate(actionTemplate, unicodeWordPattern, { extraFlags: "u" })
            : null,
        pronounRegex: (actionVerbsPattern && pronounPattern)
            ? new RegExp(
                `${pronounLeadBoundary}(?:${pronounPattern})(?:['’]s)?\\s+(?:${unicodeWordPattern}+\\s+){0,3}?(?:${actionVerbsPattern})`,
                "iu",
            )
            : null,
        vocativeRegex: buildRegex(effectivePatterns, `["“'\\s]({{PATTERNS}})[,.!?]`),
        vocativeFallbackRegex: buildFallbackRegexFromTemplate(`["“'\\s]({{PATTERNS}})[,.!?]`, unicodeWordPattern),
        possessiveRegex: buildRegex(effectivePatterns, `\\b({{PATTERNS}})['’]s\\b`),
        possessiveFallbackRegex: buildFallbackRegexFromTemplate(`\\b({{PATTERNS}})['’]s\\b`, unicodeWordPattern),
        nameRegex: buildRegex(effectivePatterns, `\\b({{PATTERNS}})\\b`),
        vetoRegex: buildGenericRegex(profile.vetoPatterns),
    };

    const preprocessorScripts = collectProfilePreprocessorScripts(profile);
    regexes.preprocessorScripts = preprocessorScripts;

    regexes.effectivePatterns = effectivePatterns;
    return {
        regexes,
        effectivePatterns,
        pronounPattern,
        preprocessorScripts,
    };
}

function sanitizeAppliedScripts(applied = []) {
    if (!Array.isArray(applied) || !applied.length) {
        return [];
    }
    const sanitized = [];
    applied.forEach((entry, index) => {
        if (!entry || typeof entry !== "object") {
            return;
        }
        const script = entry.script && typeof entry.script === "object" ? entry.script : null;
        const resolvedName = script && typeof script.name === "string" && script.name.trim()
            ? script.name.trim()
            : script && typeof script.label === "string" && script.label.trim()
                ? script.label.trim()
                : script && typeof script.title === "string" && script.title.trim()
                    ? script.title.trim()
                    : script && typeof script.id === "string"
                        ? script.id.trim()
                        : `Script ${index + 1}`;
        const resolvedDescription = script && typeof script.description === "string"
            ? script.description.trim()
            : script && typeof script.desc === "string"
                ? script.desc.trim()
                : "";
        sanitized.push({
            collection: typeof entry.collection === "string" ? entry.collection : null,
            script: script
                ? {
                    id: script.id ?? script.scriptId ?? null,
                    name: resolvedName,
                    description: resolvedDescription,
                }
                : null,
        });
    });
    return sanitized;
}

export function collectDetections(text, profile = {}, regexes = {}, options = {}) {
    const matches = [];
    const rawText = typeof text === "string" ? text : String(text ?? "");
    const originalText = typeof options.originalText === "string"
        ? options.originalText
        : rawText;
    matches.originalText = originalText;
    matches.preprocessedText = rawText;
    matches.preprocessorScripts = [];
    const translateNames = Boolean(options?.translateNames ?? profile?.translateNames ?? false);
    const candidateList = Array.isArray(regexes?.effectivePatterns) ? regexes.effectivePatterns : [];
    const aliasMap = buildAliasCanonicalMap(profile);
    const preprocessName = createNamePreprocessor({
        candidates: candidateList,
        translate: translateNames,
        aliasMap,
    });
    if (!originalText || !profile) {
        return matches;
    }
    const pipeline = Array.isArray(regexes.preprocessorScripts) ? regexes.preprocessorScripts : [];
    const preprocessorResult = applyPreprocessorScripts(originalText, pipeline);
    const sourceText = typeof preprocessorResult?.text === "string" ? preprocessorResult.text : originalText;
    matches.preprocessedText = sourceText;
    matches.preprocessorScripts = sanitizeAppliedScripts(preprocessorResult?.applied);
    const bufferOffset = Number.isFinite(options.bufferOffset) ? Math.max(0, Math.floor(options.bufferOffset)) : 0;
    const quoteState = typeof options.quoteState === "object" && options.quoteState ? options.quoteState : null;
    let quoteRanges;
    if (Array.isArray(options.quoteRanges)) {
        quoteRanges = options.quoteRanges;
    } else if (quoteState) {
        const resetQuotes = !Number.isFinite(options.lastIndex)
            || options.lastIndex < bufferOffset - 1
            || Boolean(options.resetQuoteState);
        const resolvedStartIndex = Number.isFinite(options.startIndex) && options.startIndex >= 0
            ? Math.max(0, Math.min(Math.floor(options.startIndex), sourceText.length))
            : 0;
        const relativeFromLast = Number.isFinite(options.lastIndex)
            ? Math.max(0, Math.floor(options.lastIndex + 1 - bufferOffset))
            : 0;
        const quoteStart = resetQuotes ? 0 : Math.min(resolvedStartIndex, relativeFromLast);
        scanQuotes(sourceText, quoteState, {
            startIndex: quoteStart,
            bufferOffset,
            reset: resetQuotes,
        });
        quoteRanges = projectQuoteRanges(quoteState, bufferOffset, sourceText.length);
    } else {
        quoteRanges = getQuoteRanges(sourceText);
    }
    const priorityWeights = options.priorityWeights || {};
    const scanDialogueActions = Boolean(options.scanDialogueActions);
    const tokenProjection = buildTokenProjection(profile, sourceText);
    const tokenOffsets = Array.isArray(tokenProjection?.offsets) && tokenProjection.offsets.length
        ? tokenProjection.offsets
        : null;
    const rawStartIndex = Number.isFinite(options.startIndex) && options.startIndex > 0
        ? Math.max(0, Math.floor(options.startIndex))
        : 0;
    const rawMinIndex = Number.isFinite(options.minIndex)
        ? Math.max(0, Math.floor(options.minIndex))
        : null;
    let startTokenIndex = null;
    let minTokenIndex = null;
    let effectiveStartIndex = rawStartIndex;
    let effectiveMinIndex = rawMinIndex;
    if (tokenOffsets) {
        startTokenIndex = findTokenIndexCeil(tokenOffsets, rawStartIndex);
        if (startTokenIndex != null) {
            const mapped = tokenIndexToCharStart(tokenOffsets, startTokenIndex, sourceText.length);
            if (Number.isFinite(mapped)) {
                effectiveStartIndex = mapped;
            }
        }
        if (rawMinIndex != null && rawMinIndex > 0) {
            const floorIndex = findTokenIndexFloor(tokenOffsets, rawMinIndex);
            if (floorIndex != null) {
                minTokenIndex = floorIndex;
            }
        }
    }
    const matchOptions = {
        startIndex: effectiveStartIndex,
        minIndex: effectiveMinIndex,
        tokenOffsets,
        startTokenIndex,
        minTokenIndex,
    };

    const addMatch = (name, matchKind, index, priority, length = null, span = null) => {
        const trimmedName = String(name ?? "").trim();
        if (!trimmedName) {
            return;
        }
        const tokenIndex = Number.isFinite(span?.start) ? span.start : null;
        const tokenLength = Number.isFinite(span?.length) && span.length > 0 ? span.length : null;
        matches.push({
            name: trimmedName,
            rawName: trimmedName,
            matchKind,
            matchIndex: Number.isFinite(index) ? index : null,
            priority: Number.isFinite(priority) ? priority : null,
            matchLength: Number.isFinite(length) && length > 0 ? length : null,
            tokenIndex,
            tokenLength,
            nameResolution: null,
        });
    };

    const getMatchLength = (match) => {
        const value = typeof match?.match === "string" ? match.match.length : null;
        return Number.isFinite(value) && value > 0 ? value : null;
    };

    if (regexes.speakerRegex) {
        findMatches(sourceText, regexes.speakerRegex, quoteRanges, matchOptions).forEach(match => {
            const name = match.groups?.[0]?.trim();
            const span = tokenOffsets ? computeMatchTokenSpan(tokenOffsets, match.index, getMatchLength(match)) : null;
            addMatch(name, "speaker", match.index, priorityWeights.speaker, getMatchLength(match), span);
        });
    }

    if (profile.detectAttribution !== false && regexes.attributionRegex) {
        findMatches(
            sourceText,
            regexes.attributionRegex,
            quoteRanges,
            { searchInsideQuotes: scanDialogueActions, ...matchOptions },
        ).forEach(match => {
            const name = match.groups?.find(group => group)?.trim();
            const span = tokenOffsets ? computeMatchTokenSpan(tokenOffsets, match.index, getMatchLength(match)) : null;
            addMatch(name, "attribution", match.index, priorityWeights.attribution, getMatchLength(match), span);
        });
    }

    if (profile.detectAction !== false && regexes.actionRegex) {
        findMatches(
            sourceText,
            regexes.actionRegex,
            quoteRanges,
            { searchInsideQuotes: scanDialogueActions, ...matchOptions },
        ).forEach(match => {
            const name = match.groups?.find(group => group)?.trim();
            const span = tokenOffsets ? computeMatchTokenSpan(tokenOffsets, match.index, getMatchLength(match)) : null;
            addMatch(name, "action", match.index, priorityWeights.action, getMatchLength(match), span);
        });
    }

    const validatedSubject = typeof options.lastSubject === "string"
        ? options.lastSubject.trim()
        : "";

    if (profile.detectPronoun && regexes.pronounRegex && validatedSubject) {
        findMatches(sourceText, regexes.pronounRegex, quoteRanges, matchOptions).forEach(match => {
            const span = tokenOffsets ? computeMatchTokenSpan(tokenOffsets, match.index, getMatchLength(match)) : null;
            addMatch(validatedSubject, "pronoun", match.index, priorityWeights.pronoun, getMatchLength(match), span);
        });
    }

    if (profile.detectVocative !== false && regexes.vocativeRegex) {
        findMatches(
            sourceText,
            regexes.vocativeRegex,
            quoteRanges,
            { searchInsideQuotes: true, ...matchOptions },
        ).forEach(match => {
            const name = match.groups?.[0]?.trim();
            const span = tokenOffsets ? computeMatchTokenSpan(tokenOffsets, match.index, getMatchLength(match)) : null;
            addMatch(name, "vocative", match.index, priorityWeights.vocative, getMatchLength(match), span);
        });
    }

    if (profile.detectPossessive && regexes.possessiveRegex) {
        findMatches(sourceText, regexes.possessiveRegex, quoteRanges, matchOptions).forEach(match => {
            const name = match.groups?.[0]?.trim();
            const span = tokenOffsets ? computeMatchTokenSpan(tokenOffsets, match.index, getMatchLength(match)) : null;
            addMatch(name, "possessive", match.index, priorityWeights.possessive, getMatchLength(match), span);
        });
    }

    if (profile.detectGeneral && regexes.nameRegex) {
        findMatches(sourceText, regexes.nameRegex, quoteRanges, matchOptions).forEach(match => {
            const raw = match.groups?.[0] ?? match.match;
            const name = String(raw ?? "").replace(/-(?:sama|san)$/i, "").trim();
            const span = tokenOffsets ? computeMatchTokenSpan(tokenOffsets, match.index, getMatchLength(match)) : null;
            addMatch(name, "name", match.index, priorityWeights.name, getMatchLength(match), span);
        });
    }

    if (regexes.vetoRegex) {
        findMatches(sourceText, regexes.vetoRegex, quoteRanges, matchOptions).some(match => {
            matches.vetoMatch = {
                phrase: match.groups?.[0] || match.match,
                index: match.index,
                length: typeof match.match === "string" ? match.match.length : 0,
            };
            matches.vetoPhrase = matches.vetoMatch.phrase;
            return true;
        });
    }


    matches.forEach((match) => {
        const preResolved = match.__preResolved;
        if (preResolved) {
            delete match.__preResolved;
        }
        if ("__fallbackHash" in match) {
            delete match.__fallbackHash;
        }
        const resolution = preResolved || preprocessName(match.name, { priority: match.priority });
        if (resolution) {
            match.rawName = resolution.raw || match.rawName || match.name;
            match.name = resolution.canonical || match.name;
            match.normalizedName = resolution.normalized || match.name;
            match.nameResolution = resolution;
        }
    });

    matches.tokenizerId = tokenProjection?.tokenizerId || null;
    matches.tokenCount = Number.isFinite(tokenProjection?.count) ? tokenProjection.count : tokenOffsets?.length || null;
    matches.tokenOffsets = tokenOffsets ? cloneTokenOffsets(tokenOffsets) : null;
    matches.tokenCountPromise = tokenProjection?.countPromise || null;
    matches.startTokenIndex = startTokenIndex;
    matches.minTokenIndex = minTokenIndex;

    return matches;
}
