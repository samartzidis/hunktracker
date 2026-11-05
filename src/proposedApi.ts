// No `vscode` import here so the helpers stay unit-testable in plain Node.

/**
 * - available: the proposed API can be used
 * - blocked:   VS Code has it, but this extension is not opted in via argv.json
 * - missing:   this VS Code version no longer provides it at all
 */
export type ApiStatus = 'available' | 'blocked' | 'missing';

/**
 * True if `err` is VS Code's "extension may not use this API proposal" error.
 * The message is "Extension '<id>' CANNOT use API proposal: <name>. ..." and is
 * thrown by checkProposedApiEnabled, the first statement of every proposed API.
 */
export function isProposalBlockedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /CANNOT use API proposal/i.test(message);
}

/**
 * Probe a proposed API by calling it with arguments that can never succeed.
 * A proposed API checks enablement first, so a blocked extension gets the
 * proposal error, while an enabled one fails later on the bogus arguments (or
 * does not throw at all). Pass `undefined` when the function does not exist.
 *
 * Fails open: any other error counts as available, so a VS Code change to the
 * wording only costs us the notice and never greys out a working extension.
 */
export function probeProposedApi(call: (() => unknown) | undefined): ApiStatus {
  if (typeof call !== 'function') return 'missing';
  try {
    call();
    return 'available';
  } catch (err) {
    return isProposalBlockedError(err) ? 'blocked' : 'available';
  }
}
