# Base64 Image Cleaner

![Demo](demo.gif)

An Obsidian plugin that finds inline base64-embedded images in the current note and either replaces them with placeholder text or deletes them entirely.

Matches any markdown image whose source is a `data:image/...;base64,...` URI:

```
!\[(.*?)\]\(data:image\/[a-z]+;base64,[a-zA-Z0-9+\/]+={0,2}\)
```

## Install

### Via BRAT (easiest)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin if you don't have it.
2. In BRAT settings, click **Add Beta Plugin** and enter: `14MoGIT/obsidian-base64-image-cleaner`
3. Enable **Base64 Image Cleaner** in Settings → Community plugins.

### Manual

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/14MoGIT/obsidian-base64-image-cleaner/releases).
2. Create `<vault>/.obsidian/plugins/base64-image-cleaner/` and put both files in it.
3. In Obsidian: **Settings → Community plugins → Reload plugins**, then enable **Base64 Image Cleaner**.
   - If community plugins are disabled, turn off Restricted Mode first.

## Use

- Open a note that contains base64 images.
- Run command (Ctrl/Cmd+P): **Clean base64 images in current note**.
- All matches in that note are replaced/deleted in a single editor transaction.
- **Ctrl/Cmd+Z restores the original content** in one step (and Ctrl/Cmd+Shift+Z redoes it).

## Modes

- **Replace with text** — Swaps each base64 image with placeholder text (customizable). Optionally includes the alt text and trailing text in the replacement.
- **Delete entirely** — Removes base64 images completely.
- **Image Shrink** — Downscales and compresses the image, keeping it inline as a smaller base64. Choose between medium (128px) and icon (32px) presets.
- **Save to file** — Decodes the image, saves it to disk, and replaces the base64 with a wiki-link. Configurable save location (Obsidian default, subfolder next to note, or custom path).

## Why no "clean entire vault" command?

A vault-wide pass would have to write files directly via the filesystem API, which is **not** covered by the editor's undo stack — Ctrl/Cmd+Z would do nothing. To keep the undo guarantee strict, this version only operates on the active editor. If you want vault-wide cleaning later, the safe path is: add a dry-run preview, then write with the user's confirmation.

## Why isn't this plugin official? 
// "Use at your own risk". 

This plugin was first made for myself, for my own convenience. 
The unnecessary endless wall of characters for each accidentally copied logo... was a major annoyance to me.
I used Claude AI because it isn't my main focus. 
I do not want anyone to be mislead. Use it for your own convenience only. 

## Tweaking the regex

It lives near the top of `main.js` as `BASE64_IMAGE_REGEX_SOURCE`. Edit, then **Settings → Community plugins → Reload** the plugin (or toggle it off/on).

## Credits

Code by [Claude](https://claude.ai) (Anthropic). Directed and maintained by [@14MoGIT](https://github.com/14MoGIT).
