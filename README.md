# Hunk Tracker

Review in-line file changes made in Visual Studio Code by AI coding assistants like [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Per-hunk Accept / Discard. Every changed block gets its own Accept and Discard bar inline in the editor.

## Features

Based on [molon/hunkwise](https://github.com/molon/hunkwise) but incorporating improvements and additional features such as:

- **Windows Fixes** Paths are handled correctly.
- **Hunk navigation.** `‹` / `›` buttons and `Alt+,` / `Alt+.` jump to the previous or next hunk, carry on into the next changed file, and wrap around at the end.
- **Auto-accept on startup** (off by default). Accepts everything still pending when you reopen a workspace.
- **Auto-reveal panel** (off by default). For a side-bar layout: shows the Hunk Tracker view when a file gets new changes and hides it when nothing is pending. Pick a pane to return to afterwards (for example Claude Code) in the Hunk Tracker settings screen; nothing happens if Hunk Tracker could not hide.
- **Your project stays clean.** Hunk Tracker keeps its settings and baselines in the editor's per-workspace extension storage (for VS Code on Windows, under `%APPDATA%\Code\User\workspaceStorage`), not in your project, so there is nothing to add to `.gitignore`. Each editor (VS Code, Insiders, Cursor) keeps its own copy. VS Code does not delete that storage when a project folder is deleted, so shortly after startup Hunk Tracker removes its own data for projects whose folder no longer exists (local folders only; it never touches project files or other extensions' data).
- **Exclude patterns** (gitignore-style) are set in the settings screen (gear icon). Tick *Global scoped* when adding one to make it global: it is stored in the user setting `hunktracker.globalIgnorePatterns` and merged with each project's own list (global first, so a project can re-include something with a `!pattern` line).
- **Simpler UI.** Enable and Disable are buttons in the panel (Disable is under Settings), not Command Palette entries.

## Installation

1. Get `hunktracker-<version>.vsix` from the [Releases](https://github.com/samartzidis/hunktracker/releases) page.
2. To install it: `code --install-extension hunktracker-<version>.vsix`. For Cursor, use the `cursor` command instead of `code`.
   To remove it: `code --uninstall-extension GeorgeSamartzidis.hunktracker`.

## License

MIT.
