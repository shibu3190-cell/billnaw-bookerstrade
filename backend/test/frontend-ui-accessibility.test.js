const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.join(__dirname, '../..');
const htmlPath = path.join(repoRoot, 'frontend/index.html');
const cssPath = path.join(repoRoot, 'frontend/style.css');
const appJsPath = path.join(repoRoot, 'frontend/app.js');
const swJsPath = path.join(repoRoot, 'frontend/sw.js');
const csvJsPath = path.join(repoRoot, 'frontend/csv.js');

test('frontend files pass node syntax check', () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', appJsPath]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', swJsPath]));
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', csvJsPath]));
});

test('document establishes an h1 landmark for the brand title', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.match(html, /<h1 class="brand-title"[^>]*>[\s\S]*?DeviceTrade Pro[\s\S]*?<\/h1>/);
});

test('all 11 modals contain role="dialog", aria-modal="true", and existing aria-labelledby titles', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const modalMatches = [...html.matchAll(/<div class="modal-backdrop"\s+id="([^"]+)"([^>]*)>/g)];

  assert.equal(modalMatches.length, 11, 'Expected 11 modal dialogs in the application');

  for (const match of modalMatches) {
    const modalId = match[1];
    const attrs = match[2];

    assert.ok(attrs.includes('role="dialog"'), `Modal #${modalId} must have role="dialog"`);
    assert.ok(attrs.includes('aria-modal="true"'), `Modal #${modalId} must have aria-modal="true"`);

    const labelledByMatch = attrs.match(/aria-labelledby="([^"]+)"/);
    assert.ok(labelledByMatch, `Modal #${modalId} must have aria-labelledby`);

    const titleId = labelledByMatch[1];
    assert.ok(
      html.includes(`id="${titleId}"`),
      `Modal #${modalId} title element #${titleId} must exist in the HTML`
    );
  }
});

test('all modal close buttons include aria-label for assistive tech', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const closeButtonMatches = [...html.matchAll(/<button class="modal-close"([^>]*)>/g)];

  assert.ok(closeButtonMatches.length >= 11, 'Expected at least 11 modal close buttons');
  for (const match of closeButtonMatches) {
    const attrs = match[1];
    assert.ok(attrs.includes('aria-label='), `Modal close button must have aria-label: ${match[0]}`);
  }
});

test('all form labels with for attribute resolve to valid input/select/textarea IDs', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const labelMatches = [...html.matchAll(/<label[^>]*\s+for="([^"]+)"/g)];

  assert.ok(labelMatches.length >= 25, 'Expected comprehensive label associations across forms');

  for (const match of labelMatches) {
    const targetId = match[1];
    assert.ok(
      html.includes(`id="${targetId}"`),
      `Label target #${targetId} must exist in index.html`
    );
  }
});

test('all data tables define an accessible aria-label and scope="col" on table headers', () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const tableMatches = [...html.matchAll(/<table([^>]*)>/g)];

  assert.ok(tableMatches.length >= 6, 'Expected at least 6 data tables');
  for (const match of tableMatches) {
    const attrs = match[1];
    assert.ok(attrs.includes('aria-label='), `Table must have an aria-label: ${match[0]}`);
  }

  const thWithoutScope = [...html.matchAll(/<th>/g)];
  assert.equal(thWithoutScope.length, 0, 'All <th> elements must specify scope="col"');
});

test('style.css implements visible focus outlines and reduced motion override', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  assert.ok(css.includes(':focus-visible'), 'CSS must define :focus-visible rules');
  assert.ok(css.includes('outline: 2px solid'), 'Focus ring must provide distinct outline');
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'), 'CSS must support prefers-reduced-motion');
  assert.ok(css.includes('.badge-counter') && css.includes('animation: none !important'), 'Pulsing badge must be paused under reduced motion');
});

test('app.js exports focus trap, restore, and Escape dismissal for modals', () => {
  const appJs = fs.readFileSync(appJsPath, 'utf8');
  assert.ok(appJs.includes('const modalTriggerElements = {};'), 'app.js must track modal triggers');
  assert.ok(appJs.includes("if (e.key === 'Escape')"), 'app.js must dismiss modals on Escape');
  assert.ok(appJs.includes("if (e.key === 'Tab')"), 'app.js must trap Tab cycling inside active modal');
  assert.ok(appJs.includes('modal.setAttribute(\'aria-hidden\', \'false\')'), 'openModal must update aria-hidden');
  assert.ok(appJs.includes('modal.setAttribute(\'aria-hidden\', \'true\')'), 'closeModal must update aria-hidden');
  assert.ok(
    appJs.indexOf('modal.contains(document.activeElement)') < appJs.indexOf("modal.setAttribute('aria-hidden', 'true')"),
    'closeModal must shift or blur focus before applying aria-hidden="true"'
  );
});

test('handleExecuteSettlement properly resolves order from AppState before calculating balance and customer', () => {
  const appJs = fs.readFileSync(appJsPath, 'utf8');
  assert.ok(
    appJs.includes('const order = AppState.orders.find(o => o.id === orderId);'),
    'handleExecuteSettlement must define order to avoid ReferenceError'
  );
});
