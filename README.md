# SillyTavern Costume Switcher Extension

The SillyTavern Costume Switcher extension was created to solve the problem of showing multiple character expressions or images within a single character card chat. This is especially useful for narrator adventures where a single character card (e.g., the narrator) needs to display different expressions or costumes without resorting to group chats.

With this extension, you can drop multiple character expressions directly into the narrator's chat card, enhancing the storytelling experience without needing to manage multiple character cards.
Features

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

-  SillyTavern version: 1.13.2 or higher.

-  Quick Replies extension must be enabled.

## Setup and Usage

**Step 1:** Configure Quick Replies

This extension relies on Quick Replies to function. You must create a Quick Reply for each character you want to switch to.

  Go to the Quick Replies settings in the Extensions panel.

  Create a new Quick Reply for each character.

  Label: This should be the character's name (e.g., Char A).

  Message: This should be the command to change the costume (e.g., /costume (Whatever your directors char card is)/Char A).

<img width="674" height="106" alt="image" src="https://github.com/user-attachments/assets/ab177c47-ff04-40b2-af22-c3a51dcd4822" />

I have all my costume folders inside my main character card, so that's why I put Dan Da Dan/Char A.

<img width="2278" height="1221" alt="image" src="https://github.com/user-attachments/assets/e4886d5e-c653-4d4f-8d4a-8b3bffdcbbad" />

*This is how you want to setup Quick Replies for it to work with the extension.*

**Step 2:** Configure the Costume Switcher

Now, go to the Costume Switcher settings.

  Enable Costume Switch: Check this box to turn the extension on.

  Character Patterns: Enter the names of the characters you want the extension to look for. Each name must be on a new line. These names should match the Labels you set in Quick Replies.

  Default Costume: Set a default costume to revert to when no character is detected.

  Detection Methods: This is the most important part. You can choose how the extension finds names.

  For the highest accuracy (recommended): Uncheck all the boxes in this section. The extension will then only switch when it sees a direct speaker tag, like Char A:.

  *For more flexibility: You can enable other methods, like detecting when a character performs an action (Char A leaned forward) or when they are mentioned in dialogue. Be aware that enabling more methods, especially "General Mentions," can lead to incorrect switches.*

<img width="694" height="597" alt="image" src="https://github.com/user-attachments/assets/4318ac06-3e60-492c-9ab7-fc87fc86f7e2" />

*Here, you can see how the Costume Switcher settings match the Quick Reply labels. The character names like Char A, Char B, etc., are mapped to specific costumes.*
