# Background Badge Deleter for Roblox

An elegant, open-source instrument to effortlessly mass-delete unwanted Roblox badges from your inventory.

## Features
- **Mass Deletion:** Delete hundreds of badges with a single click.
- **Smart Targeting:** Filter your inventory by typing specific keywords.
- **Whitelist Protection:** Protect badges from deletion by typing a whitelist phrase.
- **Background Mode:** Click the "Pop Out Tab" button to run the deletion infinitely in the background while you play!

## Security
This extension is completely safe and open-source. It does not require any dangerous permissions, and it does not access or read your `.ROBLOSECURITY` cookie. All API calls are made securely through your active browser session.

## Installation
Available on the Chrome Web Store! (Link coming soon)

## Credits
- Developed by **Badger Dev**

## Support
If you find this tool useful, consider supporting the developer:
[Buy me a coffee on Ko-fi](https://ko-fi.com/badgerdev)

## 🛠️ For Developers & Contributors (Automated Deployment)

**Warning for mortals:** This repository uses a highly automated deployment pipeline. 
If you are contributing to this project and wish to build the cross-browser `.zip` files, simply ensure you have Node.js installed and run:

```bash
npm install
npm run build
```
This will automatically strip developer files, mutate the `manifest.json` for Firefox compatibility, and output both `ChromeBadgeDeleter.zip` and `FirefoxBadgeDeleter.zip` in the parent directory.

*Note: The `npm run deploy` command requires a configured `.env` file with Google and Mozilla API keys and is strictly for the repository owner.*
