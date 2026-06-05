import { DEFAULT_SYSTEM } from './agent.service';

describe('Signage agent DEFAULT_SYSTEM', () => {
  it('is scoped to signage compliance for the QuoteMate Signage tool', () => {
    expect(DEFAULT_SYSTEM).toContain('Signage Compliance assistant');
    expect(DEFAULT_SYSTEM).toContain('QuoteMate');
  });

  it('keeps both franchise brands in scope', () => {
    expect(DEFAULT_SYSTEM).toMatch(/F45/);
    expect(DEFAULT_SYSTEM).toMatch(/Anytime Fitness/);
  });

  it('uses QuoteMate’s per-rule and rollup verdict vocabulary', () => {
    for (const token of [
      'compliant',
      'non_compliant',
      'cannot_determine',
      'pass',
      'fix_needed',
      'needs_review',
    ]) {
      expect(DEFAULT_SYSTEM).toContain(token);
    }
  });

  it('encodes the triage-not-certify safety posture', () => {
    // It is text-only: it must not pretend to see the franchisee photos.
    expect(DEFAULT_SYSTEM).toMatch(/do NOT see the franchisee/i);
    expect(DEFAULT_SYSTEM).toMatch(/You triage; HQ decides/);
    expect(DEFAULT_SYSTEM).toMatch(/never declare a franchise-agreement breach/i);
    // When in doubt it downgrades rather than guesses.
    expect(DEFAULT_SYSTEM).toMatch(/never guess/i);
    expect(DEFAULT_SYSTEM).toMatch(/Never invent rules/i);
  });

  it('prefers the grounded search_store tool', () => {
    expect(DEFAULT_SYSTEM).toContain('search_store');
  });
});
