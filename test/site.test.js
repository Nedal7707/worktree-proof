import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteRoot = path.join(projectRoot, 'site');
const indexPath = path.join(siteRoot, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');
const styles = fs.readFileSync(path.join(siteRoot, 'styles.css'), 'utf8');

function removeElementBlocks(source, tagName) {
  const lower = source.toLowerCase();
  const opening = `<${tagName}`;
  const closing = `</${tagName}>`;
  const parts = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = lower.indexOf(opening, cursor);
    if (start < 0) break;
    const openEnd = lower.indexOf('>', start + opening.length);
    const close = openEnd < 0 ? -1 : lower.indexOf(closing, openEnd + 1);
    parts.push(source.slice(cursor, start), ' ');
    if (close < 0) {
      cursor = source.length;
      break;
    }
    cursor = close + closing.length;
  }
  if (cursor < source.length) parts.push(source.slice(cursor));
  return parts.join('');
}

function removeTags(source) {
  const parts = [];
  let plainStart = 0;
  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] !== '<') {
      cursor += 1;
      continue;
    }
    if (cursor > plainStart) parts.push(source.slice(plainStart, cursor));
    const close = source.indexOf('>', cursor + 1);
    if (close < 0) {
      plainStart = source.length;
      break;
    }
    parts.push(' ');
    cursor = close + 1;
    plainStart = cursor;
  }
  if (plainStart < source.length) parts.push(source.slice(plainStart));
  return parts.join('');
}

function collapseWhitespace(source) {
  let result = '';
  let pendingSpace = false;
  for (const character of source) {
    if (character.charCodeAt(0) <= 32) {
      pendingSpace = result.length > 0;
      continue;
    }
    if (pendingSpace) result += ' ';
    result += character;
    pendingSpace = false;
  }
  return result.trim();
}

const visibleHtml = removeTags(removeElementBlocks(removeElementBlocks(html, 'script'), 'style'));
const text = collapseWhitespace(visibleHtml.split('&amp;').join('&'));

function attribute(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return match?.[1] ?? null;
}

function tags(name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((match) => match[0]);
}

function idSet() {
  return new Set([...html.matchAll(/\bid=["']([^"']+)["']/gi)].map((match) => match[1]));
}

test('landing page has truthful SEO metadata and canonical URL', () => {
  const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1].trim();
  const description = attribute(tags('meta').find((tag) => /name=["']description["']/i.test(tag)), 'content');
  const canonical = attribute(tags('link').find((tag) => /rel=["']canonical["']/i.test(tag)), 'href');
  assert.ok(title, 'title is required');
  assert.ok(title.length >= 50 && title.length <= 60, `title should be 50–60 characters (got ${title.length})`);
  assert.ok(description, 'description is required');
  assert.ok(description.length >= 150 && description.length <= 160, `description should be 150–160 characters (got ${description.length})`);
  assert.equal(canonical, 'https://nedal7707.github.io/worktree-proof/');
  for (const property of ['og:title', 'og:description', 'og:url', 'og:type', 'twitter:card', 'twitter:title', 'twitter:description']) {
    assert.ok(tags('meta').some((tag) => new RegExp(`(?:property|name)=["']${property}["']`, 'i').test(tag)), `${property} metadata is required`);
  }
});

test('page is accessible and has one clear heading', () => {
  assert.equal(tags('h1').length, 1, 'page should have exactly one h1');
  assert.match(html, /<html\b[^>]*\blang=["']en["']/i, 'document language is required');
  assert.match(html, /href=["']#main-content["']/i, 'skip link is required');
  for (const tag of tags('img')) assert.notEqual(attribute(tag, 'alt'), null, 'every image must have alt text');
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const openingTag = `<a${match[1]}>`;
    const label = collapseWhitespace(removeTags(match[2]));
    assert.ok(label || attribute(openingTag, 'aria-label'), `link needs visible text or an aria-label: ${openingTag}`);
  }
  assert.ok(tags('nav').length >= 2, 'primary and footer navigation landmarks are required');
  assert.match(styles, /prefers-reduced-motion\s*:\s*reduce/i, 'reduced-motion handling is required');
  assert.match(styles, /min-height:\s*48px/i, 'interactive targets should include 48px sizing');
});

test('JSON-LD contains only factual software and FAQ objects', () => {
  const scripts = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 2, 'SoftwareSourceCode and FAQPage JSON-LD are required');
  const data = scripts.map((match) => JSON.parse(match[1]));
  assert.deepEqual(data.map((item) => item['@type']).sort(), ['FAQPage', 'SoftwareSourceCode']);
  const software = data.find((item) => item['@type'] === 'SoftwareSourceCode');
  assert.equal(software.codeRepository, 'https://github.com/Nedal7707/worktree-proof');
  assert.equal(software.programmingLanguage, 'JavaScript');
  assert.equal(software.runtimePlatform, 'Node.js');
  const faq = data.find((item) => item['@type'] === 'FAQPage');
  assert.ok(Array.isArray(faq.mainEntity) && faq.mainEntity.length >= 3);
  for (const question of faq.mainEntity) assert.match(question.acceptedAnswer.text, /\S/);
});

test('site has no private strings, placeholders, trackers, or external scripts', () => {
  const siteFiles = fs.readdirSync(siteRoot).map((name) => path.join(siteRoot, name)).filter((filePath) => fs.statSync(filePath).isFile());
  const siteText = siteFiles.map((filePath) => fs.readFileSync(filePath, 'utf8')).join('\n');
  const privatePatterns = [
    /(?:api[_ -]?key|client[_ -]?secret|private[_ -]?key|password|passwd|authorization|bearer|cookie)\s*[:=]/i,
    /(?:sk-[a-z0-9]{16,}|gh[pousr]_[a-z0-9]{16,}|xox[baprs]-[a-z0-9-]{16,})/i,
  ];
  const placeholderPatterns = [/\b(?:TODO|FIXME|TBD|PLACEHOLDER)\b/i, /\bYOUR_[A-Z0-9_]+\b/, /\{\{[^}]+\}\}/];
  for (const pattern of [...privatePatterns, ...placeholderPatterns]) assert.doesNotMatch(siteText, pattern);
  for (const tag of tags('script')) {
    assert.equal(attribute(tag, 'src'), null, 'site scripts must be self-contained');
    assert.equal(attribute(tag, 'type'), 'application/ld+json', 'only JSON-LD scripts are allowed');
  }
  assert.doesNotMatch(siteText, /(?:google-analytics|googletagmanager|gtag\s*\(|plausible\.io|pixel\.)/i);
});

test('internal anchors resolve and crawl files point to the canonical site', () => {
  const ids = idSet();
  for (const tag of tags('a')) {
    const href = attribute(tag, 'href');
    if (href?.startsWith('#')) assert.ok(ids.has(href.slice(1)), `internal link target is missing: ${href}`);
  }
  const robots = fs.readFileSync(path.join(siteRoot, 'robots.txt'), 'utf8');
  const sitemap = fs.readFileSync(path.join(siteRoot, 'sitemap.xml'), 'utf8');
  assert.match(robots, /User-agent:\s*\*/i);
  assert.match(robots, /Allow:\s*\//i);
  assert.match(robots, /Sitemap:\s*https:\/\/nedal7707\.github\.io\/worktree-proof\/sitemap\.xml/i);
  assert.match(sitemap, /<loc>https:\/\/nedal7707\.github\.io\/worktree-proof\/<\/loc>/i);
  assert.match(sitemap, /<urlset\b[^>]*xmlns=["']http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9["']/i);
  assert.match(fs.readFileSync(path.join(siteRoot, 'llms.txt'), 'utf8'), /WorktreeProof[\s\S]*open-source vibe coding guardrails/i);
  assert.match(fs.readFileSync(path.join(projectRoot, '.github', 'workflows', 'pages.yml'), 'utf8'), /path:\s*site\b/i);
});

test('first prose paragraph defines the product and page has the requested sections', () => {
  const firstParagraph = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.match(firstParagraph, /WorktreeProof is open-source vibe coding guardrails for AI coding agents/i);
  for (const id of ['pipeline', 'capabilities', 'recipes', 'install', 'privacy', 'faq', 'contributing']) assert.ok(idSet().has(id), `missing section: ${id}`);
  assert.match(text, /Vibe fast\.\s*Ship with proof\./i);
});
