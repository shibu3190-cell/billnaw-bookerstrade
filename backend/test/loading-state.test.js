const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('loading overlay remains visible while nested async actions are still active', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../frontend/app.js'), 'utf8');
  const start = source.indexOf('function setAppLoadingState');
  const end = source.indexOf('function setButtonLoadingState');
  const functionSource = source.slice(start, end).trim();

  const textNode = { textContent: '' };
  const overlay = {
    hidden: true,
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    querySelector(selector) {
      if (selector === '.app-loading-text') {
        return textNode;
      }
      return null;
    }
  };

  const context = {
    document: {
      getElementById() {
        return overlay;
      }
    },
    appLoadingRequestCount: 0
  };

  vm.runInNewContext(`let appLoadingRequestCount = 0; ${functionSource};`, context);
  context.setAppLoadingState('Loading data...', true);
  context.setAppLoadingState('Syncing data...', true);
  context.setAppLoadingState('Saving...', false);

  assert.equal(overlay.hidden, false, 'The app loading overlay should stay visible until all active requests finish.');
  assert.equal(overlay.attributes['aria-busy'], 'true');
  assert.equal(overlay.querySelector('.app-loading-text').textContent, 'Saving...');
});
