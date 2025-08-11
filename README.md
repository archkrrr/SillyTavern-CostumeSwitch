# SillyTavern Costume Switcher Extension

The **SillyTavern Costume Switcher** extension allows users to automatically switch costumes for characters based on names detected in the AI’s responses. This extension solves the issue of having to manually change costumes whenever a new character speaks in the conversation, enhancing the experience with automatic costume management based on streamed text.

## Features

- **Real-time Costume Switching**: Automatically switches costumes as the AI generates responses based on detected character names.
- **Custom Character Patterns**: You can define character names to trigger costume changes.
- **Default Costume Reset**: Automatically reverts to a default costume if no character is detected within a specified timeout.
- **Cooldown Management**: Avoids rapid costume switches by adding global and repeat suppression cooldowns.
- **Debug Logging**: Enables detailed logging to help troubleshoot any issues with costume switching.

## Installation and Usage

### Installation

1. Open **SillyTavern** and go to the **Extensions** page.
2. Use **SillyTavern's inbuilt extension installer** to install the extension.
3. If installing manually, download the extension's files and place them into the `scripts/extensions/` folder of SillyTavern.

### Usage

1. Go to the **SillyTavern Extensions** page and enable the **Costume Switcher** extension.
2. In the extension settings, define the character names you want the extension to listen for. For example: `Char A`, `Char B`, `Char C`, `Char D`.
3. Set your **default costume** that will be applied when no character name is detected in the conversation.
4. Optionally, adjust the **timeout** before the costume resets, the **global cooldown** between costume switches, and **repeat suppression** to avoid rapid costume changes.
5. When a character name from your list is detected, the extension will automatically switch to the corresponding costume.
6. Use the **Manual Reset** button to reset the costume back to default at any time.

## Prerequisites

- **SillyTavern** version: `1.13.2` or higher is required for compatibility with the extension.

## Support and Contributions

- **Support**: If you encounter any issues or need help using this extension, feel free to reach out via [GitHub Issues](https://github.com/your-repo/issues) or join the **SillyTavern community** on Discord.
  
- **Contributing**: Contributions are always welcome! If you’d like to improve this extension, please fork the repository, create a new branch, and submit a pull request. You can help by:
  - Adding new features.
  - Improving documentation.
  - Reporting bugs or suggesting new ideas.

## License

This extension is licensed under the **GNU General Public License v3.0**.

---

