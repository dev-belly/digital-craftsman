const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPage(page, document) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'enterprise-web', page), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  const script = scripts.at(-1)[1].replace(/\binit\(\);\s*$/, '');
  const context = vm.createContext({ document, location: { search: '', href: '' }, console, encodeURIComponent });
  vm.runInContext(script, context, { filename: page });
  return context;
}

function element() {
  return {
    innerHTML: '', textContent: '',
    classList: { add() {}, remove() {} },
    addEventListener(_event, callback) { this.onClick = callback; },
    contains() { return true; },
  };
}

const nodes = new Map();
const document = { getElementById(id) {
  if (!nodes.has(id)) nodes.set(id, element());
  return nodes.get(id);
} };
const talentsPage = loadPage('talents.html', document);
const injection = "');globalThis.injected=true;//<img src=x onerror=alert(1)>";
talentsPage.render([{
  _id: 'stu-test', name: injection, school: injection, major: '统计',
  talentIndex: 50, skillTags: [injection],
}]);
const cards = document.getElementById('list').innerHTML;
assert.ok(!cards.includes('<img'));
assert.ok(!cards.includes('onclick="openInvite'));
assert.ok(!cards.includes("');globalThis.injected"));
assert.ok(cards.includes('&#39;'));

const inviteButton = { getAttribute(key) { return { 'data-index': '0', 'data-talent-action': 'invite' }[key]; } };
document.getElementById('list').onClick({ target: { closest: () => inviteButton } });
assert.equal(document.getElementById('invite-title').textContent, `邀约 ${injection}`);
assert.equal(talentsPage.currentUid, 'stu-test');
assert.equal(talentsPage.injected, undefined);

const archiveNodes = new Map();
const archiveDocument = { getElementById(id) {
  if (!archiveNodes.has(id)) archiveNodes.set(id, element());
  return archiveNodes.get(id);
} };
const archivePage = loadPage('index.html', archiveDocument);
archivePage.render({
  user: { name: '学生', school: '学校', major: '专业', talentIndex: 10, skillTags: [injection] },
  certifications: [], works: [],
  evaluations: [{ companyName: injection, content: injection, score: '9<img src=x>' }],
});
for (const id of ['skills', 'evals']) {
  const html = archiveDocument.getElementById(id).innerHTML;
  assert.ok(!html.includes('<img'), `${id} contains unescaped HTML`);
  assert.ok(html.includes('&lt;img'), `${id} lost the visible text`);
}
console.log('legacy enterprise HTML output encoding tests passed');
