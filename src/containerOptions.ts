/**
 * Options for the "return to" dropdown: view containers hunktracker can open after it
 * hides itself. Pure (no vscode import) so it can be unit tested; the caller passes
 * the `packageJSON` of every installed extension.
 *
 * The value of an option is the command that opens it. Containers contributed by an
 * extension open with `workbench.view.extension.<containerId>`, whichever side bar or
 * panel the user has put them in.
 */

export interface ReturnOption {
  /** Command that opens the container. */
  id: string;
  label: string;
  /** Multi-line description of the container, shown under the dropdown. */
  info: string;
}

const BUILTIN_INFO = 'Built-in VS Code pane';

/** Core containers that no extension manifest declares. */
export const BUILTIN_RETURN_OPTIONS: readonly ReturnOption[] = [
  { id: 'workbench.view.explorer', label: 'Explorer', info: BUILTIN_INFO },
  { id: 'workbench.view.search', label: 'Search', info: BUILTIN_INFO },
  { id: 'workbench.view.scm', label: 'Source Control', info: BUILTIN_INFO },
  { id: 'workbench.view.debug', label: 'Run and Debug', info: BUILTIN_INFO },
  { id: 'workbench.view.extensions', label: 'Extensions', info: BUILTIN_INFO },
  { id: 'workbench.action.chat.open', label: 'Chat', info: BUILTIN_INFO },
];

/** Where an extension declares a container; the user may have moved it since. */
const LOCATIONS = [
  ['activitybar', 'Activity Bar'],
  ['secondarySidebar', 'Right side bar'],
  ['panel', 'Panel'],
] as const;

interface ManifestLike {
  displayName?: unknown;
  name?: unknown;
  contributes?: {
    viewsContainers?: Record<string, unknown>;
    views?: Record<string, unknown>;
  };
}

/** "Name" or "Name (only when <condition>)" for each view the manifest puts in a container. */
function describeViews(views: unknown): string[] {
  if (!Array.isArray(views)) return [];
  const lines: string[] = [];
  for (const v of views as Array<{ id?: unknown; name?: unknown; when?: unknown }>) {
    const name = readable(v?.name) ?? (typeof v?.id === 'string' ? v.id : undefined);
    if (!name) continue;
    const when = typeof v?.when === 'string' && v.when.trim() ? ` (only when ${v.when.trim()})` : '';
    lines.push(`${name}${when}`);
  }
  return lines;
}

/** An unresolved `%key%` placeholder means the manifest was not localized. */
function readable(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const t = text.trim();
  return t && !/^%.*%$/.test(t) ? t : undefined;
}

/**
 * @param manifests `packageJSON` of every installed extension
 * @param ownContainerId container id of hunktracker itself (left out)
 */
export function collectReturnOptions(manifests: readonly unknown[], ownContainerId: string): ReturnOption[] {
  const found = new Map<string, ReturnOption & { containerId: string }>();

  for (const raw of manifests) {
    const manifest = raw as ManifestLike | undefined;
    const containers = manifest?.contributes?.viewsContainers;
    if (!containers || typeof containers !== 'object') continue;
    const extName = readable(manifest?.displayName) ?? readable(manifest?.name);

    for (const [location, where] of LOCATIONS) {
      const list = containers[location];
      if (!Array.isArray(list)) continue;
      for (const c of list as Array<{ id?: unknown; title?: unknown }>) {
        if (typeof c?.id !== 'string' || !c.id || c.id === ownContainerId) continue;
        const id = `workbench.view.extension.${c.id}`;
        if (found.has(id)) continue;
        const title = readable(c.title) ?? c.id;
        // Say which extension it belongs to only when that adds information
        const name = extName && extName.toLowerCase() !== title.toLowerCase()
          ? `${title} (${extName})`
          : title;
        const info = [
          extName ? `Extension: ${extName}` : undefined,
          `Declared in: ${where}`,
          `Container: ${c.id}`,
          ...describeViews(manifest?.contributes?.views?.[c.id]).map(v => `View: ${v}`),
        ].filter((line): line is string => line !== undefined).join('\n');
        found.set(id, { id, label: `${name} — ${where}`, info, containerId: c.id });
      }
    }
  }

  const all = Array.from(found.values());
  // Two containers can share title, extension and place (e.g. a sessions list next to the main view)
  const count = new Map<string, number>();
  for (const o of all) count.set(o.label, (count.get(o.label) ?? 0) + 1);
  const fromExtensions: ReturnOption[] = all
    .map(o => ({
      id: o.id,
      label: (count.get(o.label) ?? 0) > 1 ? `${o.label} [${o.containerId}]` : o.label,
      info: o.info,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  return [...BUILTIN_RETURN_OPTIONS, ...fromExtensions];
}
