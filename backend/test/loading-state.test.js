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
    classList: {
      classes: new Set(),
      toggle(name, force) {
        if (force === undefined) {
          if (this.classes.has(name)) {
            this.classes.delete(name);
            return false;
          }
          this.classes.add(name);
          return true;
        }
        if (force) this.classes.add(name);
        else this.classes.delete(name);
        return force;
      },
      remove(name) {
        this.classes.delete(name);
      }
    },
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

test('loading overlay clears stale text after the final request finishes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../frontend/app.js'), 'utf8');
  const start = source.indexOf('function setAppLoadingState');
  const end = source.indexOf('function setButtonLoadingState');
  const functionSource = source.slice(start, end).trim();

  const textNode = { textContent: 'Saving...' };
  const overlay = {
    hidden: false,
    attributes: { 'aria-busy': 'true' },
    classList: {
      classes: new Set(),
      toggle(name, force) {
        if (force === undefined) {
          if (this.classes.has(name)) {
            this.classes.delete(name);
            return false;
          }
          this.classes.add(name);
          return true;
        }
        if (force) this.classes.add(name);
        else this.classes.delete(name);
        return force;
      },
      remove(name) {
        this.classes.delete(name);
      }
    },
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
    appLoadingRequestCount: 1
  };

  vm.runInNewContext(`let appLoadingRequestCount = 1; ${functionSource};`, context);
  context.setAppLoadingState('Saving...', false);

  assert.equal(overlay.hidden, true, 'The overlay should hide and clear its label when the final request ends.');
  assert.equal(overlay.attributes['aria-busy'], 'false');
  assert.equal(overlay.querySelector('.app-loading-text').textContent, '', 'The stale app loading label should be cleared.');
});
