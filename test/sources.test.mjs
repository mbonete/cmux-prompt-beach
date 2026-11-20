import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createRepoKindCache, detectRepoKind } from '../server/repo-kind.mjs';
import { CONVERSATION_LIMITS, extractConversation, humanPromptOf } from '../server/sources/claude-transcripts.mjs';
import { hookTick } from '../server/sources/cmux.mjs';
import { tickTool, toolCategory } from '../server/tools.mjs';

describe('tool categories', () => {
  test('Claude Code tool names', () => {
    const expect = {
      Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
      Bash: 'command',
      Grep: 'search', Glob: 'search',
      WebFetch: 'web', WebSearch: 'web',
      Read: 'read',
      Task: 'other', Agent: 'other', TodoWrite: 'other', AskUserQuestion: 'other', ExitPlanMode: 'other', Skill: 'other',
      mcp__claude_ai_Google_Drive__search_files: 'other',
      '': 'other', bash: 'other',
    };
    for (const [name, category] of Object.entries(expect)) assert.equal(toolCategory(name), category, name);
  });

  test('tick tool: pretty MCP names, nothing for a missing name', () => {
    assert.deepEqual(tickTool('Edit'), { name: 'Edit', category: 'edit' });
    assert.deepEqual(tickTool('mcp__claude_ai_Linear__list_issues'), { name: 'Linear · list_issues', category: 'other' });
    assert.equal(tickTool(null), null);
    assert.equal(tickTool(''), null);
  });

  // Shapes copied from `cmux events` output (cmux 0.65.2), with ids shortened.
  const hook = (name, payload) => ({ type: 'event', category: 'agent', name: `agent.hook.${name}`, id: 'e1', surface_id: 'S1', payload: { hook_event_name: name, surface_id: 'S1', _opencode_request_id: 'r1', tool_input: null, redacted_fields: ['tool_input', 'context', 'extra_fields'], ...payload } });

  test('PreToolUse ticks carry the tool; other hooks do not', () => {
    assert.deepEqual(hookTick(hook('PreToolUse', { tool_name: 'Bash', phase: 'received' })), { surfaceId: 'S1', hook: 'PreToolUse', tool: { name: 'Bash', category: 'command' } });
    assert.deepEqual(hookTick(hook('PreToolUse', { tool_name: 'WebFetch' })).tool, { name: 'WebFetch', category: 'web' });
    assert.deepEqual(hookTick(hook('PostToolUse', { tool_name: 'PushNotification' })).tool, { name: 'PushNotification', category: 'other' });
    assert.deepEqual(hookTick(hook('Stop', { tool_name: null })), { surfaceId: 'S1', hook: 'Stop' });
    assert.deepEqual(hookTick(hook('PermissionRequest', { tool_name: 'Bash' })), { surfaceId: 'S1', hook: 'PermissionRequest' });
    assert.deepEqual(hookTick(hook('PreToolUse', {})), { surfaceId: 'S1', hook: 'PreToolUse' });
    assert.equal(hookTick({ name: 'agent.hook.Stop', payload: {} }), null, 'no surface, no tick');
  });
});

describe('repo kind', () => {
  let tmp;
  const repo = async (name, files = {}, dirs = []) => {
    const root = path.join(tmp, name);
    await mkdir(root, { recursive: true });
    for (const d of dirs) await mkdir(path.join(root, d), { recursive: true });
    for (const [f, content] of Object.entries(files)) await writeFile(path.join(root, f), typeof content === 'string' ? content : JSON.stringify(content));
    return root;
  };
  const pkg = (deps, devDeps = {}) => ({ name: 'x', dependencies: deps, devDependencies: devDeps });

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'sb-kind-'));
  });
  after(() => rm(tmp, { recursive: true, force: true }));

  test('web', async () => {
    assert.equal(await detectRepoKind(await repo('next', { 'package.json': pkg({ next: '15', react: '19' }) })), 'web');
    assert.equal(await detectRepoKind(await repo('vite', { 'package.json': pkg({}, { vite: '7' }) })), 'web');
    assert.equal(await detectRepoKind(await repo('svelte', { 'package.json': pkg({ '@sveltejs/kit': '2' }) })), 'web');
    assert.equal(await detectRepoKind(await repo('static', { 'index.html': '<html>' })), 'web');
    assert.equal(await detectRepoKind(await repo('django', { 'requirements.txt': 'Django==5.1\npsycopg\n' })), 'web');
  });

  test('mobile', async () => {
    assert.equal(await detectRepoKind(await repo('expo', { 'package.json': pkg({ expo: '52', react: '19', 'react-native': '0.79' }) })), 'mobile');
    assert.equal(await detectRepoKind(await repo('rn-dirs', { 'package.json': pkg({ react: '19' }) }, ['ios', 'android'])), 'mobile');
    assert.equal(await detectRepoKind(await repo('expo-appjson', { 'app.json': { expo: { name: 'x' } } })), 'mobile');
    assert.equal(await detectRepoKind(await repo('heroku-appjson', { 'app.json': { name: 'x', buildpacks: [] } })), 'other', "Heroku's app.json is not a phone app");
    assert.equal(await detectRepoKind(await repo('flutter', { 'pubspec.yaml': 'name: app\n' })), 'mobile');
    assert.equal(await detectRepoKind(await repo('android-kt', { 'build.gradle.kts': 'plugins {\n  id("com.android.application") version "8.12.0" apply false\n}\n', 'settings.gradle.kts': '' }, ['app'])), 'mobile');
    assert.equal(await detectRepoKind(await repo('jvm', { 'build.gradle.kts': 'plugins { kotlin("jvm") }\n' })), 'other');
  });

  test('docs', async () => {
    assert.equal(await detectRepoKind(await repo('mkdocs', { 'mkdocs.yml': 'site_name: x', 'requirements.txt': 'mkdocs-material\n' })), 'docs');
    assert.equal(await detectRepoKind(await repo('docusaurus', { 'package.json': pkg({ '@docusaurus/core': '3', react: '19' }) })), 'docs', 'a docs generator wins over React');
    assert.equal(await detectRepoKind(await repo('mdbook', { 'book.toml': '[book]' })), 'docs');
    assert.equal(await detectRepoKind(await repo('bookdir', {}, ['book'])), 'docs');
    assert.equal(await detectRepoKind(await repo('prose', { 'README.md': '#', 'chapter-1.md': '#', 'chapter-2.md': '#', 'notes.md': '#' })), 'docs');
  });

  test('data', async () => {
    assert.equal(await detectRepoKind(await repo('nb', { 'analysis.ipynb': '{}' })), 'data');
    assert.equal(await detectRepoKind(await repo('nbdir', { 'README.md': '#' }, ['notebooks'])), 'data');
    assert.equal(await detectRepoKind(await repo('dbt', { 'dbt_project.yml': 'name: x' })), 'data');
    assert.equal(await detectRepoKind(await repo('py-pandas', { 'pyproject.toml': '[project]\ndependencies = ["pandas>=2", "requests"]\n' })), 'data');
    assert.equal(await detectRepoKind(await repo('py-airflow', { 'requirements.txt': 'apache-airflow==2.10\n' })), 'data');
    assert.equal(await detectRepoKind(await repo('py-mkdocs-pandas', { 'pyproject.toml': 'dependencies = ["polars"]', 'mkdocs.yml': 'site_name: x' })), 'data', 'a data library with docs is still data');
  });

  test('other, and nothing outside the root is read', async () => {
    assert.equal(await detectRepoKind(await repo('go', { 'go.mod': 'module x', 'main.go': 'package main' })), 'other');
    assert.equal(await detectRepoKind(await repo('empty')), 'other');
    assert.equal(await detectRepoKind(await repo('readme-only', { 'README.md': '#' })), 'other');
    assert.equal(await detectRepoKind(path.join(tmp, 'missing')), 'other');
    assert.equal(await detectRepoKind('relative/path'), 'other');
    assert.equal(await detectRepoKind(null), 'other');
    // A symlinked package.json pointing outside the repo is ignored.
    const outside = await repo('outside', { 'package.json': pkg({ next: '15' }) });
    const linked = await repo('linked');
    await symlink(path.join(outside, 'package.json'), path.join(linked, 'package.json'));
    await symlink(path.join(outside), path.join(linked, 'ios'));
    assert.equal(await detectRepoKind(linked), 'other');
    // Oversized manifests are skipped rather than read.
    assert.equal(await detectRepoKind(await repo('huge', { 'package.json': `{"dependencies":{"react":"19"},"x":"${'a'.repeat(600 * 1024)}"}` })), 'other');
  });

  test('cached for 10 minutes per root', async () => {
    let t = 0;
    const kind = createRepoKindCache({ now: () => t });
    const root = await repo('cached', { 'package.json': pkg({ react: '19' }) });
    assert.equal(await kind(root), 'web');
    await writeFile(path.join(root, 'package.json'), JSON.stringify(pkg({ expo: '52' })));
    t = 9 * 60 * 1000;
    assert.equal(await kind(root), 'web', 'still cached');
    t = 10 * 60 * 1000 + 1;
    assert.equal(await kind(root), 'mobile', 'refreshed');
    assert.equal(await kind('not/absolute'), 'other');
  });
});

describe('conversation', () => {
  let ts = Date.parse('2026-11-20T10:00:00Z');
  const at = () => new Date((ts += 1000)).toISOString();
  const user = (text, extra = {}) => JSON.stringify({ type: 'user', timestamp: at(), message: { role: 'user', content: text }, ...extra });
  const assistant = (blocks, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: at(), message: { model: 'claude-opus-5-5', content: blocks }, ...extra });
  const text = (t) => ({ type: 'text', text: t });
  const toolUse = (name) => ({ type: 'tool_use', id: `t${ts}`, name, input: {} });
  const toolResult = () => JSON.stringify({ type: 'user', timestamp: at(), message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'output' }] } });

  test('prompts and replies, without tools, context, sidechains or compaction summaries', () => {
    const lines = [
      user('first question'),
      assistant([text('Looking.'), toolUse('Read')]),
      toolResult(),
      assistant([text('Here is the answer.')]),
      assistant([text('Here is the answer.')]), // written twice
      user('<system-reminder>injected</system-reminder>'),
      user('This session is being continued from a previous conversation…', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
      user('a subagent prompt', { isSidechain: true }),
      assistant([text('subagent text')], { isSidechain: true }),
      assistant([text('No response requested.')], { message: { model: '<synthetic>', content: [text('No response requested.')] } }),
      user([{ type: 'text', text: 'second question' }]),
      assistant([text('Second answer.')]),
      'not json',
      '',
    ];
    const { messages, truncated } = extractConversation(lines);
    assert.deepEqual(messages.map((m) => [m.role, m.text]), [
      ['user', 'first question'],
      ['assistant', 'Looking.'],
      ['assistant', 'Here is the answer.'],
      ['user', 'second question'],
      ['assistant', 'Second answer.'],
    ]);
    assert.ok(messages.every((m) => typeof m.at === 'string'));
    assert.equal(truncated, false);
  });

  test('the last 20 turns, the last 3 texts per turn, clipped', () => {
    const lines = [];
    for (let i = 0; i < 25; i += 1) {
      lines.push(user(`prompt ${i}`));
      for (let j = 0; j < 5; j += 1) lines.push(assistant([text(`turn ${i} text ${j}`)]));
    }
    lines.push(user('x'.repeat(5000)));
    lines.push(assistant([text('y'.repeat(9000))]));
    const { messages, truncated } = extractConversation(lines);
    assert.equal(truncated, true);
    assert.equal(messages.filter((m) => m.role === 'user').length, CONVERSATION_LIMITS.turns);
    assert.equal(messages[0].text, 'prompt 6');
    assert.deepEqual(messages.slice(1, 4).map((m) => m.text), ['turn 6 text 2', 'turn 6 text 3', 'turn 6 text 4']);
    const last = messages.slice(-2);
    assert.equal(last[0].text.length, CONVERSATION_LIMITS.userChars);
    assert.equal(last[1].text.length, CONVERSATION_LIMITS.assistantChars);
    assert.ok(last[1].text.endsWith('…'));
  });

  test('a tail that starts mid-turn, and the total size cap', () => {
    const tail = extractConversation([assistant([text('…end of an older turn')]), user('next')], { partial: true });
    assert.equal(tail.truncated, true);
    assert.deepEqual(tail.messages.map((m) => m.role), ['assistant', 'user']);
    const big = [];
    for (let i = 0; i < 20; i += 1) big.push(user(`p${i}`), assistant([text('z'.repeat(3900)), text('w'.repeat(3900))]));
    const capped = extractConversation(big);
    assert.ok(capped.messages.reduce((n, m) => n + m.text.length, 0) <= CONVERSATION_LIMITS.totalChars);
    assert.equal(capped.truncated, true);
    assert.equal(capped.messages.at(-1).text[0], 'w', 'the newest messages are the ones kept');
  });

  test('compaction summaries are not prompts (also for the snapshot)', () => {
    assert.equal(humanPromptOf({ type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { content: 'This session is being continued' } }), null);
    assert.equal(humanPromptOf({ type: 'user', message: { content: 'fix the build' } }), 'fix the build');
  });
});
