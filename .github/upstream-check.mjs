// Daily upstream watcher for dsh-v4flash-tiler.
// Compares the latest commit of each watched path in deepseek-ai/deepseek-harness
// against .github/upstream-baseline.json. On changes: writes .github/UPSTREAM_CHANGES.md
// (the issue body) and updates the baseline file. No changes: removes any stale
// marker and leaves the baseline untouched.
import fs from 'node:fs';

const REPO = 'deepseek-ai/deepseek-harness';
const BASELINE = '.github/upstream-baseline.json';
const MARKER = '.github/UPSTREAM_CHANGES.md';

const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const results = [];
let any = false;

for (const [path, prevSha] of Object.entries(baseline.paths)) {
  const url = `https://api.github.com/repos/${REPO}/commits?path=${encodeURIComponent(path)}&per_page=1`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': 'dsh-upstream-check', accept: 'application/vnd.github+json' },
    });
  } catch (error) {
    console.log(`WARN fetch ${path}: ${String(error)}`);
    continue;
  }
  if (!res.ok) {
    console.log(`WARN fetch ${path}: HTTP ${res.status}`);
    continue;
  }
  const commits = await res.json();
  const commit = commits && commits[0];
  const sha = commit && commit.sha;
  if (typeof sha !== 'string') continue;
  if (sha === prevSha) {
    console.log(`ok ${path} @ ${sha.slice(0, 7)}`);
    continue;
  }
  any = true;
  results.push({
    path,
    from: prevSha,
    to: sha,
    message: ((commit.commit && commit.commit.message) || '').split('\n')[0],
    date: (commit.commit && commit.commit.committer && commit.commit.committer.date) || '',
  });
}

if (!any) {
  console.log('no upstream changes');
  try {
    fs.rmSync(MARKER, { force: true });
  } catch {}
  process.exit(0);
}

const lines = results
  .map((r) => `- \`${r.path}\`\n  - \`${r.to.slice(0, 7)}\` (${r.date}) — ${r.message}\n  - previous: \`${r.from.slice(0, 7)}\``)
  .join('\n');
const body = [
  `上游 [${REPO}](https://github.com/${REPO}) 的以下接口/文档有更新（与本插件相关）：`,
  '',
  lines,
  '',
  '请评估 dsh-v4flash-tiler 的兼容性（agent/pre-step 瀑布、attachments、sandboxPolicy、shell 约束、dsh.bundle 发布规范等），必要时更新插件代码。',
  '',
  '> 由 daily upstream check 自动创建。',
].join('\n');
fs.writeFileSync(MARKER, body);

for (const r of results) baseline.paths[r.path] = r.to;
fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n');
console.log(`changed paths: ${results.map((r) => r.path).join(', ')}`);
