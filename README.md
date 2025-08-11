# SillyTavern Costume Switcher Extension

The **SillyTavern Costume Switcher** extension was created to solve the problem of **showing multiple character expressions or images within a single character card chat**. This is especially useful for **narrator adventures** where a single character card (e.g., the narrator) needs to display different expressions or costumes without resorting to group chats. 

With this extension, you can **drop multiple character expressions** directly into the narrator's chat card, enhancing the storytelling experience without needing to manage multiple character cards.

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
- **Quick Replies** extension is required for **SillyTavern Costume Switcher** to work.

## Quick Replies Setup

The **SillyTavern Costume Switcher** extension **depends on the Quick Replies extension**, which comes pre-installed with SillyTavern. To ensure the Costume Switcher works correctly, you need to configure the Quick Replies extension and its settings properly.

### Enabling Quick Replies

1. Go to **SillyTavern's Extensions** page.
2. Enable the **Quick Replies** extension.

### Configuring Quick Replies

Quick Replies allows the Costume Switcher extension to interact with predefined replies and execute them when characters or costumes are detected. Here's how to set it up:

1. **Access Quick Replies Settings**: Open the **Quick Replies** settings from the **Extensions** page.
2. **Define Quick Reply Labels**: In Quick Replies, make sure you have a quick reply for each costume or character name you want to trigger. 
   
   - For example, if you have character names like `Char A`, `Char B`, `Char C`, you will need to create quick replies for these in the Quick Replies settings.

3. **Map Character Names to Quick Replies**: In the **SillyTavern Costume Switcher** settings, ensure you have set up mappings where each character name will correspond to the correct Quick Reply label.

### Example Configuration

Here are a few visual examples to help guide you through the configuration:

#### Quick Replies Setup in SillyTavern

<img width="689" height="481" alt="image" src="https://github.com/user-attachments/assets/a5f9ab40-af5b-4ea1-aa0b-1bdf085eb943" />

---
<img width="684" height="108" alt="image" src="https://github.com/user-attachments/assets/d0e1099d-93f2-4abc-875c-ddce47bf9c6d" />

---
<img width="2278" height="1221" alt="image" src="https://github.com/user-attachments/assets/e4886d5e-c653-4d4f-8d4a-8b3bffdcbbad" />





*This is how you want to setup Quick Replies for it to work with the extension*


## Support and Contributions

- **Support**: If you encounter any issues or need help using this extension, feel free to reach out via [GitHub Issues](https://github.com/your-repo/issues) or join the **SillyTavern community** on Discord.
  
- **Contributing**: Contributions are always welcome! If you’d like to improve this extension, please fork the repository, create a new branch, and submit a pull request. You can help by:
  - Adding new features.
  - Improving documentation.
  - Reporting bugs or suggesting new ideas.

## License

This extension is licensed under the **GNU General Public License v3.0**.

---
