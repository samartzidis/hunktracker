import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareByLocation, sortFiles } from '../fileOrder';

const order = (paths: string[]) => sortFiles(paths, p => p);

describe('compareByLocation', () => {
  it('keeps the files of a folder together, sorted by name', () => {
    assert.deepEqual(
      order(['b/z.tf', 'a/y.tf', 'b/a.tf', 'a/x.tf']),
      ['a/x.tf', 'a/y.tf', 'b/a.tf', 'b/z.tf']
    );
  });

  it('puts subfolders before the files of the folder, as the Explorer does', () => {
    assert.deepEqual(
      order(['a/b/x.tf', 'c/x.tf', 'a/y.tf', 'a/x.tf']),
      ['a/b/x.tf', 'a/x.tf', 'a/y.tf', 'c/x.tf']
    );
  });

  it('puts root-level files after every folder', () => {
    assert.deepEqual(order(['z.txt', 'a/x.tf', 'a.txt']), ['a/x.tf', 'a.txt', 'z.txt']);
  });

  it('applies folders-first at every level', () => {
    assert.deepEqual(
      order(['a/b/z.tf', 'a/b/c/z.tf', 'a/b/a.tf', 'a/a.tf', 'a/b/c/d/z.tf']),
      ['a/b/c/d/z.tf', 'a/b/c/z.tf', 'a/b/a.tf', 'a/b/z.tf', 'a/a.tf']
    );
  });

  it('is not thrown off by punctuation in names (a whole-path string compare is)', () => {
    // "_" sorts before "." in a raw path compare, which would put dir_x/ before dir/
    assert.deepEqual(
      order(['dir_x/a.tf', 'dir/z.tf', 'dir/sub/a.tf']),
      ['dir/sub/a.tf', 'dir/z.tf', 'dir_x/a.tf']
    );
  });

  it('sorts embedded numbers numerically', () => {
    assert.deepEqual(
      order(['m/file10.tf', 'm/file2.tf', 'm/file1.tf']),
      ['m/file1.tf', 'm/file2.tf', 'm/file10.tf']
    );
  });

  it('ignores case when ordering, but is still deterministic for names differing only by case', () => {
    assert.deepEqual(order(['b/a.tf', 'A/x.tf', 'a/y.tf']).map(p => p.toLowerCase()), ['a/x.tf', 'a/y.tf', 'b/a.tf']);
    assert.equal(compareByLocation('a/X.tf', 'a/x.tf'), -compareByLocation('a/x.tf', 'a/X.tf'));
    assert.notEqual(compareByLocation('a/X.tf', 'a/x.tf'), 0);
  });

  it('compares the name before the extension, so a shorter name comes before its longer variants', () => {
    assert.deepEqual(
      order(['m/cert_manager_key_vault_sync.tf', 'm/cert_manager.tf', 'm/foo.test.ts', 'm/foo.ts']),
      ['m/cert_manager.tf', 'm/cert_manager_key_vault_sync.tf', 'm/foo.ts', 'm/foo.test.ts']
    );
  });

  it('orders same-named files by extension and keeps dotfiles whole', () => {
    assert.deepEqual(order(['m/main.tf', 'm/main.py', 'm/main']), ['m/main', 'm/main.py', 'm/main.tf']);    assert.deepEqual(order(['m/.gitignore', 'm/.env', 'm/a.txt']), ['m/.env', 'm/.gitignore', 'm/a.txt']);
  });

  it('treats backslash and slash separators alike', () => {
    assert.equal(compareByLocation('a\\b\\x.tf', 'a/b/x.tf'), 0);
    assert.deepEqual(order(['b\\x.tf', 'a/x.tf']), ['a/x.tf', 'b\\x.tf']);
  });

  it('returns 0 for identical paths', () => {
    assert.equal(compareByLocation('a/x.tf', 'a/x.tf'), 0);
  });

  it('orders a realistic review list the way a tree would read', () => {
    const input = [
      'IngressHAP/modules/haproxy_lb_02/main.tf',
      'HAzure/HyOps/modules/aks_apps/variables.tf',
      'HAzure/HyOps/environments/dev/ea2d1/aks_apps/terragrunt.hcl',
      'HAzure/HyOps/modules/aks_apps/cert_manager.tf',
      'IngressHAP/environments/ea2d1/terraform.tfvars',
      'HAzure/HyOps/modules/aks_apps/cert_manager_key_vault_sync.tf',
    ];
    assert.deepEqual(order(input), [
      'HAzure/HyOps/environments/dev/ea2d1/aks_apps/terragrunt.hcl',
      'HAzure/HyOps/modules/aks_apps/cert_manager.tf',
      'HAzure/HyOps/modules/aks_apps/cert_manager_key_vault_sync.tf',
      'HAzure/HyOps/modules/aks_apps/variables.tf',
      'IngressHAP/environments/ea2d1/terraform.tfvars',
      'IngressHAP/modules/haproxy_lb_02/main.tf',
    ]);
  });
});

describe('sortFiles', () => {
  it('returns a sorted copy and leaves the input untouched', () => {
    const input = [{ p: 'b/x' }, { p: 'a/x' }];
    const sorted = sortFiles(input, f => f.p);
    assert.deepEqual(sorted.map(f => f.p), ['a/x', 'b/x']);
    assert.deepEqual(input.map(f => f.p), ['b/x', 'a/x']);
  });

  it('defaults to the location mode', () => {
    assert.deepEqual(sortFiles(['b/x', 'a/x'], p => p), sortFiles(['b/x', 'a/x'], p => p, 'location'));
  });
});
