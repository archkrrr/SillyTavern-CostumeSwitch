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
        attributionRegex: attributionTemplate ? buildRegex(effectivePatterns, attributionTemplate, { extraFlags: "u" }) : null,
        actionRegex: actionTemplate ? buildRegex(effectivePatterns, actionTemplate, { extraFlags: "u" }) : null,
        pronounRegex: (actionVerbsPattern && pronounPattern)
            ? new RegExp(
                `${pronounLeadBoundary}(?:${pronounPattern})(?:['’]s)?\\s+(?:${unicodeWordPattern}+\\s+){0,3}?(?:${actionVerbsPattern})`,
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
    const scanDialogueActions = Boolean(options.scanDialogueActions);
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
        findMatches(text, regexes.attributionRegex, quoteRanges, { searchInsideQuotes: scanDialogueActions }).forEach(match => {
            const name = match.groups?.find(group => group)?.trim();
            addMatch(name, "attribution", match.index, priorityWeights.attribution);
        });
    }

    if (profile.detectAction !== false && regexes.actionRegex) {
        findMatches(text, regexes.actionRegex, quoteRanges, { searchInsideQuotes: scanDialogueActions }).forEach(match => {
            const name = match.groups?.find(group => group)?.trim();
            addMatch(name, "action", match.index, priorityWeights.action);
        });
    }

    const validatedSubject = typeof options.lastSubject === "string"
        ? options.lastSubject.trim()
        : "";

    if (profile.detectPronoun && regexes.pronounRegex && validatedSubject) {
        findMatches(text, regexes.pronounRegex, quoteRanges).forEach(match => {
            addMatch(validatedSubject, "pronoun", match.index, priorityWeights.pronoun);
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
