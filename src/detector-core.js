const DEFAULT_UNICODE_WORD_PATTERN = "[\\p{L}\\p{M}\\p{N}_]";
const WORD_CHAR_REGEX = /[\p{L}\p{M}\p{N}]/u;
const DEFAULT_BOUNDARY_LOOKBEHIND = "(?<![A-Za-z0-9_'’])";

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

export function getQuoteRanges(text) {
    if (!text) {
        return [];
    }
    const ranges = [];
    const stack = [];
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
    for (const pair of QUOTE_PAIRS) {
        const info = {
            close: pair.close,
            symmetric: Boolean(pair.symmetric),
            apostropheSensitive: Boolean(pair.apostropheSensitive),
        };
        QUOTE_OPENERS.set(pair.open, info);
        if (info.symmetric) {
            continue;
        }
        if (!QUOTE_CLOSERS.has(pair.close)) {
            QUOTE_CLOSERS.set(pair.close, []);
        }
        QUOTE_CLOSERS.get(pair.close).push(pair.open);
    }

    const isLikelyApostrophe = (index) => {
        if (index < 0 || index >= text.length) {
            return false;
        }
        const prev = index > 0 ? text[index - 1] : "";
        const next = index + 1 < text.length ? text[index + 1] : "";
        return WORD_CHAR_REGEX.test(prev) && WORD_CHAR_REGEX.test(next);
    };

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        const openerInfo = QUOTE_OPENERS.get(ch);
        if (openerInfo) {
            if (openerInfo.symmetric) {
                if (openerInfo.apostropheSensitive && isLikelyApostrophe(i)) {
                    continue;
                }
                const top = stack[stack.length - 1];
                if (top && top.open === ch && top.symmetric) {
                    stack.pop();
                    ranges.push([top.index, i]);
                } else {
                    stack.push({
                        open: ch,
                        close: openerInfo.close,
                        index: i,
                        symmetric: true,
                        apostropheSensitive: openerInfo.apostropheSensitive,
                    });
                }
                continue;
            }
            stack.push({ open: ch, close: openerInfo.close, index: i, symmetric: false });
            continue;
        }

        const closeCandidates = QUOTE_CLOSERS.get(ch);
        if (closeCandidates && stack.length) {
            for (let j = stack.length - 1; j >= 0; j -= 1) {
                const candidate = stack[j];
                if (!candidate.symmetric && candidate.close === ch && closeCandidates.includes(candidate.open)) {
                    stack.splice(j, 1);
                    ranges.push([candidate.index, i]);
                    break;
                }
            }
            continue;
        }

        const top = stack[stack.length - 1];
        if (top && top.symmetric && ch === top.close) {
            stack.pop();
            ranges.push([top.index, i]);
        }
    }

    return ranges.sort((a, b) => a[0] - b[0]);
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
    const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
    const matcher = new RegExp(regex.source, flags);
    let match;
    while ((match = matcher.exec(text)) !== null) {
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

    const ignored = (profile.ignorePatterns || []).map(value => String(value ?? "").trim().toLowerCase()).filter(Boolean);
    const effectivePatterns = (profile.patterns || [])
        .map(value => String(value ?? "").trim())
        .filter(value => value && !ignored.includes(value.toLowerCase()));

    const attributionVerbsPattern = buildAlternation(profile.attributionVerbs);
    const actionVerbsPattern = buildAlternation(profile.actionVerbs);
    const pronounVocabulary = Array.isArray(profile.pronounVocabulary) && profile.pronounVocabulary.length
        ? profile.pronounVocabulary
        : defaultPronouns;
    const pronounPattern = buildAlternation(pronounVocabulary);

    const speakerTemplate = "(?:^|[\\r\\n]+|[>\\]]\\s*)({{PATTERNS}})\\s*:";
    const attributionTemplate = attributionVerbsPattern
        ? `${boundaryLookbehind}({{PATTERNS}})\\s+(?:${attributionVerbsPattern})`
        : null;
    const actionTemplate = actionVerbsPattern
        ? `${boundaryLookbehind}({{PATTERNS}})(?:['’]s)?\\s+(?:${unicodeWordPattern}+\\s+){0,3}?(?:${actionVerbsPattern})`
        : null;

    const regexes = {
        speakerRegex: buildRegex(effectivePatterns, speakerTemplate),
        attributionRegex: attributionTemplate ? buildRegex(effectivePatterns, attributionTemplate) : null,
        actionRegex: actionTemplate ? buildRegex(effectivePatterns, actionTemplate, { extraFlags: "u" }) : null,
        pronounRegex: (actionVerbsPattern && pronounPattern)
            ? new RegExp(
                `(?:^|[\\r\\n]+)\\s*(?:${pronounPattern})(?:['’]s)?\\s+(?:${unicodeWordPattern}+\\s+){0,3}?(?:${actionVerbsPattern})`,
                "iu",
            )
            : null,
        vocativeRegex: buildRegex(effectivePatterns, `["“'\\s]({{PATTERNS}})[,.!?]`),
        possessiveRegex: buildRegex(effectivePatterns, `\\b({{PATTERNS}})['’]s\\b`),
        nameRegex: buildRegex(effectivePatterns, `\\b({{PATTERNS}})\\b`),
        vetoRegex: buildGenericRegex(profile.vetoPatterns),
    };

    return {
        regexes,
        effectivePatterns,
        pronounPattern,
    };
}

export function collectDetections(text, profile = {}, regexes = {}, options = {}) {
    if (!text || !profile) {
        return [];
    }
    const quoteRanges = options.quoteRanges || getQuoteRanges(text);
    const priorityWeights = options.priorityWeights || {};
    const matches = [];

    const addMatch = (name, matchKind, index, priority) => {
        const trimmedName = String(name ?? "").trim();
        if (!trimmedName) {
            return;
        }
        matches.push({
            name: trimmedName,
            matchKind,
            matchIndex: Number.isFinite(index) ? index : null,
            priority: Number.isFinite(priority) ? priority : null,
        });
    };

    if (regexes.speakerRegex) {
        findMatches(text, regexes.speakerRegex, quoteRanges).forEach(match => {
            const name = match.groups?.[0]?.trim();
            addMatch(name, "speaker", match.index, priorityWeights.speaker);
        });
    }

    if (profile.detectAttribution !== false && regexes.attributionRegex) {
        findMatches(text, regexes.attributionRegex, quoteRanges).forEach(match => {
            const name = match.groups?.find(group => group)?.trim();
            addMatch(name, "attribution", match.index, priorityWeights.attribution);
        });
    }

    if (profile.detectAction !== false && regexes.actionRegex) {
        findMatches(text, regexes.actionRegex, quoteRanges).forEach(match => {
            const name = match.groups?.find(group => group)?.trim();
            addMatch(name, "action", match.index, priorityWeights.action);
        });
    }

    if (profile.detectPronoun && regexes.pronounRegex && options.lastSubject) {
        findMatches(text, regexes.pronounRegex, quoteRanges).forEach(match => {
            addMatch(options.lastSubject, "pronoun", match.index, priorityWeights.pronoun);
        });
    }

    if (profile.detectVocative !== false && regexes.vocativeRegex) {
        findMatches(text, regexes.vocativeRegex, quoteRanges, { searchInsideQuotes: true }).forEach(match => {
            const name = match.groups?.[0]?.trim();
            addMatch(name, "vocative", match.index, priorityWeights.vocative);
        });
    }

    if (profile.detectPossessive && regexes.possessiveRegex) {
        findMatches(text, regexes.possessiveRegex, quoteRanges).forEach(match => {
            const name = match.groups?.[0]?.trim();
            addMatch(name, "possessive", match.index, priorityWeights.possessive);
        });
    }

    if (profile.detectGeneral && regexes.nameRegex) {
        findMatches(text, regexes.nameRegex, quoteRanges).forEach(match => {
            const raw = match.groups?.[0] ?? match.match;
            const name = String(raw ?? "").replace(/-(?:sama|san)$/i, "").trim();
            addMatch(name, "name", match.index, priorityWeights.name);
        });
    }

    return matches;
}
