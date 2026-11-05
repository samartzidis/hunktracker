import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { isProposalBlockedError, probeProposedApi } from '../proposedApi';

const BLOCKED_MESSAGE =
  "Extension 'GeorgeSamartzidis.hunktracker' CANNOT use API proposal: editorInsets.\n" +
  'Its package.json#enabledApiProposals-property declares: [] but NOT editorInsets.\n' +
  ' The missing proposal MUST be added and you must start in extension development mode ' +
  'or use the following command line switch: --enable-proposed-api GeorgeSamartzidis.hunktracker';

describe('proposedApi', () => {
  describe('isProposalBlockedError', () => {
    it('recognizes the VS Code proposal error', () => {
      assert.strictEqual(isProposalBlockedError(new Error(BLOCKED_MESSAGE)), true);
    });

    it('ignores unrelated errors', () => {
      assert.strictEqual(isProposalBlockedError(new Error('not a visible editor')), false);
      assert.strictEqual(isProposalBlockedError('boom'), false);
      assert.strictEqual(isProposalBlockedError(undefined), false);
    });
  });

  describe('probeProposedApi', () => {
    it('is blocked when the call throws the proposal error', () => {
      assert.strictEqual(probeProposedApi(() => { throw new Error(BLOCKED_MESSAGE); }), 'blocked');
    });

    it('is available when the call fails later on the bogus arguments', () => {
      assert.strictEqual(probeProposedApi(() => { throw new Error('not a visible editor'); }), 'available');
    });

    it('is available when the call does not throw', () => {
      assert.strictEqual(probeProposedApi(() => undefined), 'available');
    });

    it('is missing when the function does not exist', () => {
      assert.strictEqual(probeProposedApi(undefined), 'missing');
    });
  });
});
