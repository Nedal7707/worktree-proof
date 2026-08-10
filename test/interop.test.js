import assert from 'node:assert/strict';
import test from 'node:test';

import { createIntegrationManifest, renderClientPreview } from '../src/index.js';

test('all client previews preserve one manifest and never select a model', () => {
  const manifest = createIntegrationManifest({
    client: 'any-cli',
    capabilities: ['scope.validate'],
    scope: ['src/'],
  });
  for (const target of ['generic', 'codex', 'claude']) {
    const preview = renderClientPreview(target, manifest);
    assert.equal(preview.manifestHash, manifest.manifestHash);
    assert.doesNotMatch(JSON.stringify(preview), /model|reasoning|token|cookie|password/i);
  }
});
