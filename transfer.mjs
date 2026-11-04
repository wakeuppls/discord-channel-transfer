import { readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const API = 'https://discord.com/api/v10';

export function parseArgs(args) {
  const options = { state: '.transfer-state.json', limit: Infinity, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--dry-run') options.dryRun = true;
    else if (['--source', '--target', '--state', '--limit'].includes(key)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Нет значения для ${key}`);
      options[key.slice(2)] = value;
    } else throw new Error(`Неизвестный параметр: ${key}`);
  }
  for (const key of ['source', 'target']) {
    if (!/^\d{17,20}$/.test(options[key] ?? '')) throw new Error(`Укажите --${key} ID_КАНАЛА`);
  }
  if (options.source === options.target) throw new Error('Исходный канал и канал назначения совпадают.');
  if (options.limit !== Infinity) {
    options.limit = Number(options.limit);
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) throw new Error('--limit должен быть положительным целым числом.');
  }
  return options;
}

// Discord counts UTF-16 units; avoid cutting a surrogate pair in half.
export function splitText(text, size = 1900) {
  const chunks = [];
  while (text.length) {
    let end = Math.min(size, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    chunks.push(text.slice(0, end));
    text = text.slice(end);
  }
  return chunks;
}

export function messageParts(message) {
  const author = message.author?.global_name || message.author?.username || 'Неизвестный автор';
  const header = `${author} · ${new Date(message.timestamp).toISOString()}\n`;
  const links = new Set();
  for (const embed of message.embeds ?? []) {
    for (const url of [embed.url, embed.image?.url, embed.video?.url]) {
      if (url && !message.content?.includes(url)) links.add(url);
    }
  }
  for (const sticker of message.sticker_items ?? []) {
    // Lottie stickers cannot be represented as a normal image.
    if (sticker.format_type !== 3) links.add(`https://cdn.discordapp.com/stickers/${sticker.id}.${sticker.format_type === 4 ? 'gif' : 'png'}`);
    else links.add(`[Стикер: ${sticker.name}]`);
  }
  const body = [message.content || '', ...links].filter(Boolean).join('\n');
  const attachments = message.attachments ?? [];
  if (!body && !attachments.length) {
    if ([0, 19].includes(message.type)) {
      throw new Error(`Сообщение ${message.id} не содержит доступного текста/вложений. Проверьте Message Content Intent; опросы и пересланные сообщения не поддерживаются.`);
    }
    return [];
  }
  return [
    ...splitText(header + body).map(content => ({ content })),
    ...attachments.map(attachment => ({ attachment })),
  ];
}

export function partsSignature(parts) {
  return createHash('sha256').update(JSON.stringify(parts.map(part => part.attachment
    ? { attachment: { id: part.attachment.id, filename: part.attachment.filename,
      size: part.attachment.size, description: part.attachment.description } }
    : part))).digest('hex');
}

async function loadToken() {
  if (process.env.DISCORD_BOT_TOKEN?.trim()) return process.env.DISCORD_BOT_TOKEN.trim();
  let env;
  try { env = await readFile('.env', 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const match = env?.match(/^\s*DISCORD_BOT_TOKEN\s*=\s*(.*?)\s*$/m);
  const token = match?.[1]?.replace(/^(['"])(.*)\1$/, '$2').trim();
  if (!token || token === 'PASTE_BOT_TOKEN_HERE') throw new Error('Заполните DISCORD_BOT_TOKEN в .env (см. README.md).');
  return token;
}

export function createApi(token) {
  return async function api(path, method = 'GET', bodyFactory) {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetch(API + path, {
          method,
          headers: { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (local-channel-transfer, 1.0)' },
          body: bodyFactory?.(),
          signal: AbortSignal.timeout(120_000),
        });
      } catch {
        throw new Error(`${method} ${path}: соединение прервано. При отправке результат мог сохраниться в Discord; проверьте последнее сообщение перед повторным запуском.`);
      }
      if (response.status === 429 && attempt < 20) {
        const data = await response.json();
        await sleep(Math.max(1000, Number(data.retry_after || 1) * 1000) + 250);
        continue;
      }
      if (method === 'GET' && response.status >= 500 && attempt < 4) {
        await response.arrayBuffer();
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        // Do not print Discord's response body: it may echo private content.
        throw new Error(`${method} ${path}: HTTP ${response.status}. 401: токен; 403: права; 413: размер файла. При ошибке отправки 5xx проверьте, не появилось ли сообщение.`);
      }
      return response.json();
    }
  };
}

async function sendPart(api, target, part) {
  const form = new FormData();
  const payload = { allowed_mentions: { parse: [], replied_user: false } };
  if (part.attachment) {
    const attachment = part.attachment;
    const response = await fetch(attachment.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Не удалось скачать вложение ${attachment.id}: HTTP ${response.status}`);
    const filename = attachment.filename;
    payload.attachments = [{ id: 0, filename, description: attachment.description ?? undefined }];
    form.append('files[0]', await response.blob(), filename);
  } else payload.content = part.content;
  form.append('payload_json', JSON.stringify(payload));
  return api(`/channels/${target}/messages`, 'POST', () => form);
}

export async function transfer(options) {
  const api = createApi(await loadToken());
  const statePath = resolve(options.state);
  const lockPath = statePath + '.lock';
  let lock;
  try {
    if (!options.dryRun) {
      try { lock = await open(lockPath, 'wx'); }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error(`Есть файл блокировки ${lockPath}. Закройте другой запуск; после аварийного завершения удалите этот .lock вручную.`);
        throw error;
      }
      await lock.writeFile(String(process.pid));
    }
    let state = { version: 1, routes: {} };
    try { state = JSON.parse(await readFile(statePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (state.version !== 1 || !state.routes) throw new Error('Неизвестный формат файла прогресса.');
    const routeKey = `${options.source}:${options.target}`;
    const route = state.routes[routeKey] ??= { lastId: '0', pending: null };
    const save = async () => {
      if (options.dryRun) return;
      await writeFile(statePath + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
      await rename(statePath + '.tmp', statePath);
    };
    const source = await api(`/channels/${options.source}`);
    const target = await api(`/channels/${options.target}`);
    if (![source, target].every(channel => channel.type === 0 && channel.guild_id)) {
      throw new Error('Поддерживаются обычные текстовые каналы серверов. Укажите ID канала, а не сервера, категории, форума или личного чата.');
    }
    console.log(`${options.dryRun ? 'ПРОВЕРКА' : 'КОПИРОВАНИЕ'}: #${source.name} → #${target.name}`);
    // Freeze the upper bound: new messages wait until the next run.
    const upper = ((BigInt(Date.now()) - 1420070400000n) << 22n).toString();
    let cursor = route.lastId;
    let count = 0;
    while (count < options.limit) {
      const messages = await api(`/channels/${options.source}/messages?limit=100&after=${cursor}`);
      if (!messages.length) break;
      messages.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
      for (const message of messages) {
        if (BigInt(message.id) >= BigInt(upper) || count >= options.limit) return console.log(`Обработано: ${count}.`);
        const parts = messageParts(message);
        const signature = partsSignature(parts);
        if (route.pending && (route.pending.id !== message.id || route.pending.signature !== signature)) {
          throw new Error('Незавершённое сообщение было изменено или удалено. Проверьте его копию и файл прогресса перед продолжением.');
        }
        if (!options.dryRun) {
          route.pending ??= { id: message.id, signature, done: 0 };
          await save();
          for (let i = route.pending.done; i < parts.length; i++) {
            if (parts[i].attachment?.size > 10 * 1024 * 1024) {
              console.log(`Вложение ${parts[i].attachment.filename}: ${(parts[i].attachment.size / 1024 / 1024).toFixed(1)} МБ; Discord может отклонить загрузку.`);
            }
            await sendPart(api, options.target, parts[i]);
            route.pending.done = i + 1;
            await save();
            await sleep(500);
          }
          route.lastId = message.id;
          route.pending = null;
          await save();
        }
        cursor = message.id;
        count++;
        console.log(`${options.dryRun ? 'Проверено' : 'Обработано'} ${message.id}: частей ${parts.length}`);
      }
    }
    console.log(`Готово. Обработано: ${count}.`);
  } finally {
    if (lock) { await lock.close(); await unlink(lockPath); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve().then(() => transfer(parseArgs(process.argv.slice(2)))).catch(error => {
    console.error(`Ошибка: ${error.message}`);
    process.exitCode = 1;
  });
}
