import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ScopePolicy } from '@scopepilot2/core';
import type { CaseScope } from '@scopepilot2/contracts';

function scopeOf(allowedOrigins: readonly string[], deniedOrigins: readonly string[] = []): CaseScope {
  return { allowedOrigins, deniedOrigins, limits: { maxRequests: 1, maxPages: 1, maxDurationMinutes: 1 } };
}

describe('ScopePolicy', () => {
  test('[F01-UT-001] allow と deny が重なる場合は deny を優先する', () => {
    const scope = scopeOf(['http://example.com'], ['http://example.com']);
    const decision = ScopePolicy.decide(scope, 'http://example.com/path');
    assert.equal(decision.allowed, false);
    if (!decision.allowed) {
      assert.match(decision.reason, /deny rule/);
    }
  });

  test('[F01-UT-002] Unicode host・既定 port・末尾 dot を canonical origin へ一致させる', () => {
    assert.equal(ScopePolicy.canonicalOrigin('HTTP://WWW.Example.com:80/path'), 'http://www.example.com');
    assert.equal(ScopePolicy.canonicalOrigin('https://www.example.com:443/'), 'https://www.example.com');
    assert.equal(ScopePolicy.canonicalOrigin('http://www.example.com:8080/'), 'http://www.example.com:8080');
    assert.equal(ScopePolicy.canonicalOrigin('http://www.example.com./'), 'http://www.example.com');
    assert.equal(ScopePolicy.canonicalOrigin('http://例え.jp/'), 'http://xn--r8jz45g.jp');
    assert.equal(ScopePolicy.canonicalOrigin('http://[::1]:8080/'), 'http://[::1]:8080');

    assert.equal(ScopePolicy.decide(scopeOf(['http://www.example.com']), 'http://WWW.Example.com.:80/a').allowed, true);
    assert.equal(ScopePolicy.decide(scopeOf(['http://xn--r8jz45g.jp']), 'http://例え.JP/').allowed, true);
  });
});
