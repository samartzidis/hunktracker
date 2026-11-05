# Hunk Tracker

Review in-line file changes made in Visual Studio Code by AI coding assistants like [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Every changed block gets its own Accept and Discard bar inline in the editor.

## Features

Hunk Tracker is based on the [molon/hunkwise](https://github.com/molon/hunkwise) extension with performance improvements and additional features such as:

- **Performance Improvements.** Large projects open without freezing, enabling takes seconds (a 1 GB project in about 6 seconds).

- **Hunk navigation.** Buttons and `Alt+,` / `Alt+.` jump to the previous or next change, continue into the next changed file and wrap around at the end.

- **Auto-accept on startup**. Changes still pending when a workspace is reopened are accepted automatically.

- **Auto-reveal panel**. The Hunk Tracker view appears when a file gets new changes and hides again when nothing is pending, optionally returning to another pane such as Claude Code.

- **Clean projects.** Settings and baselines live in the editor's own storage, never in the project, so nothing needs adding to `.gitignore`. Data of deleted projects is removed automatically.

- **Exclude patterns.** Files can be excluded with gitignore-style patterns, for one project or for all projects.

- **No git needed.** Git does not have to be installed, and enabling a large project is fast.

- **Big files skipped.** Files over 10 MB, such as executables, archives and media, are not tracked.

- **Position strip.** Each changed file shows a small bar marking where in the file the changes are: green for added, red for removed.

- **Familiar order.** Changed files are listed like the Explorer, and next/previous follow the same order.

- **Visible progress.** Starting on a large project shows what is happening instead of a blank wait.

## Installation

1. Get `hunktracker-<version>.vsix` from the [Releases](https://github.com/samartzidis/hunktracker/releases) page.
2. To install it: `code --install-extension hunktracker-<version>.vsix`. For Cursor, use the `cursor` command instead of `code`.
   To remove it: `code --uninstall-extension GeorgeSamartzidis.hunktracker`.

## License

MIT.