import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import planMode from '../src/index.ts';

function harness({ flag = false, savedEntries = [], choice = 'Execute the plan (track progress)' } = {}) {
  const handlers = new Map();
  const commands = new Map();
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
    sessionManager: { getEntries: () => entries },
    ui: {
      theme: {
        fg: (_color, text) => text,
        strikethrough: (text) => text,
      },
      notify: (message, type) => notifications.push({ message, type }),
      setStatus: (key, value) => value === undefined ? statuses.delete(key) : statuses.set(key, value),
      setWidget: (key, value) => value === undefined ? widgets.delete(key) : widgets.set(key, value),
      select: async () => choice,
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
    statuses,
    widgets,
    activeTools: () => [...tools],
    run: (name, args = '') => commands.get(name).handler(args, ctx),
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

test('/plan uses documented tool and status APIs without touching themes', async () => {
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

test('a numbered plan becomes tracked execution only after user selection', async () => {
  const h = harness();
  await h.run('plan');
  await h.emit('agent_end', {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Plan:\n1. Inspect the implementation\n2. Run tests' }] }],
  });

  assert.equal(h.statuses.get('plan-mode'), '📋 0/2');
  assert.ok(h.widgets.has('plan-todos'));
  assert.ok(h.activeTools().includes('edit'));
  assert.match(h.messages.at(-1).message.content, /Start with: Inspect the implementation/);

  await h.emit('turn_end', {
    message: { role: 'assistant', content: [{ type: 'text', text: 'Inspected. [DONE:1]' }] },
  });
  assert.equal(h.statuses.get('plan-mode'), '📋 1/2');
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
