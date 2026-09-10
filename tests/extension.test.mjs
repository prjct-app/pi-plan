import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import planMode from '../src/index.ts';

const theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  strikethrough: (text) => text,
};

function harness({ flag = false, savedEntries = [], customResult = 'execute' } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const renderers = new Map();
  const statuses = new Map();
  const widgets = new Map();
  const notifications = [];
  const messages = [];
  const entries = [...savedEntries];
  const events = new EventEmitter();
  let tools = ['read', 'bash', 'edit', 'write', 'ask_user', 'custom_read'];

  const pi = {
    events,
    registerFlag() {},
    registerShortcut() {},
    getFlag: () => flag,
    registerCommand: (name, command) => commands.set(name, command),
    registerMessageRenderer: (customType, renderer) => renderers.set(customType, renderer),
    registerEntryRenderer: (customType, renderer) => renderers.set(customType, renderer),
    on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    getActiveTools: () => [...tools],
    setActiveTools: (value) => { tools = [...value]; },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    sendMessage: (message, options) => messages.push({ message, options }),
    sendUserMessage: (content, options) => messages.push({ user: content, options }),
  };

  const ctx = {
    mode: 'tui',
    hasUI: true,
    sessionManager: { getBranch: () => entries, getEntries: () => entries },
    ui: {
      theme,
      notify: (message, type) => notifications.push({ message, type }),
      setStatus: (key, value) => value === undefined ? statuses.delete(key) : statuses.set(key, value),
      setWidget: (key, value) => value === undefined ? widgets.delete(key) : widgets.set(key, value),
      select: async () => undefined,
      custom: async () => customResult,
      editor: async () => undefined,
    },
  };

  planMode(pi);

  return {
    ctx,
    events,
    entries,
    messages,
    notifications,
    renderers,
    statuses,
    widgets,
    activeTools: () => [...tools],
    run: (name, args = '') => commands.get(name).handler(args, ctx),
    renderWidget(key, width = 80) {
      const value = widgets.get(key);
      if (typeof value === 'function') return value({ requestRender() {} }, theme).render(width);
      return value;
    },
    async emit(name, event = {}) {
      let result;
      for (const handler of handlers.get(name) ?? []) {
        const next = await handler(event, ctx);
        if (next !== undefined) result = next;
      }
      return result;
    },
  };
}

test('/plan disables write tools and blocks destructive bash without touching themes', async () => {
  const h = harness();
  h.ctx.ui.setTheme = () => { throw new Error('Plan mode must not manage themes'); };
  await h.run('plan');
  assert.equal(h.statuses.get('plan-mode'), '⏸ plan');
  assert.deepEqual(h.activeTools(), ['read', 'bash', 'ask_user', 'custom_read']);

  const blocked = await h.emit('tool_call', { toolName: 'bash', input: { command: 'rm fixture.txt' } });
  assert.equal(blocked.block, true);
  assert.equal(await h.emit('tool_call', { toolName: 'bash', input: { command: 'git status' } }), undefined);

  await h.run('plan');
  assert.equal(h.statuses.has('plan-mode'), false);
  assert.deepEqual(h.activeTools(), ['read', 'bash', 'edit', 'write', 'ask_user', 'custom_read']);
});

test('plan mode blocks edit and write defensively even if re-added', async () => {
  const h = harness();
  await h.run('plan');
  for (const toolName of ['edit', 'write']) {
    const blocked = await h.emit('tool_call', { toolName, input: {} });
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /disabled/);
  }
});

test('a numbered plan becomes tracked execution only after dialog approval', async () => {
  const h = harness();
  await h.run('plan');
  await h.emit('agent_end', {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: '**Goal:** ship it\n\nPlan:\n1. Inspect the implementation\n2. Run tests\n\n**Verify:** npm test' }] }],
  });

  assert.equal(h.statuses.get('plan-mode'), '▸ plan 0/2');
  assert.ok(h.widgets.has('plan-todos'));
  assert.ok(h.activeTools().includes('edit'));

  const listEntry = h.entries.find((e) => e.customType === 'plan-todo-list');
  assert.equal(listEntry.data.steps.length, 2);
  assert.equal(listEntry.data.verify, 'npm test');

  const execMessage = h.messages.at(-1);
  assert.equal(execMessage.message.customType, 'plan-mode-execute');
  assert.match(execMessage.message.content, /starting with step 1: Inspect the implementation/);
  assert.match(execMessage.message.content, /verify with: npm test/);

  const widgetLines = h.renderWidget('plan-todos');
  assert.match(widgetLines[0], /▸ Plan 0\/2/);
  assert.match(widgetLines.at(-1), /Verify: npm test/);

  await h.emit('turn_end', {
    message: { role: 'assistant', content: [{ type: 'text', text: 'Inspected. [DONE:1]' }] },
  });
  assert.equal(h.statuses.get('plan-mode'), '▸ plan 1/2');
  assert.match(h.renderWidget('plan-todos')[0], /▸ Plan 1\/2/);
});

test('completing every step sends a plan-complete message with details', async () => {
  const h = harness();
  await h.run('plan');
  await h.emit('agent_end', {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Inspect the code\n2. Run tests' }] }],
  });
  await h.emit('turn_end', { message: { role: 'assistant', content: [{ type: 'text', text: '[DONE:1] [DONE:2]' }] } });
  await h.emit('agent_end', { messages: [] });

  const complete = h.entries.find((e) => e.customType === 'plan-complete');
  assert.equal(complete.data.steps.every((s) => s.completed), true);
  assert.equal(h.messages.some((m) => m.message.customType === 'plan-complete'), false);
  assert.equal(h.statuses.has('plan-mode'), false);
  assert.equal(h.widgets.has('plan-todos'), false);
});

test('staying or discarding from the review dialog keeps or drops the plan', async () => {
  const stay = harness({ customResult: null });
  await stay.run('plan');
  await stay.emit('agent_end', {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Inspect the code' }] }],
  });
  assert.equal(stay.statuses.get('plan-mode'), '⏸ plan · 1 steps ready');
  assert.equal(stay.activeTools().includes('edit'), false);

  const discard = harness({ customResult: 'discard' });
  await discard.run('plan');
  await discard.emit('agent_end', {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Inspect the code' }] }],
  });
  assert.equal(discard.statuses.has('plan-mode'), false);
  assert.ok(discard.activeTools().includes('edit'));
  assert.match(discard.notifications.at(-1).message, /discarded/);
});

test('the public event bus lets workflow packages activate plan mode', () => {
  const h = harness();
  const request = { ctx: h.ctx, source: '/work' };
  h.events.emit('plan-mode:enable', request);
  assert.equal(request.handled, true);
  assert.equal(h.statuses.get('plan-mode'), '⏸ plan');
  assert.equal(h.activeTools().includes('write'), false);
  assert.match(h.notifications.at(-1).message, /enabled by \/work/);
});

test('persisted plan state restores on session start and clears UI on shutdown', async () => {
  const first = harness();
  await first.run('plan');
  const resumed = harness({ savedEntries: first.entries });
  await resumed.emit('session_start', { reason: 'resume' });
  assert.equal(resumed.statuses.get('plan-mode'), '⏸ plan');
  assert.equal(resumed.activeTools().includes('edit'), false);

  await resumed.emit('session_shutdown', { reason: 'quit' });
  assert.equal(resumed.statuses.has('plan-mode'), false);
  assert.equal(resumed.widgets.has('plan-todos'), false);
});

test('context filtering keeps only the latest instruction copy for the active mode', async () => {
  const h = harness();
  const olderPlan = { role: 'user', customType: 'plan-mode-context', content: 'plan v1' };
  const newerPlan = { role: 'user', customType: 'plan-mode-context', content: 'plan v2' };
  const execMsg = { role: 'user', customType: 'plan-execution-context', content: 'exec' };
  const kickoff = { role: 'user', customType: 'plan-mode-execute', content: 'kickoff' };
  const normal = { role: 'user', content: 'hello' };

  const filter = async () => (await h.emit('context', { messages: [olderPlan, execMsg, kickoff, newerPlan, normal] })).messages;

  // Idle: instruction messages never reach the model.
  assert.deepEqual((await filter()).map((m) => m.content), ['hello']);

  // Planning: only the newest plan instruction survives; execution leftovers drop.
  await h.run('plan');
  assert.deepEqual((await filter()).map((m) => m.content), ['plan v2', 'hello']);
});

test('/todos notifies when empty and opens a dialog with steps otherwise', async () => {
  const empty = harness();
  await empty.run('todos');
  assert.match(empty.notifications.at(-1).message, /No plan steps/);

  const h = harness({ customResult: null });
  await h.run('plan');
  await h.emit('agent_end', {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Inspect the code' }] }],
  });
  // The review dialog already consumed one custom() call; /todos opens another.
  await h.run('todos');
  assert.equal(h.notifications.length, 1); // only the plan-mode notification, no fallback notify
});

test('plan-todo-list renderer shows a collapsed summary and expanded steps', async () => {
  const h = harness();
  const renderer = h.renderers.get('plan-todo-list');
  const details = { steps: [{ step: 1, text: 'Inspect the code', completed: false }], verify: 'npm test' };

  const collapsedView = renderer({ data: details }, { expanded: false }, theme);
  assert.match(collapsedView.render(80)[0], /▸ Plan · 1 step · Ctrl\+O details/);

  const expandedView = renderer({ data: details }, { expanded: true }, theme);
  const lines = expandedView.render(80).join('\n');
  assert.match(lines, /1\. ○ Inspect the code/);
  assert.match(lines, /Verify: npm test/);
});

test('plan-complete and plan-mode-execute renderers summarize and expand', () => {
  const h = harness();
  const details = { steps: [{ step: 1, text: 'Inspect the code', completed: true }] };

  const complete = h.renderers.get('plan-complete');
  assert.match(complete({ data: details }, { expanded: false }, theme).render(80)[0], /▸ Plan complete ✓ · 1\/1/);
  assert.match(complete({ data: details }, { expanded: true }, theme).render(80).join('\n'), /✓ Inspect the code/);

  const execute = h.renderers.get('plan-mode-execute');
  assert.match(execute({ details }, { expanded: false }, theme).render(80)[0], /▸ Execute plan/);
});

test('the execution context injection lists only remaining steps', async () => {
  const h = harness();
  await h.run('plan');
  await h.emit('agent_end', {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Inspect the code\n2. Run tests' }] }],
  });
  await h.emit('turn_end', { message: { role: 'assistant', content: [{ type: 'text', text: '[DONE:1]' }] } });

  const injection = await h.emit('before_agent_start');
  assert.match(injection.message.content, /Progress: 1\/2 steps complete/);
  assert.match(injection.message.content, /2\. Run tests/);
  assert.doesNotMatch(injection.message.content, /1\. Inspect the code/);
});
