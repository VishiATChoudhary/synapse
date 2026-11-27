// Graphics in the chat: markdown images, ```svg and ```mermaid drawn in place, html in a locked-down sandbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, graphicDoc } from '../public/workspace.mjs';

test('markdown images show: web images as is, files through the file server', () => {
  const web = renderMarkdown('look ![chart](https://x.dev/a.png) here');
  assert.match(web, /<img class="md-image" alt="chart" loading="lazy" src="https:\/\/x\.dev\/a\.png">/);
  assert.doesNotMatch(web, /!<a/);
  const file = renderMarkdown('![plot](out/plot.png)');
  assert.match(file, /data-file="out\/plot\.png"/);
  assert.match(file, /data-local-src="out\/plot\.png"/);
  assert.match(renderMarkdown('![x](file:///tmp/a.png)'), /data-local-src="\/tmp\/a\.png"/);
  assert.doesNotMatch(renderMarkdown('![x](javascript:alert(1))'), /<img/);
  assert.match(renderMarkdown('[a link](https://x.dev)'), /<a href="https:\/\/x\.dev"/); // links still work
});

test('an svg block draws as an image, so its script can never run', () => {
  const html = renderMarkdown('```svg\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="4"/></svg>\n```');
  assert.match(html, /data-graphic="svg"/);
  assert.match(html, /<img alt="" src="data:image\/svg\+xml;charset=utf-8,%3Csvg/);
  assert.doesNotMatch(html, /<svg|<script/); // only escaped, in the hidden source
  assert.match(html, /<pre hidden><code>&lt;svg/);
});

test('mermaid waits to be drawn; a fence still being written stays code', () => {
  assert.match(renderMarkdown('```mermaid\ngraph TD; A-->B\n```'), /data-graphic="mermaid".*graphic-view" data-pending/);
  const partial = renderMarkdown('```mermaid\ngraph TD; A-->');
  assert.doesNotMatch(partial, /data-graphic/);
  assert.match(partial, /<pre><code>graph TD; A--&gt;<\/code><\/pre>/);
});

test('html previews: a whole page or ```html preview shows, a plain snippet opens on its code', () => {
  assert.match(renderMarkdown('```html preview\n<div>hi</div>\n```'), /data-graphic="html"><div class="code-label">.*>Code<\/button>/);
  assert.match(renderMarkdown('```html\n<!doctype html><p>hi</p>\n```'), /data-graphic="html">/);
  const snippet = renderMarkdown('```html\n<div class="nav"></div>\n```');
  assert.match(snippet, /data-graphic="html" data-code>.*>Preview<\/button>.*graphic-view" data-pending hidden.*<pre><code>/);
});

test('the html sandbox page allows no requests and reports its height', () => {
  const doc = graphicDoc('<canvas id=c></canvas>', true);
  assert.match(doc, /^<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
  assert.match(doc, /connect-src 'none'; frame-src 'none'; form-action 'none'/);
  assert.match(doc, /color-scheme:dark/);
  assert.match(doc, /synapseGraphic/);
});
