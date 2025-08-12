# SillyTavern Costume Switcher Extension

The SillyTavern Costume Switcher extension was created to solve the problem of showing multiple character expressions or images within a single character card chat. This is especially useful for narrator adventures where a single character card (e.g., the narrator) needs to display different expressions or costumes without resorting to group chats.

With this extension, you can drop multiple character expressions directly into the narrator's chat card, enhancing the storytelling experience without needing to manage multiple character cards.

## Features

-    Real-time Costume Switching: Automatically switches costumes as the AI generates responses based on detected character names.

-    Flexible Detection Methods: You can toggle different ways the extension finds names—from precise speaker tags (Name:) to general mentions.

-    Custom Character Patterns: Define the specific character names you want the extension to listen for.

-    Default Costume Reset: Automatically reverts to a default costume if no character is detected within a specified timeout.

-    Cooldown Management: Avoids rapid, flickering costume switches with adjustable cooldowns.

-    Debug Logging: Enables detailed logging to help troubleshoot any issues.

## Installation

-    Open SillyTavern and go to the Extensions page.

-    Use SillyTavern's inbuilt extension installer to install the extension.

  *installing manually, download the extension's files and place them into the scripts/extensions/third-party/SillyTavern-CostumeSwitch folder.*

## Prerequisites
SillyTavern version: 1.13.2 or higher.


## Setup and Usage

### Step 1: Configure the Costume Switcher

- First, go to the Costume Switcher settings.

- Enable Costume Switch: Check this box to turn the extension on.

- Character Patterns: Enter the names of the characters you want the extension to look for. Each name must be on a new line.

- Default Costume: Set a default costume to revert to when no character is detected.

- Detection Methods: This is the most important part. You can choose how the extension finds names.

*For the highest accuracy (recommended): Uncheck all the boxes in this section. The extension will then only switch when it sees a direct speaker tag, like Char A:.*

For more flexibility: You can enable other methods, like detecting when a character performs an action (e.g., “Char A leaned forward”) or when they are mentioned in dialogue. Be aware that enabling more methods, especially "General Mentions," can lead to incorrect switches.

## Costume Switcher Settings Example:

<img width="696" height="1114" alt="image" src="https://github.com/user-attachments/assets/c14d1f39-25de-457e-82d4-369661b3ea84" />
