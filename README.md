# Costume Switcher for SillyTavern

Costume Switcher is the companion piece to Lenny’s **Character Expressions** extension—it uses the same foundations, but instead of changing facial expressions it swaps the entire costume or avatar folder the moment a new speaker takes the spotlight. Install both and SillyTavern keeps the correct character in focus *and* their emotions in sync, giving you a live stage crew that reacts faster than you can type.

Under the hood the extension listens to streaming output from your model, scores every character mention it finds, and immediately updates the displayed costume to match the active speaker. It ships with powerful tooling, scene awareness, and a fully redesigned configuration UI so you can understand *why* a switch happened and tune the behaviour to fit any story.

> **New to Costume Switcher?** Start here, then hop over to the Character Expressions README. Together they form a best-friends duo: Expressions handles nuanced emotions, Costume Switcher handles wardrobe changes.

---

## Contents

1. [Highlights at a Glance](#highlights-at-a-glance)
2. [Requirements](#requirements)
3. [Installation](#installation)
4. [Architecture Overview](#architecture-overview)
5. [Custom Detection Engines](#custom-detection-engines)
    1. [Main Detection Engine (v3)](#main-detection-engine-v3)
    2. [Outfit Detection Engine (v1)](#outfit-detection-engine-v1)
6. [Getting Started in Five Minutes](#getting-started-in-five-minutes)
7. [Tour of the Settings UI](#tour-of-the-settings-ui)
    1. [Header & Master Toggle](#header--master-toggle)
    2. [Profiles](#profiles)
    3. [Character Patterns & Filters](#character-patterns--filters)
    4. [Presets & Focus](#presets--focus)
    5. [Detection Strategy](#detection-strategy)
    6. [Performance & Bias](#performance--bias)
    7. [Costume Mappings](#costume-mappings)
    8. [Outfit Lab](#outfit-lab)
        1. [Prepare your character folders](#1-prepare-your-character-folders)
        2. [Enable the lab in settings](#2-enable-the-lab-in-settings)
        3. [Add characters and defaults](#3-add-characters-and-defaults)
        4. [Build outfit variations](#4-build-outfit-variations)
        5. [Test and iterate safely](#5-test-and-iterate-safely)
        6. [Troubleshooting the Outfit Lab](#troubleshooting-the-outfit-lab)
        7. [Organizing multi-character cards](#organizing-multi-character-cards)
    9. [Live Pattern Tester](#live-pattern-tester)
    10. [Footer Controls](#footer-controls)
8. [Understanding Live Tester Reports](#understanding-live-tester-reports)
9. [Advanced Configuration Tips](#advanced-configuration-tips)
10. [Slash Commands](#slash-commands)
11. [Sharing Top Characters with Other Extensions](#sharing-top-characters-with-other-extensions)
12. [Troubleshooting Checklist](#troubleshooting-checklist)
13. [Support & Contributions](#support--contributions)

---

## Highlights at a Glance

- **Narrative-aware detection** – Attribution, action, vocative, possessive, pronoun, and general mention detectors can be mixed to match the format of your prose.
- **Custom engine lineage** – The fully bespoke detection stack (currently in its third major revision) fuses streaming analysis with explainable telemetry so you always know why a switch occurred.
- **Scene roster logic** – Track who is currently in the conversation and favour them during tight scoring races.
- **Modern profile workflow** – Save, duplicate, rename, and export complete configurations with a couple of clicks.
- **Performance tuning** – Adjust global, per-trigger, and failed-trigger cooldowns plus the maximum buffer size and processing cadence.
- **Live Pattern Tester** – Paste sample prose, inspect every detection, review switch decisions, and copy a rich report for debugging or support requests.
- **Slash command helpers** – Add, ignore, or map characters on the fly without leaving the chat window, and log mention stats for the last message.
- **Scene cast exports** – Surface the top detected characters as slash commands or prompt variables so other extensions can react instantly.

---

## Requirements

- **SillyTavern** v1.10.9 or newer (release or staging). Earlier builds may lack UI hooks required by the extension.
- **Streaming enabled** in your model or API connector. Costume Switcher listens to streaming tokens; without streaming no automatic switches will occur.
- **Browser permissions** to read and write extension settings (enabled by default in SillyTavern).

---

## Installation

1. Open **Settings → Extensions → Extension Manager** in SillyTavern.
2. Click **Install from URL** and paste the repository address:
   ```
   https://github.com/archkrrr/SillyTavern-CostumeSwitch
   ```
3. Press **Install**. SillyTavern downloads the extension and refreshes the page.
4. Enable **Costume Switcher** from the Extensions list if it is not activated automatically.

To update, return to the Extension Manager and click **Update all** or reinstall from the same URL.

---

## Architecture Overview

Costume Switcher combines a lightweight UI layer with a purpose-built streaming analysis pipeline so that avatar changes arrive in perfect sync with the narrative. Here is the life of a single message:

1. **Stream listener** – The extension hooks into SillyTavern’s streaming events and keeps a rolling buffer per message. Each incoming token is cleaned up (punctuation, fancy quotes, zero-width characters) and appended without ever blocking the UI.
2. **Profile compiler** – Your active profile is turned into a ready-to-run bundle of regex detectors, verb lists, cooldown rules, roster preferences, and outfit mappings. Switching profiles simply swaps this bundle out.
3. **Detection pass** – The main engine sweeps the buffer with detectors for speaker tags, attribution verbs, action verbs, vocatives, possessives, pronouns, and optional “general name” matches. It also honours veto phrases and skips ignored characters before any scoring happens.
4. **Scoring & context** – Every hit is scored using weighted priorities, distance from the end of the message, and the current scene roster. Bias settings and per-detector weights let you favour explicit dialogue tags or lean toward the freshest mention.
5. **Decision gate** – Cooldowns, repeat suppression, and manual focus locks are enforced in one place. If the candidate passes, the outfit resolver determines the correct folder (including outfit variants) and issues the `/costume` command.
6. **Telemetry** – The engine records matches, scores, roster membership, and skip reasons. The Live Pattern Tester, slash commands, and exported session data all pull from this shared telemetry, so you see exactly what the engine saw.

Because each stage is isolated, you can tweak detector settings without relearning the UI, and you can reason about switch decisions by following the same order the engine uses internally.

---

## Custom Detection Engines

Costume Switcher does not rely on third-party libraries for detection. Every matcher, bias rule, and cooldown is part of a fully custom detection stack purpose-built for SillyTavern roleplay. Both engines below share a common orchestration layer, yet each is tuned for a different job so you can mix expressive character work with razor-sharp costume swaps.

### Main Detection Engine (v3)

Version 3 of the primary detection engine powers all speaker attribution. It represents the third full rewrite of the pipeline and focuses on clarity for end users:

- **Detectors you can toggle** – Speaker tags, attribution verbs, action verbs, vocatives, possessives, pronouns, and general-name sweeps are all first-party detectors. Turn them on and off from the settings panel to mirror the way your story is written.
- **Smart pronoun linking** – The engine remembers the last confirmed subject so that pronoun hits can keep the same character in focus, even when a paragraph swaps from “Alice” to “she.”
- **Scene roster awareness** – Characters who were recently detected stay in a per-message roster with a configurable TTL. When the next decision comes up, roster members receive bonus weight so ensemble scenes stay stable.
- **Weighted scoring** – Every detector reports a priority. Those priorities are combined with distance-from-end penalties, your detection bias slider, and per-detector weight controls. The result is a transparent scorecard you can inspect in the Live Pattern Tester.
- **Cooldown & veto safety nets** – A single decision gate enforces the global cooldown, per-trigger cooldowns, repeat suppression, and veto phrases. Switches are skipped gracefully when a rule applies, and the skip reason is logged for review.
- **Explainer-first telemetry** – Matches, scores, roster membership, and skip reasons are stored alongside the final decision. Slash commands such as `/cs-stats` and `/cs-top` surface this telemetry directly in chat.

The v3 engine is deterministic by design: given the same buffer and settings it will make the same call every time. That makes testing simple and gives you confidence that profile tweaks translate directly to the behaviour you expect.

### Outfit Detection Engine (v1)

The outfit resolver is treated as its own detection engine because it layers additional rules on top of the main decision:

- **Mapping-first resolution** – Character names (and aliases) map to base costume folders. Each mapping can include one or more outfit variants with custom labels.
- **Trigger-driven variants** – Variants declare literal phrases or regex triggers. When a detection lands, the resolver evaluates those triggers against the full message buffer so outfits can react to mood, locations, or key phrases.
- **Match-kind filtering** – Variants can opt into specific match kinds (e.g., only on “action” detections). This keeps reaction outfits from firing on stray name drops.
- **Scene awareness predicates** – Variants can require certain characters to be present, require at least one of a set, or forbid specific characters. The engine reuses the scene roster from the main detector so outfits respond to who is actually in the conversation.
- **Cooldown-friendly caching** – Once a character ends up in a specific outfit, that choice is cached. Repeated detections of the same outfit are skipped until something actually changes, preventing needless `/costume` spam.
- **Readable decisions** – The Live Pattern Tester and status banner show why a variant was selected (trigger hit, awareness rule, fallback, etc.), so you can iterate on rules without guessing.

Outfit Detection Engine v1 is already powerful enough for mood-based wardrobe changes, yet it stays predictable by reusing the same telemetry and cooldown gates as the main engine.

---

## Getting Started in Five Minutes

1. **Enable the extension.** Expand the Costume Switcher drawer and toggle **Enable Costume Switching** on.
2. **List your characters.** Enter one name (or `/regex/`) per line inside **Active Characters**. Longer names should appear above abbreviations.
3. **Pick the core detectors.** Under **Detection Strategy**, enable **Detect Attribution**, **Detect Action**, and **Detect Pronoun** for narrative-style writing. Add **Scene Roster** if multiple characters speak in the same scene.
4. **Test a sample.** Paste a recent reply into the **Live Pattern Tester** and click **Test Pattern**. Review the detections to confirm the correct costume is chosen.
5. **Save the profile.** Use the **Save** button in the Profiles card to store the configuration for future sessions.

That’s it—you can now focus on storytelling while the avatars keep up automatically.

---

## Tour of the Settings UI

### Header & Master Toggle
The hero header summarises what the extension does and houses the **Enable Costume Switching** toggle. Turn it off temporarily to pause detection without losing any settings.

### Profiles
Create tailored setups for different stories or formats:
- **Select** swaps between saved profiles.
- **Save** writes changes back to the currently selected profile.
- **Save As** copies the active profile under a new name typed in the field.
- **Rename** updates the active profile’s name to the text input value.
- **New (Defaults)** starts from the built-in defaults; **Duplicate Current** clones the active profile first.
- **Delete**, **Import**, and **Export** round out the lifecycle so you can archive and share JSON profiles.

### Character Patterns & Filters
Teach the detector which names to recognise:
- **Active Characters** accepts plain names or `/regex/` entries—one per line.
- **Ignored Characters** suppresses specific matches without removing them from the character list.
- **Veto Phrases** stops detection entirely for a message when the phrase or regex is found (useful for OOC tags).

### Presets & Focus
Kickstart new profiles with curated presets, configure a **Default Costume** to fall back to, and optionally engage **Manual Focus Lock** to pin the avatar to a specific character until you unlock it.

### Detection Strategy
Toggle the individual detectors the engine can use. Tooltips in the UI explain the common scenarios for each detection type. Enable **Scene Roster** to maintain a rolling list of characters active in the conversation and adjust the **Scene Roster TTL (messages)** to control how long they stay on that list.

### Performance & Bias
Fine-tune responsiveness and tie-breaking behaviour:
- **Global Cooldown (ms)** – Minimum time between any two costume changes.
- **Repeat Suppression (ms)** – Minimum time before the same character can switch again.
- **Per-Trigger Cooldown (ms)** – Delay before the same detection type (e.g., action) can trigger again.
- **Failed Trigger Cooldown (ms)** – Backoff applied after a switch attempt is rejected.
- **Max Buffer Size (chars)** – Hard cap on how much of the recent stream is analysed.
- **Token Process Threshold (chars)** – Number of characters that must arrive before the buffer is rescored.
- **Detection Bias** – Slider balancing match priority versus recency; positive numbers favour dialogue/action tags, negative values favour the latest mention.

### Costume Mappings
Map any detected name or alias to a specific costume folder. Use **Add Mapping** to append rows, then fill in the character and destination folder names.

### Outfit Lab
The Outfit Lab is an experimental workspace for staging wardrobe variants without destabilising your live mappings. Variants saved here run in the detection engine as soon as **Enable Experimental Outfits** is toggled on for the active profile.

#### 1. Prepare your character folders
Keep your prototypes in an `Outfit Lab` subdirectory under the character’s main folder. Each outfit variant receives its own subfolder, and every variant should reuse the same expression filenames as the parent directory so expression lookups remain valid.

```
SillyTavern/data/default-user/characters/Mythic Frontier/
└── Ranger Elowen/
    ├── portrait.png
    ├── determined.png
    ├── surprised.png
    └── Outfit Lab/
        ├── Emberwatch Patrol/
        │   ├── portrait.png
        │   ├── determined.png
        │   └── surprised.png
        └── Midnight Vanguard/
            ├── portrait.png
            ├── determined.png
            └── surprised.png
```

- Use folders like `Mythic Frontier/Ranger Elowen/Outfit Lab/Emberwatch Patrol` when pointing variant mappings at prototypes. Promoting a look is as simple as moving its folder up beside the main art and updating the mapping.
- Each variant inherits the base outfit’s expression manifest. Missing files fall back to whatever PNGs exist in the variant directory; anything absent simply cannot render. Drop at least a `portrait.png` in every folder so fallbacks always have artwork.
- Store shared assets (e.g., accessories or props) alongside the variant art if you reference them directly. SillyTavern only serves files that live inside the selected outfit directory.

#### 2. Enable the lab in settings
Open **Settings → Extensions → Costume Switcher → Outfits (Preview)**. The editor stays read-only until you flip **Enable Experimental Outfits** on. Once enabled you can add, edit, or remove variants; turning it back off preserves the data but keeps the profile on its default folders.

#### 3. Add characters and defaults
Use **Add Character Slot** to create a card per character you want to experiment with. Fill in:

- **Character Name** – the detected name or alias that should trigger the outfit.
- **Default Folder** – the production-ready costume directory. Variants fall back here when no triggers match.

These values sync with the main **Costume Mappings** table, so characters you configure in the lab are also available to the standard mapping workflow.

#### 4. Build outfit variations
Inside each card, click **Add Outfit Variation** to define experimental looks:

- **Label (optional)** – Friendly display name for the Live Tester and debug logs.
- **Folder** – Path to the prototype outfit. Use the directory picker or paste the relative path shown in your SillyTavern character tree.
- **Triggers** – One literal or `/regex/` pattern per line. Variants with no triggers act as always-on fallbacks after earlier variants fail.
- **Match Types** – Limit the variant to specific detection sources. Options include `Speaker`, `Attribution`, `Action`, `Pronoun`, `Vocative`, `Possessive`, and `General Name`. Leave all unchecked to accept every match.
- **Scene Awareness** – Require or exclude characters from the active scene roster. Fill in **Requires all of…**, **Requires any of…**, or **Exclude when present** (one name per line). The roster is case-insensitive and only populated when the **Scene Roster** detector is enabled in **Detection Strategy**.

Variants evaluate in order from top to bottom. The first entry whose folder exists, whose match type (if any) aligns with the detection event, whose triggers match the streaming text, and whose scene-awareness rules pass becomes the active outfit. Everything else falls back to the card’s default folder.

#### 5. Test and iterate safely
- Use the **Live Pattern Tester** with the lab enabled to verify which variant would win given sample prose. Trigger matches and awareness reasons appear in the report.
- When a variant is ready for production, disable the lab, move the folder out of `Outfit Lab`, and update the default mapping, or leave the lab on to keep routing live traffic through the variants.
- Profiles store their lab configuration alongside mappings. Exporting a profile JSON carries the variants with it for backups or sharing.

#### Troubleshooting the Outfit Lab
- **Variant never fires** – Confirm the variant folder path is relative to your `characters/` directory and spelled exactly like the filesystem entry. Remember variants run sequentially; drag the card handles to reorder if a broader variant is catching the trigger first.
- **Scene rules never pass** – Enable **Scene Roster** under **Detection Strategy** and keep the TTL high enough for characters to remain “active.” Names are normalised to lowercase; match the roster spelling (e.g., `captain ardan`).
- **Missing expressions** – Copy the full expression set into each variant directory. Because the manifest is shared, only files that physically exist in the selected folder can render.
- **Editor looks disabled** – The lab requires **Enable Experimental Outfits** to be on. When off, the UI intentionally locks to prevent accidental edits during live sessions.
- **Profile reset lost variants** – Variants live inside the active profile. Save the profile after edits and export periodic backups via the Profiles card.

#### Organizing multi-character cards

Multi-character cards treat the parent directory as the shared biography. Create a child folder for every persona and point each mapping to that nested path. Costume Switcher resolves slash-delimited paths relative to your `characters/` root, so tidy folder names translate directly into mappings.

**Example: Deep-space crew**

```
SillyTavern/data/default-user/characters/Starship Polaris/
├── Captain Aris/
├── Engineer Sol/
└── Diplomat Lyra/
```

Map the characters to `Starship Polaris/Captain Aris`, `Starship Polaris/Engineer Sol`, and `Starship Polaris/Diplomat Lyra`. Each subfolder can contain its own portrait variants, background art, or expression packs without leaking into the others.

**Example: Academy roommates**

```
SillyTavern/data/default-user/characters/Frostglen Dorm/
├── Ember Hart/
├── Quinn Vale/
└── Mira Snow/
```

If Ember occasionally switches into a winter outfit, add another directory—`Frostglen Dorm/Ember Hart/Winter Gala/`—and point an outfit variant at that path. The base mapping still targets `Frostglen Dorm/Ember Hart`, while the variant appends the extra folder when its trigger (e.g., "snowstorm" or a `/winter/i` regex) fires.

**Example: Band with stage personas**

```
SillyTavern/data/default-user/characters/Neon Skyline/
├── Lead Echo/
├── Bass Nova/
└── Drummer Pulse/
```

Use `Neon Skyline/Lead Echo`, `Neon Skyline/Bass Nova`, and `Neon Skyline/Drummer Pulse` as the core mappings. When the group performs an acoustic set, you can swap all three at once by preparing alternate folders such as `Neon Skyline/Lead Echo/Unplugged/` and invoking the `/cs-map` slash command to temporarily reroute the mappings.

Keep folder names readable—those exact strings show up in the UI and make debugging easier when reviewing switch telemetry.


### Live Pattern Tester
Paste sample prose and inspect:
- **All Detections** – Every match in order with its type and priority.
- **Live Switch Decisions** – Real-time simulation showing switches, skips, scores, and veto events.
- **Top Characters** – A live summary of the best scoring speakers pulled from the same logic driving the stream.
- **Copy Report** – Generates an extensive plain-text report containing summaries, skip breakdowns, switch stats, final state details, and key settings so you can share diagnostics quickly.

### Footer Controls
Use **Save Current Profile** as a one-click commit for any edits and **Manual Reset** to snap back to your default costume or main avatar. Status and error banners let you know when actions succeed or if validation fails.

---

## Understanding Live Tester Reports
Every report copied from the tester includes:
- **Input metadata** – Profile name, timestamps, original/processed length, and veto status.
- **Detection log** – List of every detection with match type, character index, and priority.
- **Switch timeline** – Each decision, including score, detection kind, and why switches were skipped.
- **Detection summary** – Aggregated counts per character, highest priority hit, and the range of positions that matched.
- **Switch summary** – Total and unique costumes, the last switch, and the top scoring triggers.
- **Skip reasons** – Counts of why detections were ignored (cooldowns, existing costume, veto, etc.).
- **Final stream state** – Scene roster contents, last accepted name, last subject, processed length, and simulated duration.
- **Top characters** – Ranking of the four strongest contenders including mention counts, roster status, and weighted scores.
- **Key settings snapshot** – Cooldowns, thresholds, roster flag, and bias value in effect during the test.
Attach these reports when filing bug reports or asking for tuning advice—everything needed to reproduce the issue is included.

---

## Advanced Configuration Tips
- **Tune the buffer** when working with long-form prose. Reduce **Max Buffer Size** to keep focus on the latest paragraphs or increase it to catch callbacks to earlier exposition.
- **Combine cooldowns** to eliminate flicker. A short global cooldown paired with per-trigger cooldowns stops rapid-fire switches without muting genuinely new speakers.
- **Scene roster** excels in multi-character RP. Keep the TTL close to the number of alternating speakers to maintain context without dragging in old participants.
- **Custom verb lists** (Attribution/Action) help the detectors understand bespoke writing styles. Add uncommon dialogue tags or narrative verbs as needed.

---

## Slash Commands
All commands are session-scoped—they modify the active profile until you reload the page.

| Command | Description |
| --- | --- |
| `/cs-addchar <name>` | Appends a character or regex to the profile’s patterns list and recompiles detections. |
| `/cs-ignore <name>` | Adds a character or regex to the ignore list for the current session. |
| `/cs-map <alias> to <folder>` | Creates a temporary mapping from `alias` to the specified costume folder. |
| `/cs-stats` | Logs a breakdown of detected character mentions for the most recent AI message to the browser console. |
| `/cs-top [count]` | Returns a comma-separated list of the top detected characters from the last AI message and logs the result to the browser console. Accepts `1`–`4`; defaults to four names. |
| `/cs-top1` – `/cs-top4` | Shortcuts for pulling exactly the top 1–4 characters without specifying an argument. |

---

## Sharing Top Characters with Other Extensions
After each AI message finishes streaming, Costume Switcher ranks every detected character and exposes the results in two convenient ways:

- **Prompt variables** – The latest data lives under `extensions.SillyTavern-CostumeSwitch-Testing.session` in SillyTavern templates.
  - `topCharactersString` provides a ready-to-use comma-separated list (ideal for Group Expressions).
  - `topCharacters` (array) and `topCharacterDetails` (objects with `name`, `count`, `score`, and `inSceneRoster`) offer structured access for advanced prompts.
- **Slash commands** – Use `/cs-top [count]` or the `/cs-top1` … `/cs-top4` shortcuts inside chat inputs, macros, or automations to inject the ranked list on demand.

Because these exports are refreshed on every message, you can wire them directly into Lenny’s **Group Expressions** extension or any other automation that needs to know who dominated the scene without burdening the model with extra thinking instructions.

---

## Troubleshooting Checklist
1. **No switches happen:** verify streaming is enabled, the master toggle is on, at least one detection method is selected, and the characters appear in the patterns list exactly as they do in the story.
2. **The wrong character is chosen:** run the Live Pattern Tester, read the skip reasons, and adjust Detection Bias or enable Scene Roster to give dialogue tags more weight.
3. **Switches flicker between characters:** raise the global cooldown, tweak per-trigger cooldowns, or disable **Detect General Mentions** for subtle references.
4. **Reports show a veto:** check the Veto Phrases list to confirm the text did not match an OOC filter.
5. **Profiles do not persist:** ensure you click **Save** after editing and confirm the SillyTavern browser tab has permission to write local storage.

---

## Support & Contributions
Issues and pull requests are welcome. When reporting a problem, include:
- The copied Live Pattern Tester report (using **Copy Report**).
- Your SillyTavern build number and API provider.
- Any custom detector, cooldown, or buffer settings that differ from defaults.

This information helps others reproduce the behaviour quickly and suggest accurate fixes or tuning advice.
