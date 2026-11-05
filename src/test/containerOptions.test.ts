import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BUILTIN_RETURN_OPTIONS, collectReturnOptions } from '../containerOptions';

/** Shaped like the real Claude Code manifest: three containers with the same title. */
const claude = {
  displayName: 'Claude Code for VS Code',
  contributes: {
    viewsContainers: {
      secondarySidebar: [{ id: 'claude-sidebar-secondary', title: 'Claude Code' }],
      activitybar: [
        { id: 'claude-sidebar', title: 'Claude Code' },
        { id: 'claude-sessions-sidebar', title: 'Claude Code' },
      ],
    },
  },
};

const extras = (options: ReturnType<typeof collectReturnOptions>) => options.slice(BUILTIN_RETURN_OPTIONS.length);

describe('collectReturnOptions', () => {
  it('starts with the built-in containers', () => {
    assert.deepEqual(collectReturnOptions([], 'hunktrackerPanel'), [...BUILTIN_RETURN_OPTIONS]);
  });

  it('uses the open command for extension containers', () => {
    const ids = collectReturnOptions([claude], 'hunktrackerPanel').map(o => o.id);
    assert.ok(ids.includes('workbench.view.extension.claude-sidebar-secondary'));
    assert.ok(ids.includes('workbench.view.extension.claude-sidebar'));
    assert.ok(ids.includes('workbench.view.extension.claude-sessions-sidebar'));
  });

  it('tells containers with the same title apart by where they are declared', () => {
    const options = collectReturnOptions(
      [{
        displayName: 'Azure Resources',
        contributes: { viewsContainers: { activitybar: [{ id: 'azure', title: 'Azure' }], panel: [{ id: 'azurePanel', title: 'Azure' }] } },
      }],
      'hunktrackerPanel'
    );
    assert.deepEqual(extras(options).map(o => o.label), [
      'Azure (Azure Resources) — Activity Bar',
      'Azure (Azure Resources) — Panel',
    ]);
  });

  it('adds the container id only when label and place are still identical', () => {
    const labels = extras(collectReturnOptions([claude], 'hunktrackerPanel')).map(o => o.label);
    assert.deepEqual(labels, [
      'Claude Code (Claude Code for VS Code) — Activity Bar [claude-sessions-sidebar]',
      'Claude Code (Claude Code for VS Code) — Activity Bar [claude-sidebar]',
      'Claude Code (Claude Code for VS Code) — Right side bar',
    ]);
    assert.equal(new Set(labels).size, labels.length, 'every label is unique');
  });

  it('describes a container: extension, place, id and its views with their conditions', () => {
    const withViews = {
      ...claude,
      contributes: {
        ...claude.contributes,
        views: {
          'claude-sidebar-secondary': [
            { id: 'claudeVSCodeSidebarSecondary', name: 'Claude Code', when: '!claude-code:doesNotSupportSecondarySidebar' },
          ],
          'claude-sidebar': [{ id: 'claudeVSCodeSidebar', name: '%view.name%' }],
        },
      },
    };
    const options = collectReturnOptions([withViews], 'hunktrackerPanel');
    const info = (id: string) => options.find(o => o.id === `workbench.view.extension.${id}`)?.info;
    assert.equal(
      info('claude-sidebar-secondary'),
      [
        'Extension: Claude Code for VS Code',
        'Declared in: Right side bar',
        'Container: claude-sidebar-secondary',
        'View: Claude Code (only when !claude-code:doesNotSupportSecondarySidebar)',
      ].join('\n')
    );
    // unresolved view name falls back to the view id; a container without a views entry just has no View lines
    assert.match(info('claude-sidebar') ?? '', /View: claudeVSCodeSidebar$/);
    assert.doesNotMatch(info('claude-sessions-sidebar') ?? '', /View:/);
  });

  it('gives the built-in containers a description too', () => {
    assert.ok(BUILTIN_RETURN_OPTIONS.every(o => o.info.length > 0));
  });

  it('names the extension only when its name differs from the container title', () => {
    const options = collectReturnOptions(
      [{ displayName: 'Docker', contributes: { viewsContainers: { activitybar: [{ id: 'docker', title: 'Docker' }] } } }],
      'hunktrackerPanel'
    );
    assert.equal(extras(options)[0].label, 'Docker — Activity Bar');
  });

  it('leaves out hunktracker itself', () => {
    const options = collectReturnOptions(
      [{ contributes: { viewsContainers: { panel: [{ id: 'hunktrackerPanel', title: 'hunktracker' }] } } }],
      'hunktrackerPanel'
    );
    assert.equal(options.some(o => o.id.endsWith('hunktrackerPanel')), false);
  });

  it('falls back to the id when the title is an unresolved %placeholder%', () => {
    const options = collectReturnOptions(
      [{ contributes: { viewsContainers: { activitybar: [{ id: 'thing', title: '%thing.title%' }] } } }],
      'hunktrackerPanel'
    );
    assert.equal(extras(options)[0].label, 'thing — Activity Bar');
  });

  it('sorts extension containers by label after the built-ins and lists each id once', () => {
    const options = collectReturnOptions(
      [
        { contributes: { viewsContainers: { activitybar: [{ id: 'zeta', title: 'Zeta' }, { id: 'alpha', title: 'Alpha' }] } } },
        { contributes: { viewsContainers: { panel: [{ id: 'alpha', title: 'Alpha again' }] } } },
      ],
      'hunktrackerPanel'
    );
    assert.deepEqual(extras(options).map(o => o.label), ['Alpha — Activity Bar', 'Zeta — Activity Bar']);
  });

  it('ignores manifests without usable view containers', () => {
    const options = collectReturnOptions(
      [undefined, null, {}, { contributes: {} }, { contributes: { viewsContainers: { activitybar: 'nope' } } },
       { contributes: { viewsContainers: { activitybar: [{ title: 'no id' }, { id: 5 }] } } }],
      'hunktrackerPanel'
    );
    assert.deepEqual(options, [...BUILTIN_RETURN_OPTIONS]);
  });
});
