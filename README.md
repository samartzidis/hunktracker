# Hunk Tracker

Review in-line file changes made in Visual Studio Code by AI coding assistants like [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Per-hunk Accept / Discard. Every changed block gets its own Accept and Discard bar inline in the editor.

## Features

Based on [molon/hunkwise](https://github.com/molon/hunkwise) but incorporating improvements and additional features such as:

- **Windows Fixes** Paths are handled correctly.
- **Hunk navigation.** `‹` / `›` buttons and `Alt+,` / `Alt+.` jump to the previous or next hunk, carry on into the next changed file, and wrap around at the end.
- **Auto-accept on startup** (off by default). Accepts everything still pending when you reopen a workspace.
- **Auto-reveal panel** (off by default). For a side-bar layout: shows the Hunk Tracker view when a file gets new changes and hides it when nothing is pending. Pick a pane to return to afterwards (for example Claude Code) in the Hunk Tracker settings screen; nothing happens if Hunk Tracker could not hide.
- **Your `.gitignore` is left alone.** Hunk Tracker keeps its data in `.vscode/hunktracker/`. Add that folder to your `.gitignore` if you don't want it in `git status`.
- **Simpler UI.** Enable and Disable are buttons in the panel (Disable is under Settings), not Command Palette entries.

## Installation

1. Get `hunktracker-<version>.vsix` from the [Releases](https://github.com/samartzidis/hunktracker/releases) page.
2. To install it: `code --install-extension hunktracker-<version>.vsix`. For Cursor, use the `cursor` command instead of `code`.
   To remove it: `code --uninstall-extension GeorgeSamartzidis.hunktracker`.

## License

MIT.
