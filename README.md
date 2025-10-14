# Costume Switcher for SillyTavern

**Costume Switcher** is a powerful extension for SillyTavern that brings your multi-character scenes to life. It intelligently and automatically changes the displayed character avatar in real-time as the AI generates its response, creating a dynamic, narrative-driven experience.

Instead of being limited to a single character avatar, Costume Switcher analyzes the story as it's written and ensures the correct character is always on-screen, making it perfect for single-card narrator or ensemble cast roleplays.

## Table of Contents

-   [How It Works](#how-it-works)
-   [Key Features](#key-features)
-   [Disclaimer](#disclaimer)
-   [Prerequisites](#prerequisites)
-   [Installation](#installation)
-   [Quick Start Guide](#quick-start-guide)
-   [Detailed Feature Guide](#detailed-feature-guide)
-   [Complete Guide to Settings](#complete-guide-to-settings)
-   [Tips & Best Practices](#tips--best-practices)
-   [Recommended Extensions](#recommended-extensions)
-   [Troubleshooting](#troubleshooting)


## How It Works

At its core, Costume Switcher simulates reading a story as it's being written. As the AI generates a response token by token, the extension maintains a buffer of the recent text. With every new word, it re-evaluates the entire buffer and runs a sophisticated analysis to determine the most likely active character.

This analysis scores every potential character mention based on two key factors:

1.  **Priority:** *How* was the character mentioned? A direct dialogue tag (e.g., `"Hello," she said.`) has a much higher priority than a passing name drop.
2.  **Recency:** *When* was the character mentioned? A name that appeared more recently has a higher chance of being the active character.

The **Detection Bias** slider in the settings lets you fine-tune the balance between these two factors. The "winner" of this constant evaluation becomes the active costume. This process happens dozens of times per second, ensuring the avatar is always in sync with the story.

## Key Features

* **Intelligent Narrative Detection:** The core of the extension. It doesn't just look for simple `Name:` tags; it understands the flow and context of a story.
* **Scene Awareness:** An optional mode that dramatically improves accuracy in scenes with multiple characters by maintaining a "roster" of recently active participants.
* **On-the-Fly Slash Commands:** Manage your character list without ever leaving the chat for quick additions or adjustments.
* **Advanced Profile Management:** Create, save, and switch between different configurations for various scenarios. Import and export profiles to share your setups.
* **Live Pattern Tester:** An indispensable tool to test your settings in real-time and understand the engine's logic.
* **Performance Tuning:** Fine-tune cooldowns and thresholds to match your preferences and system performance.
* **Costume Mapping:** Map multiple names or regular expressions to a single costume folder.

## Disclaimer

Please keep in mind that this extension is a personal project developed by a college freshman, not a large, professional development team.

The core of this tool is a detection engine that tries its best to figure out which character is speaking or acting at any given moment. It's important to know that **this is not an AI**; it's a much simpler system that works by matching text patterns (using Regular Expressions) and applying context clues. While it can be quite accurate, **it is not perfect!**

In scenes with complex grammar, ambiguous phrasing, or unconventional narrative styles, the engine might occasionally get confused or select the wrong character. That's why the advanced settings are so important! You are encouraged to use features like **Veto Phrases**, **Ignored Characters**, and the **Live Pattern Tester** to fine-tune the detection for your specific needs.

Think of it as a helpful assistant, not an infallible AI. Your patience and feedback are greatly appreciated!


## Prerequisites

* **SillyTavern Version:** It is recommended to use the **latest version** of SillyTavern (either Release or Staging).
* **Streaming must be enabled:** This extension relies on analyzing the AI's response as it's being generated. You **must** have streaming enabled in your chosen API's settings for it to function.

## Installation

1.  **Install Costume Switcher**: In the **SillyTavern Extension Manager**, use "Install from URL" and paste the following Git URL:
    ```
    https://github.com/archkrrr/SillyTavern-CostumeSwitch
    ```

## Quick Start Guide

For the best experience right out of the box, follow this simple setup guide.

1.  **Add Your Characters:** Go to the settings and list all character names in the **Character Patterns** box, one per line.
2.  **Configure Detection:** Scroll down to **Detection Methods** and enable the following for the most accurate, narrative-driven experience:
    * `[x] Detect Attribution`
    * `[x] Detect Action`
    * `[x] Detect Pronoun`
3.  **Improve Multi-Character Accuracy (If Needed):** If your scenes frequently involve 3+ characters, also enable:
    * `[x] Enable Scene Roster`
4.  **Save Profile:** Give your configuration a name at the top and click **Save**. You're ready to go!

---

## Detailed Feature Guide

### Intelligent Narrative Detection

This is the engine of the extension. By enabling different methods, you can control how deeply it reads the story.

* **Detect Speaker (`Name: Dialogue`)**
    * **What it is:** The most basic and accurate method. It looks for a character's name at the beginning of a line, followed by a colon. This is enabled by default and cannot be turned off.
    * **Example:** `Arthur: "I'll be there in a moment."` -> Switches to `Arthur`.

* **Detect Attribution**
    * **What it is:** Detects the speaker from dialogue tags that appear *after* a line of dialogue. Essential for novel-style writing.
    * **Example:** `"I'll be there in a moment," Arthur said.` -> Switches to `Arthur`.

* **Detect Action**
    * **What it is:** Detects the active character when they perform an action, especially at the start of a paragraph.
    * **Example:** `Arthur nodded and walked towards the door.` -> Switches to `Arthur`.

* **Detect Pronoun**
    * **What it is:** A powerful feature that tracks the last explicitly named character. It then attributes subsequent actions by pronouns (he, she, they) to that character, ensuring their avatar remains active even when their name isn't used.
    * **Example:** `Arthur entered the room. He looked around and sighed.` -> Switches to `Arthur` on the first sentence and *stays on* `Arthur` for the second.

* **Detect Vocative**
    * **What it is:** Detects when a character is spoken *to* within dialogue. Can be useful but may sometimes cause incorrect switches if you only want the speaker to be active.
    * **Example:** `"What do you think we should do, Arthur?" she asked.` -> Switches to `Arthur`.

* **Detect Possessive**
    * **What it is:** Detects when a character's possessive form is used.
    * **Example:** `Her eyes widened in surprise.` -> This is a weaker detection and may not always trigger a switch unless no better match is found. However, `Merlin's eyes widened...` will correctly switch to `Merlin`.

* **Detect General Mentions**
    * **What it is:** The broadest and most dangerous method. It will trigger a switch any time a character's name is mentioned anywhere. Use with caution, as it can lead to flickering.
    * **Example:** `He thought about Arthur's plan.` -> Switches to `Arthur`.

### Scene Awareness (Scene Roster)

This feature is designed to fix the most common problem in complex, multi-character scenes: an old character mention causing an incorrect switch.

When enabled, the extension maintains a temporary "roster" of characters who have been mentioned recently. The `Scene Roster TTL (messages)` setting determines how many messages a character stays on the roster without being mentioned before they are dropped. The detection engine will then *strongly* prioritize characters on this roster, improving accuracy in active conversations with many participants.

### On-the-Fly Slash Commands

These commands allow you to make quick adjustments to the extension's behavior directly from the chat input box. These changes are temporary and will be reset on a page refresh.

* `/cs-addchar [Character Name]`
    * Adds a new character to the list of patterns for the current session.
    * **Example:** `/cs-addchar Lancelot`

* `/cs-ignore [Character Name]`
    * Temporarily stops the extension from detecting a specific character.
    * **Example:** `/cs-ignore Merlin`

* `/cs-map [Name] to [Costume Folder]`
    * Creates a temporary mapping from a detected name to a specific costume folder.
    * **Example:** `/cs-map The King to Arthur`

### Profile Management

The profile system allows you to save and load entire configurations. This is perfect for switching between different stories, character groups, or detection styles without having to manually re-enter settings every time. You can import and export profiles as `.json` files to back them up or share them.

### Live Pattern Tester

This is your primary diagnostic tool. Paste any block of text into the tester and click "Test Pattern" to see how the engine analyzes it with your current settings.

* **All Detections:** Shows every single time a character pattern was found, in the order they appear in the text.
* **Winning Detections:** Simulates the real-time process, showing a log of every time the "winning" character changed as the message was being "written." This helps you understand why the final avatar was chosen.

## Complete Guide to Settings

-   **Profiles:**
    -   **Dropdown:** Select a saved profile to load it.
    -   **Delete:** Deletes the currently selected profile.
    -   **Text Input / Save:** Type a new name to create a new profile, or use an existing name to overwrite and save changes to the current profile.
    -   **Import / Export:** Save your profile to a file or load one from your computer.

-   **Manual Focus Lock:** Force the costume to a specific character, disabling all automatic detection until you click "Unlock".

-   **Enable Costume Switch:** The master on/off switch for the entire extension.

-   **Character Patterns:** The list of names or `/regex/` patterns the extension will look for. One pattern per line.

-   **Default Costume:** The costume folder to use when no character is detected. Leave blank to use the main character card's avatar.

-   **Ignored Characters:** Any pattern on this list will be completely ignored by the detection engine.

-   **Veto Phrases:** If any phrase or `/regex/` on this list is found anywhere in the message, the extension will stop all detection for that message entirely. Perfect for ignoring OOC comments.

-   **Detection Methods:** See the [Detailed Feature Guide](#detailed-feature-guide) above for a full explanation of each method.

-   **Enable Scene Roster:** Toggles the Scene Awareness feature for scenes with many characters.
    -   **Scene Roster TTL (messages):** Sets how many messages a character remains "active" in the scene before being dropped from the priority roster.

-   **Attribution / Action Verbs:** Comma-separated lists of verbs used by the "Detect Attribution" and "Detect Action" methods. You can add or remove verbs to fine-tune detection.

-   **Performance Tuning:**
    -   **Global Cooldown (ms):** The minimum time (in milliseconds) that must pass between *any* two costume switches. Prevents flickering.
    -   **Repeat Suppression (ms):** The minimum time before the *same* character can trigger another switch.
    -   **Token Process Threshold (chars):** How many characters the extension waits before re-evaluating the text. Lower values are more reactive but use more CPU.
    -   **Detection Bias:** The slider that balances Priority vs. Recency.
        -   **Positive values (+):** Favor high-priority matches (dialogue/action tags) even if they appeared earlier in the text.
        -   **Negative values (-):** Favor the most recently mentioned character, even if it was a lower-priority mention.

-   **Costume Mappings:** Map a detected name (left column) to a specific costume folder name (right column).

-   **Debug Logging:** Check this to print detailed decision-making logs to the browser's developer console (F12) for advanced troubleshooting.

## Tips & Best Practices

-   **Order Your Patterns:** When listing names in Character Patterns, always list longer names before shorter names that are part of them (e.g., list 'Bartholomew' before 'Bart').
-   **Use the Live Tester:** Before asking for help, paste your text into the Live Pattern Tester. It will often show you exactly why a switch did or didn't happen. It's also the best way to test and perfect your regular expressions.
-   **Start with Recommended Settings:** For most novel-style roleplays, the recommended detection settings (`Attribution`, `Action`, `Pronoun`) provide the best balance of accuracy and performance. Only enable other methods if you have a specific need.
-   **Turn off "Request model reasoning":** If you are using a model that supports a "thinking" or "reasoning" phase, it is highly recommended to **disable** the "Request model reasoning" option in SillyTavern's settings. The model's internal thoughts may contain character names that will cause the extension to switch costumes prematurely before the actual response is written.
-   **Be Wary of "General Mentions":** This detection method is powerful but can easily cause incorrect switches in complex sentences. Only use it if you understand its behavior.

## Recommended Extensions

These extensions work well alongside Costume Switcher to enhance your storytelling experience.

* **[Moonlit Echoes Theme]**: A really good theme extension that improves your roleplay experience, and makes this extensions settings page look better.
    ```
    https://github.com/RivelleDays/SillyTavern-MoonlitEchoesTheme
    ```
* **[Extension Name Placeholder]**: A brief description of what this extension does and why it's a good companion.
    * [GitHub Link Placeholder]

## Troubleshooting

-   **Switches aren't happening at all:**
    1.  **Is Streaming enabled in your API settings?** This is the most common issue. The extension requires streaming to work.
    2.  Is "Enable Costume Switch" checked in the extension settings?
    3.  Are your character names spelled correctly in "Character Patterns"?
    4.  Is at least one "Detection Method" enabled?
    5.  Could a "Veto Phrase" be present in the message?

-   **The wrong character is being selected:**
    1.  Paste the full message into the "Live Pattern Tester" to see the engine's logic.
    2.  Try adjusting the "Detection Bias" slider. A more positive bias will help if older dialogue tags are being ignored in favor of recent name drops.
    3.  For scenes with many active characters, enable the "Scene Roster".
    4.  Check if an overly broad detection method like "General Mentions" is enabled.
