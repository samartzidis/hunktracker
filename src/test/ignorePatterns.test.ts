import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import ignore from 'ignore';
import { cleanPatternList, mergeIgnorePatterns, isInsideDotGit, withoutBuiltInPatterns } from '../ignorePatterns';

describe('cleanPatternList', () => {
  it('keeps trimmed, non-empty strings in order and drops repeats', () => {
    assert.deepEqual(cleanPatternList(['dist', '  *.log ', '', '   ', 'dist', 'tmp/']), ['dist', '*.log', 'tmp/']);
  });

  it('ignores anything that is not a list of strings', () => {
    assert.deepEqual(cleanPatternList(undefined), []);
    assert.deepEqual(cleanPatternList(null), []);
    assert.deepEqual(cleanPatternList('dist'), []);
    assert.deepEqual(cleanPatternList({ 0: 'dist' }), []);
    assert.deepEqual(cleanPatternList(['dist', 5, null, { a: 1 }, 'out']), ['dist', 'out']);
  });
});

describe('mergeIgnorePatterns', () => {
  it('puts global patterns before the project ones', () => {
    assert.deepEqual(mergeIgnorePatterns(['*.log', '.idea'], ['dist', '.git']), ['*.log', '.idea', 'dist', '.git']);
  });

  it('works when either side is empty', () => {
    assert.deepEqual(mergeIgnorePatterns([], ['.git']), ['.git']);
    assert.deepEqual(mergeIgnorePatterns(['*.log'], []), ['*.log']);
    assert.deepEqual(mergeIgnorePatterns([], []), []);
  });

  it('does not change its inputs', () => {
    const g = ['a'];
    const p = ['b'];
    mergeIgnorePatterns(g, p).push('c');
    assert.deepEqual(g, ['a']);
    assert.deepEqual(p, ['b']);
  });

  it('lets a project re-include what a global pattern excludes (last matching line wins)', () => {
    const matcher = ignore().add(mergeIgnorePatterns(['*.log'], ['!keep.log']));
    assert.equal(matcher.ignores('debug.log'), true);
    assert.equal(matcher.ignores('keep.log'), false);
  });

  it('would not allow that the other way round', () => {
    const matcher = ignore().add(mergeIgnorePatterns(['!keep.log'], ['*.log']));
    assert.equal(matcher.ignores('keep.log'), true);
  });
});

describe('isInsideDotGit', () => {
  it('matches .git at any depth, as a folder or a file', () => {
    assert.equal(isInsideDotGit('.git'), true);
    assert.equal(isInsideDotGit('.git/'), true);
    assert.equal(isInsideDotGit('.git/HEAD'), true);
    assert.equal(isInsideDotGit('sub/module/.git'), true);
    assert.equal(isInsideDotGit('sub/.git/objects/ab/cd'), true);
  });

  it('does not match names that merely contain .git', () => {
    assert.equal(isInsideDotGit('.gitignore'), false);
    assert.equal(isInsideDotGit('.github/workflows/ci.yml'), false);
    assert.equal(isInsideDotGit('src/my.git/file'), false);
    assert.equal(isInsideDotGit('a.git'), false);
    assert.equal(isInsideDotGit('src/index.ts'), false);
  });
});

describe('withoutBuiltInPatterns', () => {
  it('removes a stored .git and keeps everything else in order', () => {
    assert.deepEqual(withoutBuiltInPatterns(['.git', 'dist', '*.log']), ['dist', '*.log']);
    assert.deepEqual(withoutBuiltInPatterns([' .git ', 'dist']), ['dist']);
    assert.deepEqual(withoutBuiltInPatterns(['.gitignore', '.github']), ['.gitignore', '.github']);
    assert.deepEqual(withoutBuiltInPatterns([]), []);
  });
});
