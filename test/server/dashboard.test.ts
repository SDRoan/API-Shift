/**
 * The dashboard page is built as a template literal inside TypeScript, so an
 * escape that TypeScript consumes can emit broken JavaScript to the browser
 * while the build and every other test stays green.
 *
 * That happened: `split('\n')` became a literal newline inside a string, which
 * threw a SyntaxError on load and left the whole page blank with no server side
 * error. These tests compile what the browser actually receives.
 */

import { describe, expect, it } from 'vitest';
import * as vm from 'node:vm';
import { renderDashboard } from '../../src/server/index.js';

const html = renderDashboard();

function clientScript(): string {
  const open = html.indexOf('<script>');
  const close = html.lastIndexOf('</script>');
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return html.slice(open + '<script>'.length, close);
}

describe('dashboard page', () => {
  it('serves a complete document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
  });

  it('emits JavaScript the browser can actually parse', () => {
    // Compiling is enough. Running it would need a DOM.
    expect(() => new vm.Script(clientScript())).not.toThrow();
  });

  it('has no stray real newlines inside single quoted strings', () => {
    const offenders = clientScript()
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => (line.match(/'/g) ?? []).length % 2 === 1)
      .filter(({ line }) => !line.includes('//'));

    expect(offenders.map((entry) => entry.number)).toEqual([]);
  });

  it('keeps every element the script queries', () => {
    const script = clientScript();
    const ids = [...script.matchAll(/querySelector\('#([a-zA-Z]+)'\)/g)].map((match) => match[1]);

    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(html).toContain(`id="${id}"`);
  });
});
