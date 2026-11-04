import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, splitText, messageParts, partsSignature, transfer } from './transfer.mjs';

const source = '111111111111111111';
const target = '222222222222222222';
const message = {
  id: '333333333333333333', type: 0, timestamp: '2020-01-01T00:00:00Z',
  author: { username: 'Test' }, content: 'Привет @everyone',
  attachments: [{ id: '444444444444444444', filename: 'photo.png', size: 3, url: 'https://cdn.discordapp.com/test?signature=one' }],
};

test('CLI rejects identical channels and invalid limits', () => {
  assert.throws(() => parseArgs(['--source', source, '--target', source]));
  assert.throws(() => parseArgs(['--source', source, '--target', target, '--limit', '0']));
  assert.equal(parseArgs(['--source', source, '--target', target, '--dry-run']).dryRun, true);
});

test('long Unicode text is preserved without broken surrogate pairs', () => {
  const text = 'а'.repeat(1899) + '😀'.repeat(2000);
  const chunks = splitText(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(chunk => chunk.length <= 1900 && !/[\uD800-\uDBFF]$/.test(chunk)));
});

test('resume signature ignores CDN URL expiration but detects edited text', () => {
  const edited = structuredClone(message);
  edited.attachments[0].url += 'new';
  assert.equal(partsSignature(messageParts(message)), partsSignature(messageParts(edited)));
  edited.content += '!';
  assert.notEqual(partsSignature(messageParts(message)), partsSignature(messageParts(edited)));
  assert.throws(() => messageParts({ ...message, content: '', attachments: [] }));
});

test('dry run, failed attachment, and restart preserve progress without repeating text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'discord-transfer-'));
  const state = join(directory, 'state.json');
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = 'test-token';
  const sent = [];
  let failDownload = true;
  globalThis.fetch = async (url, options = {}) => {
    if (url.startsWith('https://cdn.discordapp.com/')) {
      return failDownload ? new Response('', { status: 503 }) : new Response('png');
    }
    if (options.method === 'POST') {
      sent.push({ payload: JSON.parse(options.body.get('payload_json')), file: options.body.get('files[0]') });
      return Response.json({ id: String(sent.length) });
    }
    if (url.includes('/messages?')) {
      const after = new URL(url).searchParams.get('after');
      return Response.json(BigInt(after) < BigInt(message.id) ? [message] : []);
    }
    return Response.json({ type: 0, guild_id: source, name: 'test' });
  };
  try {
    const options = { source, target, state, limit: Infinity, dryRun: true };
    await transfer(options);
    assert.equal(sent.length, 0);
    await assert.rejects(readFile(state), { code: 'ENOENT' });
    options.dryRun = false;
    await assert.rejects(transfer(options), /503/);
    assert.equal(sent.length, 1);
    assert.equal(JSON.parse(await readFile(state, 'utf8')).routes[`${source}:${target}`].pending.done, 1);
    // Simulate a refreshed signed URL while resuming a partially copied message.
    message.attachments[0].url += '&refreshed=1';
    failDownload = false;
    await transfer(options);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].file.name, 'photo.png');
    assert.deepEqual(sent[0].payload.allowed_mentions.parse, []);
    await transfer(options);
    assert.equal(sent.length, 2);
    // A corrupted checkpoint must never silently reset progress.
    await writeFile(state, '{broken');
    await assert.rejects(transfer(options), SyntaxError);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = originalToken;
    await rm(directory, { recursive: true, force: true });
  }
});
