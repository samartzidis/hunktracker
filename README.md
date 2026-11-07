# Hunk Tracker

Review in-line file changes made in Visual Studio Code by AI coding assistants like [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Every changed block gets its own Accept and Discard bar inline in the editor.

![Hunk Tracker screenshot](docs/screenshot.png =640x)

## Features

- **Inline review.** Each change shows in the editor with its own Accept and Discard buttons, plus buttons to move to the previous or next change.

- **Changed files list.** The side panel lists every changed file with a small visual map of where in the file the changes are.

- **Fast on large projects.** Large projects open without freezing, and enabling takes seconds (a 1 GB project in about 6 seconds).

- **No external tools.** Git or any other program does not have to be installed.

- **Hunk navigation.** Buttons and `Alt+,` / `Alt+.` jump to the previous or next change, continue into the next changed file and wrap around at the end.

- **Unintrusive auto reveal/hide panel.** The Hunk Tracker view appears when a file gets new changes and hides again when nothing is pending, optionally returning to another pane such as Claude Code.

- **Exclude patterns.** Files can be excluded with gitignore-style patterns, for one project or for all projects. Files over 10 MB are never tracked.

- **Clean projects.** Settings and baselines live in the editor's own storage, never in the project, so nothing needs adding to `.gitignore`.

## Installation

1. Get `hunktracker-<version>.vsix` from the [Releases](https://github.com/samartzidis/hunktracker/releases) page.
2. To install it: `code --install-extension hunktracker-<version>.vsix`. For Cursor, use the `cursor` command instead of `code`.
   To remove it: `code --uninstall-extension GeorgeSamartzidis.hunktracker`.

## Credits

Hunk Tracker is based on the MIT licensed [molon/hunkwise](https://github.com/molon/hunkwise) extension.

## License

MIT.