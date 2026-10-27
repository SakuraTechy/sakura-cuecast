import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const recorderSource = readFileSync(new URL('../content/recorder.js', import.meta.url), 'utf8');

test('new table and list collection locators default to business-object semantics', () => {
  assert.match(recorderSource, /tableRowSemantic\._collection_locator_mode = 'semantic'/);
  assert.match(recorderSource, /collectionSemantic\._collection_locator_mode = 'semantic'/);
  assert.match(
    recorderSource,
    /collection_item_identity:\s*\{[\s\S]*?mode: 'semantic',[\s\S]*?semantic_config: collectionSemantic/,
  );
  assert.doesNotMatch(recorderSource, /collectionSemantic\._collection_locator_mode = 'ordinal'/);
});
