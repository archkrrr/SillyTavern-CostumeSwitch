import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, event_types, eventSource } from "../../../../script.js";
import { executeSlashCommandsOnChatInput } from "../../../slash-commands.js";

const extensionName = "SillyTavern-CostumeSwitch";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// Default settings for a single profile.
const PROFILE_DEFAULTS = {
    patterns: ["Char A", "Char B", "Char C", "Char D"],
    ignorePatterns: [],
    vetoPatterns: ["OOC:", "(OOC)"],
    defaultCostume: "",
    debug: false,
    globalCooldownMs: 1200,
    perTriggerCooldownMs: 250,
    failedTriggerCooldownMs: 10000,
    maxBufferChars: 2000,
    repeatSuppressMs: 800,
    mappings: [],
    detectAttribution: true,
    detectAction: true,
    detectVocative: true,
    detectPossessive: true,
    detectGeneral: false,
};

// Top-level settings object which contains all profiles.
const DEFAULTS = {
    enabled: true,
    profiles: {
        'Default': structuredClone(PROFILE_DEFAULTS),
    },
    activeProfile: 'Default',
};

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function parsePatternEntry(raw) { const t = String(raw || '').trim(); if (!t) return null; const m = t.match(/^\/((?:\\.|[^\/])+)\/([gimsuy]*)$/); return m ? { body: m[1], flags: m[2] || '' } : { body: escapeRegex(t), flags: '' }; }
function computeFlagsFromEntries(entries, requireI = true) { const f = new Set(); for (const e of entries) { if (!e) continue; for (const c of (e.flags || '')) f.add(c); } if (requireI) f.add('i'); return Array.from(f).filter(c => 'gimsuy'.includes(c)).join(''); }

function buildGenericRegex(patternList) {
    const entries = (patternList || []).map(parsePatternEntry).filter(Boolean);
    if (!entries.length) return null;
    const parts = entries.map(e => `(?:${e.body})`);
    const body = `(?:${parts.join('|')})`;
    const flags = computeFlagsFromEntries(entries, true);
    try { return new RegExp(body, flags); } catch (e) { console.warn("buildGenericRegex compile failed:", e); return null; }
}

function buildNameRegex(patternList) { const e = (patternList || []).map(parsePatternEntry).filter(Boolean); if (!e.length) return null; const p = e.map(x => `(?:${x.body})`), b = `(?:^|\\n|[\\(\\[\\-—–])(?:(${p.join('|')}))(?:\\W|$)`, f = computeFlagsFromEntries(e, !0); try { return new RegExp(b, f) } catch (err) { return console.warn("buildNameRegex compile failed:", err), null } }
function buildSpeakerRegex(patternList) { const e = (patternList || []).map(parsePatternEntry).filter(Boolean); if (!e.length) return null; const p = e.map(x => `(?:${x.body})`), b = `(?:^|\\n)\\s*(${p.join('|')})\\s*[:;,]\\s*`, f = computeFlagsFromEntries(e, !0); try { return new RegExp(b, f) } catch (err) { return console.warn("buildSpeakerRegex compile failed:", err), null } }
function buildVocativeRegex(patternList) { const e = (patternList || []).map(parsePatternEntry).filter(Boolean); if (!e.length) return null; const p = e.map(x => `(?:${x.body})`), b = `(?:["“'\\s])(${p.join('|')})[,.!?]`, f = computeFlagsFromEntries(e, !0); try { return new RegExp(b, f) } catch (err) { return console.warn("buildVocativeRegex compile failed:", err), null } }
function buildAttributionRegex(patternList) { const e = (patternList || []).map(parsePatternEntry).filter(Boolean); if (!e.length) return null; const n = e.map(x => `(?:${x.body})`).join("|"), v = "(?:acknowledged|added|admitted|advised|affirmed|agreed|announced|answered|argued|asked|barked|began|bellowed|blurted|boasted|bragged|called|chirped|commanded|commented|complained|conceded|concluded|confessed|confirmed|continued|countered|cried|croaked|crowed|declared|decreed|demanded|denied|drawled|echoed|emphasized|enquired|enthused|estimated|exclaimed|explained|gasped|insisted|instructed|interjected|interrupted|joked|lamented|lied|maintained|moaned|mumbled|murmured|mused|muttered|nagged|nodded|noted|objected|offered|ordered|perked up|pleaded|prayed|predicted|proclaimed|promised|proposed|protested|queried|questioned|quipped|rambled|reasoned|reassured|recited|rejoined|remarked|repeated|replied|responded|retorted|roared|said|scolded|scoffed|screamed|shouted|sighed|snapped|snarled|spoke|stammered|stated|stuttered|suggested|surmised|tapped|threatened|turned|urged|vowed|wailed|warned|whimpered|whispered|wondered|yelled)", p = v + "(?:\\s+(?:out|back|over))?", l = "(?:\\s+[A-Z][a-z]+)*", a = `(?:["“”][^"“”]{0,400}["“”])\\s*,?\\s*(${n})${l}\\s+${p}(?:,)?`, b = `\\b(${n})${l}\\s+${p}\\s*[:,]?\\s*["“”]`, V = `(${n})${l}[’\`']s\\s+(?:[a-z]+,\\s*)?[a-z]+\\s+voice`, c = `(?:["“”][^"“”]{0,400}["“”])\\s*,?\\s*${V}`, d = `${V}[^"“]{0,150}?["“"]`, D = `\\b(${n})${l}[^"“”]{0,150}?["“”]`, B = `(?:${a})|(?:${b})|(?:${c})|(?:${d})|(?:${D})`, f = computeFlagsFromEntries(e, !0); try { return new RegExp(B, f) } catch (err) { return console.warn("buildAttributionRegex compile failed:", err), null } }
function buildActionRegex(patternList) { const e = (patternList || []).map(parsePatternEntry).filter(Boolean); if (!e.length) return null; const n = e.map(x => `(?:${x.body})`).join("|"), a = "(?:adjust|adjusted|appear|appeared|approach|approached|arrive|arrived|blink|blinked|bow|bowed|charge|charged|chase|chased|climb|climbed|collapse|collapsed|crawl|crawled|crept|crouch|crouched|dance|danced|dart|darted|dash|dashed|depart|departed|dive|dived|dodge|dodged|drag|dragged|drift|drifted|drop|dropped|emerge|emerged|enter|entered|exit|exited|fall|fell|flee|fled|flinch|flinched|float|floated|fly|flew|follow|followed|freeze|froze|frown|frowned|gesture|gestured|giggle|giggled|glance|glanced|grab|grabbed|grasp|grasped|grin|grinned|groan|groaned|growl|growled|grumble|grumbled|grunt|grunted|hold|held|hit|hop|hopped|hurry|hurried|jerk|jerked|jog|jogged|jump|jumped|kneel|knelt|laugh|laughed|lean|leaned|leap|leapt|left|limp|limped|look|looked|lower|lowered|lunge|lunged|march|marched|motion|motioned|move|moved|nod|nodded|observe|observed|pace|paced|pause|paused|point|pointed|pop|popped|position|positioned|pounce|pounced|push|pushed|race|raced|raise|raised|reach|reached|retreat|retreated|rise|rose|run|ran|rush|rushed|sit|sat|scramble|scrambled|set|shift|shifted|shake|shook|shrug|shrugged|shudder|shuddered|sigh|sighed|sip|sipped|slip|slipped|slump|slumped|smile|smiled|snort|snorted|spin|spun|sprint|sprinted|stagger|staggered|stare|stared|step|stepped|stand|stood|straighten|straightened|stumble|stumbled|swagger|swaggered|swallow|swallowed|swap|swapped|swing|swung|tap|tapped|throw|threw|tilt|tilted|tiptoe|tiptoed|take|took|toss|tossed|trudge|trudged|turn|turned|twist|twisted|vanish|vanished|wake|woke|walk|walked|wander|wandered|watch|watched|wave|waved|wince|winced|withdraw|withdrew)", p = `\\b(${n})(?:\\s+[A-Z][a-z]+)*\\b(?:\\s+[a-zA-Z'’]+){0,4}?\\s+${a}\\b`, b = `\\b(${n})(?:\\s+[A-Z][a-z]+)*[’\`']s\\s+(?:[a-zA-Z'’]+\\s+){0,4}?[a-zA-Z'’]+\\s+${a}\\b`, c = `\\b(${n})(?:\\s+[A-Z][a-z]+)*[’\`']s\\s+(?:gaze|expression|hand|hands|feet|eyes|head|shoulders|body|figure|glance|smile|frown)`, B = `(?:${p})|(?:${b})|(?:${c})`, f = computeFlagsFromEntries(e, !0); try { return new RegExp(B, f) } catch (err) { return console.warn("buildActionRegex compile failed:", err), null } }

function getQuoteRanges(s) { const q=/"|\u201C|\u201D/g,pos=[],ranges=[];let m;while((m=q.exec(s))!==null)pos.push(m.index);for(let i=0;i+1<pos.length;i+=2)ranges.push([pos[i],pos[i+1]]);return ranges }
function isIndexInsideQuotesRanges(ranges,idx){for(const[a,b]of ranges)if(idx>a&&idx<b)return!0;return!1}
function findMatches(combined,regex,quoteRanges,searchInsideQuotes=!1){if(!combined||!regex)return[];const flags=regex.flags.includes("g")?regex.flags:regex.flags+"g",re=new RegExp(regex.source,flags),results=[];let m;for(; (m=re.exec(combined))!==null;){const idx=m.index||0;(searchInsideQuotes||!isIndexInsideQuotesRanges(quoteRanges,idx))&&results.push({match:m[0],groups:m.slice(1),index:idx}),re.lastIndex===m.index&&re.lastIndex++}return results}
function findAllMatches(combined,regexes,settings,quoteRanges){const allMatches=[],{speakerRegex,attributionRegex,actionRegex,vocativeRegex,nameRegex}=regexes,priorities={speaker:5,attribution:4,action:3,vocative:2,possessive:1,name:0};if(speakerRegex&&findMatches(combined,speakerRegex,quoteRanges).forEach(m=>{const name=m.groups?.[0]?.trim();name&&allMatches.push({name,matchKind:"speaker",matchIndex:m.index,priority:priorities.speaker})}),settings.detectAttribution&&attributionRegex&&findMatches(combined,attributionRegex,quoteRanges).forEach(m=>{const name=m.groups?.find(g=>g)?.trim();name&&allMatches.push({name,matchKind:"attribution",matchIndex:m.index,priority:priorities.attribution})}),settings.detectAction&&actionRegex&&findMatches(combined,actionRegex,quoteRanges).forEach(m=>{const name=m.groups?.find(g=>g)?.trim();name&&allMatches.push({name,matchKind:"action",matchIndex:m.index,priority:priorities.action})}),settings.detectVocative&&vocativeRegex&&findMatches(combined,vocativeRegex,quoteRanges,!0).forEach(m=>{const name=m.groups?.[0]?.trim();name&&allMatches.push({name,matchKind:"vocative",matchIndex:m.index,priority:priorities.vocative})}),settings.detectPossessive&&settings.patterns?.length){const names_poss=settings.patterns.map(s=>(s||"").trim()).filter(Boolean);if(names_poss.length){const possRe=new RegExp("\\b("+names_poss.map(escapeRegex).join("|")+")[’'`']s\\b","gi");findMatches(combined,possRe,quoteRanges).forEach(m=>{const name=m.groups?.[0]?.trim();name&&allMatches.push({name,matchKind:"possessive",matchIndex:m.index,priority:priorities.possessive})})}}return settings.detectGeneral&&nameRegex&&findMatches(combined,nameRegex,quoteRanges).forEach(m=>{const name=String(m.groups?.[0]||m.match).replace(/-(?:sama|san)$/i,"").trim();name&&allMatches.push({name,matchKind:"name",matchIndex:m.index,priority:priorities.name})}),allMatches}
function findBestMatch(combined,regexes,settings,quoteRanges){if(!combined)return null;const allMatches=findAllMatches(combined,regexes,settings,quoteRanges);if(0===allMatches.length)return null;const activeMatches=allMatches.filter(m=>"speaker"===m.matchKind||"attribution"===m.matchKind||"action"===m.matchKind);if(activeMatches.length>0)return activeMatches.sort((a,b)=>b.matchIndex-a.matchIndex),activeMatches[0];const passiveMatches=allMatches.filter(m=>"vocative"===m.matchKind||"possessive"===m.matchKind||"name"===m.matchKind);return passiveMatches.length>0?(passiveMatches.sort((a,b)=>b.matchIndex-a.matchIndex),passiveMatches[0]):null}
function normalizeStreamText(s){return s?String(s).replace(/[\uFEFF\u200B\u200C\u200D]/g,"").replace(/[\u2018\u2019\u201A\u201B]/g,"'").replace(/[\u201C\u201D\u201E\u201F]/g,'"').replace(/(\*\*|__|~~|`{1,3})/g,"").replace(/\u00A0/g," "):""}
function normalizeCostumeName(n){if(!n)return"";let s=String(n).trim();s.startsWith("/")&&(s=s.slice(1).trim());const first=s.split(/[\/\s]+/).filter(Boolean)[0]||s;return String(first).replace(/[-_](?:sama|san)$/i,"").trim()}
const perMessageBuffers=new Map,perMessageStates=new Map;let lastIssuedCostume=null,lastSwitchTimestamp=0;const lastTriggerTimes=new Map,failedTriggerTimes=new Map;let _streamHandler=null,_genStartHandler=null,_genEndHandler=null,_msgRecvHandler=null,_chatChangedHandler=null;const MAX_MESSAGE_BUFFERS=60;
function ensureBufferLimit(){if(!(perMessageBuffers.size<=60)){for(;perMessageBuffers.size>60;){const firstKey=perMessageBuffers.keys().next().value;perMessageBuffers.delete(firstKey),perMessageStates.delete(firstKey)}}}
function waitForSelector(selector,timeout=3e3,interval=120){return new Promise(resolve=>{const start=Date.now(),iv=setInterval(()=>{const el=document.querySelector(selector);if(el)return clearInterval(iv),void resolve(!0);Date.now()-start>timeout&&(clearInterval(iv),resolve(!1))},interval)})}
function debugLog(settings,...args){try{settings&&getActiveProfile(settings)?.debug&&console.debug.apply(console,["[CostumeSwitch]"].concat(args))}catch(e){}}

// Helper to get the currently active profile object from settings.
function getActiveProfile(settings) {
    return settings?.profiles?.[settings.activeProfile];
}

jQuery(async () => {
    if (typeof executeSlashCommandsOnChatInput !== 'function') {
        console.error("[CostumeSwitch] FATAL: The global 'executeSlashCommandsOnChatInput' function is not available.");
        const statusEl = document.querySelector("#cs-status");
        if (statusEl) { statusEl.textContent = "FATAL ERROR: See console"; statusEl.style.color = "red"; }
        return;
    }

    const { store, save, ctx } = getSettingsObj();
    let settings = store[extensionName]; 

    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $("#extensions_settings").append(settingsHtml);
    } catch (e) {
        console.warn("Failed to load settings.html:", e);
        $("#extensions_settings").append('<div><h3>Costume Switch</h3><div>Failed to load UI (see console)</div></div>');
    }

    const ok = await waitForSelector("#cs-save", 3000, 100);
    if (!ok) console.warn("CostumeSwitch: settings UI did not appear within timeout.");

    let nameRegex, speakerRegex, attributionRegex, actionRegex, vocativeRegex, vetoRegex;

    function recompileRegexes() {
        try {
            const profile = getActiveProfile(settings);
            if (!profile) return;

            const lowerIgnored = (profile.ignorePatterns || []).map(p => String(p).trim().toLowerCase());
            const effectivePatterns = (profile.patterns || []).filter(p => !lowerIgnored.includes(String(p).trim().toLowerCase()));

            nameRegex = buildNameRegex(effectivePatterns);
            speakerRegex = buildSpeakerRegex(effectivePatterns);
            attributionRegex = buildAttributionRegex(effectivePatterns);
            actionRegex = buildActionRegex(effectivePatterns);
            vocativeRegex = buildVocativeRegex(effectivePatterns);
            vetoRegex = buildGenericRegex(profile.vetoPatterns);
            
            $("#cs-error").text("").hide();
        } catch (e) {
            $("#cs-error").text(`Pattern compile error: ${String(e)}`).show();
        }
    }

    function populateProfileDropdown() {
        const select = $("#cs-profile-select");
        select.empty();
        Object.keys(settings.profiles).forEach(name => {
            select.append($('<option>', { value: name, text: name }));
        });
        select.val(settings.activeProfile);
    }

    function loadProfile(profileName) {
        if (!settings.profiles[profileName]) {
            console.warn(`Profile "${profileName}" not found. Loading default.`);
            profileName = Object.keys(settings.profiles)[0];
        }
        settings.activeProfile = profileName;
        const profile = getActiveProfile(settings);

        $("#cs-profile-name").val(profileName);
        $("#cs-patterns").val((profile.patterns || []).join("\n"));
        $("#cs-ignore-patterns").val((profile.ignorePatterns || []).join("\n"));
        $("#cs-veto-patterns").val((profile.vetoPatterns || []).join("\n"));
        $("#cs-default").val(profile.defaultCostume || "");
        $("#cs-debug").prop("checked", !!profile.debug);
        $("#cs-global-cooldown").val(profile.globalCooldownMs || DEFAULTS.globalCooldownMs);
        $("#cs-repeat-suppress").val(profile.repeatSuppressMs || DEFAULTS.repeatSuppressMs);
        $("#cs-detect-attribution").prop("checked", !!profile.detectAttribution);
        $("#cs-detect-action").prop("checked", !!profile.detectAction);
        $("#cs-detect-vocative").prop("checked", !!profile.detectVocative);
        $("#cs-detect-possessive").prop("checked", !!profile.detectPossessive);
        $("#cs-detect-general").prop("checked", !!profile.detectGeneral);
        renderMappings(profile);
        recompileRegexes();
    }

    function renderMappings(profile) {
        const tbody = $("#cs-mappings-tbody");
        if (!tbody.length) return;
        tbody.empty();
        (profile.mappings || []).forEach((m, idx) => {
            const tr = $(`<tr data-idx="${idx}"><td><input class="map-name" value="${(m.name || '').replace(/"/g, '&quot;')}" /></td><td><input class="map-folder" value="${(m.folder || '').replace(/"/g, '&quot;')}" /></td><td><button class="map-remove">Remove</button></td></tr>`);
            tbody.append(tr);
        });
    }

    function persistSettings() {
        if (save) save();
        $("#cs-status").text(`Saved ${new Date().toLocaleTimeString()}`);
        setTimeout(() => $("#cs-status").text("Ready"), 1500);
    }

    $("#cs-enable").prop("checked", !!settings.enabled);
    populateProfileDropdown();
    loadProfile(settings.activeProfile);

    function testRegexPattern() {
        const text = $("#cs-regex-test-input").val();
        if (!text) {
            $("#cs-test-all-detections").html('<li style="color: var(--text-color-soft);">Enter text to test.</li>');
            $("#cs-test-winner-list").html('<li style="color: var(--text-color-soft);">N/A</li>');
            return;
        }
    
        // Create a temporary profile from the current UI state to test unsaved changes.
        const tempProfile = structuredClone(getActiveProfile(settings));
        tempProfile.patterns = $("#cs-patterns").val().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        tempProfile.ignorePatterns = $("#cs-ignore-patterns").val().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        tempProfile.detectAttribution = !!$("#cs-detect-attribution").prop("checked");
        tempProfile.detectAction = !!$("#cs-detect-action").prop("checked");
        tempProfile.detectVocative = !!$("#cs-detect-vocative").prop("checked");
        tempProfile.detectPossessive = !!$("#cs-detect-possessive").prop("checked");
        tempProfile.detectGeneral = !!$("#cs-detect-general").prop("checked");
    
        const lowerIgnored = (tempProfile.ignorePatterns || []).map(p => String(p).trim().toLowerCase());
        const effectivePatterns = (tempProfile.patterns || []).filter(p => !lowerIgnored.includes(String(p).trim().toLowerCase()));
    
        const tempRegexes = {
            speakerRegex: buildSpeakerRegex(effectivePatterns),
            attributionRegex: buildAttributionRegex(effectivePatterns),
            actionRegex: buildActionRegex(effectivePatterns),
            vocativeRegex: buildVocativeRegex(effectivePatterns),
            nameRegex: buildNameRegex(effectivePatterns)
        };
    
        const combined = normalizeStreamText(text);
        const quoteRanges = getQuoteRanges(combined);
    
        const allMatches = findAllMatches(combined, tempRegexes, tempProfile, quoteRanges);
        allMatches.sort((a, b) => a.matchIndex - b.matchIndex); 
    
        const allDetectionsList = $("#cs-test-all-detections");
        allDetectionsList.empty();
        if (allMatches.length > 0) {
            allMatches.forEach(match => {
                allDetectionsList.append(`<li><b>${match.name}</b> <small>(${match.matchKind} @ ${match.matchIndex})</small></li>`);
            });
        } else {
            allDetectionsList.html('<li style="color: var(--text-color-soft);">No detections found.</li>');
        }
    
        const winnerList = $("#cs-test-winner-list");
        winnerList.empty();
        
        // Simulate the stream by checking for the winner as the text buffer "grows".
        const winners = [];
        const words = combined.split(/(\s+)/);
        let currentBuffer = "";
        let lastWinnerName = null;

        for (const word of words) {
            currentBuffer += word;
            const bestMatch = findBestMatch(currentBuffer, tempRegexes, tempProfile, quoteRanges);

            // If a winner is found and it's a new winner, record it.
            if (bestMatch && bestMatch.name !== lastWinnerName) {
                winners.push(bestMatch);
                lastWinnerName = bestMatch.name;
            }
        }
    
        if (winners.length > 0) {
            winners.forEach(match => {
                winnerList.append(`<li><b>${match.name}</b> <small>(${match.matchKind} @ ${match.matchIndex})</small></li>`);
            });
        } else {
            winnerList.html('<li style="color: var(--text-color-soft);">No winning match.</li>');
        }
    }

    function tryWireUI() {
        $("#cs-enable").off('change.cs').on("change.cs", function() {
            settings.enabled = !!$(this).prop("checked");
            persistSettings();
        });

        $("#cs-save").off('click.cs').on("click.cs", () => {
            const profile = getActiveProfile(settings);
            if (!profile) return;

            profile.patterns = $("#cs-patterns").val().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            profile.ignorePatterns = $("#cs-ignore-patterns").val().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            profile.vetoPatterns = $("#cs-veto-patterns").val().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            profile.defaultCostume = $("#cs-default").val().trim();
            profile.debug = !!$("#cs-debug").prop("checked");
            profile.globalCooldownMs = parseInt($("#cs-global-cooldown").val() || PROFILE_DEFAULTS.globalCooldownMs, 10);
            profile.repeatSuppressMs = parseInt($("#cs-repeat-suppress").val() || PROFILE_DEFAULTS.repeatSuppressMs, 10);
            profile.detectAttribution = !!$("#cs-detect-attribution").prop("checked");
            profile.detectAction = !!$("#cs-detect-action").prop("checked");
            profile.detectVocative = !!$("#cs-detect-vocative").prop("checked");
            profile.detectPossessive = !!$("#cs-detect-possessive").prop("checked");
            profile.detectGeneral = !!$("#cs-detect-general").prop("checked");
            
            const newMaps = [];
            $("#cs-mappings-tbody tr").each(function () {
                const name = $(this).find(".map-name").val().trim();
                const folder = $(this).find(".map-folder").val().trim();
                if (name && folder) newMaps.push({ name, folder });
            });
            profile.mappings = newMaps;
            
            recompileRegexes();
            persistSettings();
        });

        $("#cs-profile-select").off('change.cs').on("change.cs", function() {
            loadProfile($(this).val());
            persistSettings(); // Save the active profile change
        });

        $("#cs-profile-save").off('click.cs').on("click.cs", () => {
            const newName = $("#cs-profile-name").val().trim();
            if (!newName) return;

            const oldName = settings.activeProfile;
            
            if (newName !== oldName && settings.profiles[newName]) {
                $("#cs-error").text("A profile with that name already exists.").show();
                return;
            }

            const profileData = {
                patterns: $("#cs-patterns").val().split(/\r?\n/).map(s => s.trim()).filter(Boolean),
                ignorePatterns: $("#cs-ignore-patterns").val().split(/\r?\n/).map(s => s.trim()).filter(Boolean),
                vetoPatterns: $("#cs-veto-patterns").val().split(/\r?\n/).map(s => s.trim()).filter(Boolean),
                defaultCostume: $("#cs-default").val().trim(),
                debug: !!$("#cs-debug").prop("checked"),
                globalCooldownMs: parseInt($("#cs-global-cooldown").val() || PROFILE_DEFAULTS.globalCooldownMs, 10),
                repeatSuppressMs: parseInt($("#cs-repeat-suppress").val() || PROFILE_DEFAULTS.repeatSuppressMs, 10),
                detectAttribution: !!$("#cs-detect-attribution").prop("checked"),
                detectAction: !!$("#cs-detect-action").prop("checked"),
                detectVocative: !!$("#cs-detect-vocative").prop("checked"),
                detectPossessive: !!$("#cs-detect-possessive").prop("checked"),
                detectGeneral: !!$("#cs-detect-general").prop("checked"),
                mappings: []
            };
            const newMaps = [];
            $("#cs-mappings-tbody tr").each(function () {
                const name = $(this).find(".map-name").val().trim();
                const folder = $(this).find(".map-folder").val().trim();
                if (name && folder) newMaps.push({ name, folder });
            });
            profileData.mappings = newMaps;

            if (newName !== oldName) {
                settings.profiles[newName] = profileData;
            } else {
                settings.profiles[oldName] = profileData;
            }
            
            settings.activeProfile = newName;

            populateProfileDropdown();
            $("#cs-error").text("").hide();
            persistSettings();
        });

        $("#cs-profile-delete").off('click.cs').on("click.cs", () => {
            if (Object.keys(settings.profiles).length <= 1) {
                $("#cs-error").text("Cannot delete the last profile.").show();
                return;
            }

            const profileNameToDelete = settings.activeProfile;

            if (!settings.profiles[profileNameToDelete]) {
                console.error(`[CostumeSwitch] Tried to delete a non-existent profile: "${profileNameToDelete}"`);
                $("#cs-error").text("Error: Selected profile not found.").show();
                return;
            }
            
            delete settings.profiles[profileNameToDelete];
            
            settings.activeProfile = Object.keys(settings.profiles)[0];
            
            populateProfileDropdown();
            loadProfile(settings.activeProfile);
            
            $("#cs-status").text(`Deleted profile "${profileNameToDelete}".`);
            $("#cs-error").text("").hide();
            persistSettings();
        });

        $("#cs-reset").off('click.cs').on("click.cs", async () => { await manualReset(); });
        $("#cs-mapping-add").off('click.cs').on("click.cs", () => {
            const profile = getActiveProfile(settings);
            if (profile) {
                profile.mappings.push({ name: "", folder: "" });
                renderMappings(profile);
            }
        });
        $("#cs-mappings-tbody").off('click.cs', '.map-remove').on('click.cs', '.map-remove', function () {
            const profile = getActiveProfile(settings);
            if (profile) {
                const idx = parseInt($(this).closest('tr').attr('data-idx'), 10);
                if (!isNaN(idx)) {
                    profile.mappings.splice(idx, 1);
                    renderMappings(profile);
                }
            }
        });
        
        $(document).off('click.cs', '#cs-regex-test-button').on('click.cs', '#cs-regex-test-button', testRegexPattern);
    }
    tryWireUI();

    async function manualReset() {
        const profile = getActiveProfile(settings);
        const costumeArg = profile?.defaultCostume?.trim() ? `\\${profile.defaultCostume.trim()}` : '\\';
        const command = `/costume ${costumeArg}`;
        debugLog(settings, "Attempting manual reset with command:", command);
        try {
            await executeSlashCommandsOnChatInput(command);
            lastIssuedCostume = costumeArg;
            $("#cs-status").text(`Reset -> ${costumeArg}`);
            setTimeout(() => $("#cs-status").text("Ready"), 1500);
        } catch (err) { console.error(`[CostumeSwitch] Manual reset failed for "${costumeArg}".`, err); }
    }

    function getMappedCostume(name) {
        const profile = getActiveProfile(settings);
        if (!name || !profile) return null;
        for (const m of (profile.mappings || [])) {
            if (m?.name?.toLowerCase() === name.toLowerCase()) {
                return m.folder ? m.folder.trim() : null;
            }
        }
        return null;
    }

    async function issueCostumeForName(name, opts = {}) {
        const profile = getActiveProfile(settings);
        if (!name || !profile) return;
        const now = Date.now();
        name = normalizeCostumeName(name);
        const matchKind = opts.matchKind || null;
        const currentName = normalizeCostumeName(lastIssuedCostume || profile.defaultCostume || (ctx?.characters?.[ctx.characterId]?.name) || '');
        if (currentName && currentName.toLowerCase() === name.toLowerCase()) {
            debugLog(settings, "already using costume for", name, "- skipping switch.");
            return;
        }
        if (now - lastSwitchTimestamp < (profile.globalCooldownMs || PROFILE_DEFAULTS.globalCooldownMs)) {
            debugLog(settings, "global cooldown active, skipping switch to", name);
            return;
        }
        let argFolder = getMappedCostume(name) || name;
        const lastSuccess = lastTriggerTimes.get(argFolder) || 0;
        if (now - lastSuccess < (profile.perTriggerCooldownMs || PROFILE_DEFAULTS.perTriggerCooldownMs)) {
            debugLog(settings, "per-trigger cooldown active, skipping", argFolder);
            return;
        }
        const lastFailed = failedTriggerTimes.get(argFolder) || 0;
        if (now - lastFailed < (profile.failedTriggerCooldownMs || PROFILE_DEFAULTS.failedTriggerCooldownMs)) {
            debugLog(settings, "failed-trigger cooldown active, skipping", argFolder);
            return;
        }
        const command = `/costume \\${argFolder}`;
        debugLog(settings, "executing command:", command, "kind:", matchKind);
        try {
            await executeSlashCommandsOnChatInput(command);
            lastTriggerTimes.set(argFolder, now);
            lastIssuedCostume = argFolder;
            lastSwitchTimestamp = now;
            $("#cs-status").text(`Switched -> ${argFolder}`);
            setTimeout(() => $("#cs-status").text("Ready"), 1000);
        } catch (err) {
            failedTriggerTimes.set(argFolder, now);
            console.error(`[CostumeSwitch] Failed to execute /costume command for "${argFolder}".`, err);
        }
    }

    const streamEventName = event_types?.STREAM_TOKEN_RECEIVED || event_types?.SMOOTH_STREAM_TOKEN_RECEIVED || 'stream_token_received';

    _genStartHandler = (messageId) => {
        const bufKey = messageId != null ? `m${messageId}` : 'live';
        debugLog(settings, `Generation started for ${bufKey}, resetting state.`);
        perMessageStates.set(bufKey, { lastAcceptedName: null, lastAcceptedTs: 0, vetoed: false });
        perMessageBuffers.delete(bufKey);
    };

    _streamHandler = (...args) => {
        try {
            if (!settings.enabled) return;
            let tokenText = "", messageId = null;
            if (typeof args[0] === 'number') { messageId = args[0]; tokenText = String(args[1] ?? ""); } 
            else if (typeof args[0] === 'object') { tokenText = String(args[0].token ?? args[0].text ?? ""); messageId = args[0].messageId ?? args[1] ?? null; } 
            else { tokenText = String(args.join(' ') || ""); }
            if (!tokenText) return;

            const bufKey = messageId != null ? `m${messageId}` : 'live';
            if (!perMessageStates.has(bufKey)) { _genStartHandler(messageId); }
            const state = perMessageStates.get(bufKey);

            if (state.vetoed) return;

            const prev = perMessageBuffers.get(bufKey) || "";
            const normalizedToken = normalizeStreamText(tokenText);
            const combined = (prev + normalizedToken).slice(-(getActiveProfile(settings)?.maxBufferChars || PROFILE_DEFAULTS.maxBufferChars));
            perMessageBuffers.set(bufKey, combined);
            ensureBufferLimit();

            if (vetoRegex && vetoRegex.test(combined)) {
                debugLog(settings, "Veto phrase matched. Halting detection for this message.");
                state.vetoed = true;
                perMessageStates.set(bufKey, state);
                return;
            }

            const quoteRanges = getQuoteRanges(combined);
            const regexes = { speakerRegex, attributionRegex, actionRegex, vocativeRegex, nameRegex };
            const bestMatch = findBestMatch(combined, regexes, getActiveProfile(settings), quoteRanges);
            
            if (bestMatch) {
                const { name: matchedName, matchKind } = bestMatch;
                const now = Date.now();
                const suppressMs = Number(getActiveProfile(settings)?.repeatSuppressMs || PROFILE_DEFAULTS.repeatSuppressMs);
                if (state.lastAcceptedName?.toLowerCase() === matchedName.toLowerCase() && (now - state.lastAcceptedTs < suppressMs)) {
                    debugLog(settings, 'Suppressing repeat match for same name (flicker guard)', { matchedName });
                    return;
                }
                state.lastAcceptedName = matchedName;
                state.lastAcceptedTs = now;
                perMessageStates.set(bufKey, state);
                issueCostumeForName(matchedName, { matchKind, bufKey });
            }
        } catch (err) { console.error("CostumeSwitch stream handler error:", err); }
    };

    _genEndHandler = (messageId) => { if (messageId != null) { perMessageBuffers.delete(`m${messageId}`); perMessageStates.delete(`m${messageId}`); } };
    _msgRecvHandler = (messageId) => { if (messageId != null) { perMessageBuffers.delete(`m${messageId}`); perMessageStates.delete(`m${messageId}`); } };
    _chatChangedHandler = () => { perMessageBuffers.clear(); perMessageStates.clear(); lastIssuedCostume = null; lastTriggerTimes.clear(); failedTriggerTimes.clear(); };

    function unload() {
        try { if (eventSource) { eventSource.off?.(streamEventName, _streamHandler); eventSource.off?.(event_types.GENERATION_STARTED, _genStartHandler); eventSource.off?.(event_types.GENERATION_ENDED, _genEndHandler); eventSource.off?.(event_types.MESSAGE_RECEIVED, _msgRecvHandler); eventSource.off?.(event_types.CHAT_CHANGED, _chatChangedHandler); } } catch (e) {}
        perMessageBuffers.clear(); perMessageStates.clear(); lastIssuedCostume = null; lastTriggerTimes.clear(); failedTriggerTimes.clear();
    }

    try { unload(); } catch (e) {}
    try { eventSource.on(streamEventName, _streamHandler); eventSource.on(event_types.GENERATION_STARTED, _genStartHandler); eventSource.on(event_types.GENERATION_ENDED, _genEndHandler); eventSource.on(event_types.MESSAGE_RECEIVED, _msgRecvHandler); eventSource.on(event_types.CHAT_CHANGED, _chatChangedHandler); } catch (e) { console.error("CostumeSwitch: failed to attach event handlers:", e); }
    try { window[`__${extensionName}_unload`] = unload; } catch (e) {}
    console.log("SillyTavern-CostumeSwitch v1.1.0 loaded successfully.");
});

function getSettingsObj() {
    const ctx = typeof getContext === 'function' ? getContext() : (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null);
    let storeSource;
    if (ctx && ctx.extensionSettings) { storeSource = ctx.extensionSettings; }
    else if (typeof extension_settings !== 'undefined') { storeSource = extension_settings; }
    else { throw new Error("Can't find SillyTavern extension settings storage."); }

    // Migration for old settings format
    if (!storeSource[extensionName] || !storeSource[extensionName].profiles) {
        console.log("[CostumeSwitch] Migrating old settings to new profile format.");
        const oldSettings = storeSource[extensionName] || {};
        const newSettings = structuredClone(DEFAULTS);
        Object.keys(PROFILE_DEFAULTS).forEach(key => {
            if (oldSettings.hasOwnProperty(key)) {
                newSettings.profiles.Default[key] = oldSettings[key];
            }
        });
        if (oldSettings.hasOwnProperty('enabled')) {
            newSettings.enabled = oldSettings.enabled;
        }
        storeSource[extensionName] = newSettings;
    }
    
    // Ensure all default keys exist
    storeSource[extensionName] = Object.assign({}, structuredClone(DEFAULTS), storeSource[extensionName]);
    for (const profileName in storeSource[extensionName].profiles) {
        storeSource[extensionName].profiles[profileName] = Object.assign({}, structuredClone(PROFILE_DEFAULTS), storeSource[extensionName].profiles[profileName]);
    }
    
    return { store: storeSource, save: ctx?.saveSettingsDebounced || saveSettingsDebounced, ctx };
}
