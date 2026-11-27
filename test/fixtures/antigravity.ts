import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../../src/types.ts';
import { makeMachine } from '../helpers.ts';

const FAKE_ACP_SCRIPT = `#!/usr/bin/env bun
import { mkdirSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.argv.includes('--version')) {
  console.log('1.5.14');
  process.exit(0);
}

const dataDirMarker = join(process.cwd(), '.fake-data-dir');
const dataDir = existsSync(dataDirMarker) ? readFileSync(dataDirMarker, 'utf8').trim() : undefined;
const state = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  model: 'gemini-4-neon',
  thought: 'high',
  mode: 'default',
  cancelled: false,
  pendingReqId: 100,
};

function configOptions() {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: state.model,
      options: [
        { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
        { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      ],
    },
    {
      id: 'thought_level',
      name: 'Thinking Level',
      category: 'thought_level',
      type: 'select',
      currentValue: state.thought,
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: state.mode,
      options: [
        { value: 'default', name: 'Default' },
        { value: 'accept-edits', name: 'Accept edits' },
        { value: 'auto', name: 'Auto' },
        { value: 'plan', name: 'Plan' },
      ],
    },
  ];
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}

const pendingHost = new Map();

function writeTranscript(line) {
  if (!dataDir) return;
  const dir = join(dataDir, 'brain', state.sessionId, '.system_generated', 'logs');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'transcript.jsonl'), JSON.stringify(line) + '\\n');
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf('\\n');
    if (nl < 0) break;
    const raw = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!raw) continue;
    const msg = JSON.parse(raw);
    if (msg.id !== undefined && msg.method === undefined) {
      const resolve = pendingHost.get(msg.id);
      if (resolve) {
        pendingHost.delete(msg.id);
        resolve(msg.result);
      }
      continue;
    }
    void handle(msg);
  }
});

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'antigravity-cli', version: '1.5.14' },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true },
          sessionCapabilities: { load: {}, resume: {}, close: {} },
        },
      },
    });
    return;
  }
  if (method === 'session/new') {
    send({ jsonrpc: '2.0', id, result: { sessionId: state.sessionId, configOptions: configOptions() } });
    return;
  }
  if (method === 'session/resume' || method === 'session/load') {
    state.sessionId = params.sessionId;
    send({ jsonrpc: '2.0', id, result: { configOptions: configOptions() } });
    return;
  }
  if (method === 'session/set_config_option') {
    if (params.configId === 'model') state.model = params.value;
    if (params.configId === 'thought_level') state.thought = params.value;
    if (params.configId === 'mode') state.mode = params.value;
    send({ jsonrpc: '2.0', id, result: { configOptions: configOptions() } });
    return;
  }
  if (method === 'session/close') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'session/cancel') {
    state.cancelled = true;
    return;
  }
  if (method === 'session/prompt') {
    state.cancelled = false;
    const text = (params.prompt ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    const images = (params.prompt ?? []).filter((b) => b.type === 'image').length;
    writeTranscript({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: new Date().toISOString(),
      content: text,
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: state.sessionId,
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
      },
    });
    if (text.includes('NEED_APPROVAL')) {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: state.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            title: 'write_file',
            name: 'write_file',
            rawInput: { path: 'a.txt' },
          },
        },
      });
      const reqId = ++state.pendingReqId;
      const decision = await new Promise((resolve) => {
        pendingHost.set(reqId, resolve);
        send({
          jsonrpc: '2.0',
          id: reqId,
          method: 'session/request_permission',
          params: {
            sessionId: state.sessionId,
            toolCall: { toolCallId: 'call-1', title: 'write_file', name: 'write_file' },
            options: [
              { optionId: 'allow', kind: 'allow_once' },
              { optionId: 'deny', kind: 'reject_once' },
            ],
          },
        });
      });
      const approved = decision?.outcome?.optionId === 'allow';
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: state.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-1',
            status: approved ? 'completed' : 'failed',
            rawOutput: { approved },
          },
        },
      });
    }
    if (text.includes('HOLD_FOR_CANCEL')) {
      for (let i = 0; i < 60 && !state.cancelled; i++) {
        await Bun.sleep(50);
      }
      send({ jsonrpc: '2.0', id, result: { stopReason: state.cancelled ? 'cancelled' : 'end_turn' } });
      return;
    }
    const reply = \`model=\${state.model};effort=\${state.thought};mode=\${state.mode};images=\${images}\`;
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: state.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } },
      },
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: state.sessionId,
        update: { sessionUpdate: 'usage_update', used: 1200, size: 100000 },
      },
    });
    writeTranscript({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date().toISOString(),
      model: state.model,
      input_tokens: 10,
      output_tokens: 5,
      thinking: 'thinking',
      content: reply,
    });
    send({
      jsonrpc: '2.0',
      id,
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 2 },
      },
    });
  }
}
`;

export function antigravityFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-agy-test-'));
  const binPath = join(dir, 'agy');
  const dataDir = join(dir, 'agy-data');
  const stateDir = join(dir, 'state');
  const workspace = join(dir, 'work');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(dataDir, 'installation_id'), 'test-install-id\n');
  writeFileSync(join(workspace, '.fake-data-dir'), dataDir);
  writeFileSync(binPath, FAKE_ACP_SCRIPT, 'utf8');
  chmodSync(binPath, 0o755);

  const m = makeMachine({
    claudeBin: '/bin/sh',
    tmuxBin: '/bin/sh',
    antigravityBin: binPath,
    antigravityDataDir: dataDir,
    projectsDir: join(dir, 'claude-projects'),
    stateDir,
    rcPrefix: 'host-a',
    externalInventory: false,
    autoUpdate: false,
    chatEnabled: true,
  });

  const session: Session = {
    name: 'agy-1',
    dir: workspace,
    uuid: crypto.randomUUID(),
    registrationGeneration: crypto.randomUUID(),
    flags: [],
    archived: false,
    resumeText: 'continue',
    agent: 'antigravity',
    runtime: 'native',
    promptModules: [],
  };

  return { dir, binPath, dataDir, stateDir, workspace, m, session };
}
