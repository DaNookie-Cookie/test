const DEFAULTS = {
  stUrl: 'http://127.0.0.1:8000',
  openStIfMissing: true,
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const missing = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (existing[key] === undefined) missing[key] = value;
  }
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'IMPORT_CHUB_CHARACTER') return;

  handleImport(message.url, sender?.tab?.id)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));

  return true;
});

async function handleImport(pageUrl, sourceTabId) {
  const characterId = parseChubCharacterId(pageUrl);
  if (!characterId) throw new Error('This is not a recognized Chub character URL.');

  const card = await downloadChubCard(characterId);
  const base64 = await blobToBase64(card.blob);
  const fileName = makeFileName(card.fileName || card.characterName || characterId.split('/').pop() || 'character') + '.png';

  const settings = await chrome.storage.local.get(DEFAULTS);
  const stUrl = normalizeBaseUrl(settings.stUrl || DEFAULTS.stUrl);
  const targetTab = await findOrOpenSillyTavernTab(stUrl, settings.openStIfMissing !== false, sourceTabId);

  if (!targetTab?.id) {
    throw new Error(`Open SillyTavern first at ${stUrl}, then click the button again.`);
  }

  const result = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    world: 'MAIN',
    func: importIntoSillyTavern,
    args: [base64, fileName],
  });

  const payload = result?.[0]?.result;
  if (!payload?.ok) throw new Error(payload?.error || 'SillyTavern rejected the character card.');

  return {
    characterFile: payload.fileName || null,
    characterName: payload.characterName || null,
    sillyTavernUrl: stUrl,
  };
}

function parseChubCharacterId(urlString) {
  let url;
  try { url = new URL(urlString); } catch { return null; }

  const host = url.hostname.toLowerCase();
  if (host !== 'chub.ai' && host !== 'www.chub.ai') return null;

  const parts = url.pathname.split('/').filter(Boolean);
  const index = parts.findIndex((part) => part.toLowerCase() === 'characters');
  if (index < 0 || parts.length < index + 3) return null;

  const creator = parts[index + 1];
  const slug = parts[index + 2];
  if (!creator || !slug) return null;

  return `${creator}/${slug}`;
}

/**
 * Chub retired the old POST /api/characters/download route. The current
 * reliable path is: fetch character metadata with ?full=true, obtain the
 * current avatar/card PNG URL, then import that PNG into SillyTavern.
 * We also rewrite the PNG's embedded `chara` metadata with the current API
 * definition so stale cards do not reintroduce old definitions.
 */
async function downloadChubCard(characterId) {
  const [creator, slug] = characterId.split('/');
  if (!creator || !slug) throw new Error('Invalid Chub character ID.');

  const metadataUrls = [
    `https://api.chub.ai/api/characters/${encodeURIComponent(creator)}/${encodeURIComponent(slug)}?full=true`,
    `https://gateway.chub.ai/api/characters/${encodeURIComponent(creator)}/${encodeURIComponent(slug)}?full=true`,
  ];

  let metadata = null;
  let lastError = '';

  for (const url of metadataUrls) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
        },
        cache: 'no-store',
      });
      if (!response.ok) {
        const text = await safeText(response);
        lastError = `HTTP ${response.status}: ${text.slice(0, 180)}`;
        continue;
      }
      metadata = await response.json();
      if (metadata?.node) break;
      lastError = 'Chub returned JSON without a node object.';
    } catch (error) {
      lastError = error?.message || String(error);
    }
  }

  if (!metadata?.node) {
    throw new Error(`Chub metadata request failed. ${lastError || 'No response from Chub.'}`);
  }

  const node = metadata.node;
  const definition = node.definition ?? node;
  const characterName = definition.name || node.name || slug;
  const avatarUrl = pickAvatarUrl(node, definition, creator, slug);
  if (!avatarUrl) throw new Error('Chub returned character metadata but no card/avatar PNG URL.');

  const avatarResponse = await fetch(avatarUrl, {
    method: 'GET',
    credentials: 'include',
    headers: { 'Accept': 'image/png,image/*;q=0.9,*/*;q=0.8' },
    cache: 'no-store',
  });

  if (!avatarResponse.ok) {
    const text = await safeText(avatarResponse);
    throw new Error(`Chub avatar download failed (${avatarResponse.status}): ${text.slice(0, 180)}`);
  }

  let png = new Uint8Array(await avatarResponse.arrayBuffer());
  if (!isPng(png)) throw new Error('Chub did not return a PNG character card.');

  const cardJson = buildV2Card(node, definition, characterId);
  png = injectCharaTextChunk(png, cardJson);

  const blob = new Blob([png], { type: 'image/png' });
  return {
    blob,
    fileName: characterName,
    characterName,
  };
}

function pickAvatarUrl(node, definition, creator, slug) {
  const candidates = [
    node.max_res_url,
    definition.max_res_url,
    node.avatar_url,
    definition.avatar_url,
    node.avatar,
    definition.avatar,
  ];

  for (const value of candidates) {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  }

  // Chub commonly exposes its character cards under this host. V2 is the
  // broadest compatible format for SillyTavern import.
  return `https://avatars.charhub.io/avatars/${encodeURIComponent(creator)}/${encodeURIComponent(slug)}/chara_card_v2.png`;
}

function buildV2Card(node, definition, characterId) {
  const [creator] = characterId.split('/');
  const tags = Array.isArray(node.topics)
    ? node.topics
    : Array.isArray(definition.tags)
      ? definition.tags
      : [];

  const data = {
    name: definition.name || node.name || characterId.split('/')[1],
    description: definition.personality ?? definition.description ?? '',
    personality: definition.tavern_personality ?? definition.personality ?? '',
    scenario: definition.scenario ?? '',
    first_mes: definition.first_message ?? definition.first_mes ?? '',
    mes_example: definition.example_dialogs ?? definition.mes_example ?? '',
    creator_notes: definition.description ?? definition.creator_notes ?? '',
    system_prompt: definition.system_prompt ?? '',
    post_history_instructions: definition.post_history_instructions ?? '',
    alternate_greetings: Array.isArray(definition.alternate_greetings)
      ? definition.alternate_greetings
      : [],
    tags,
    creator,
    character_version: definition.version ?? definition.character_version ?? '',
    extensions: definition.extensions ?? {},
  };

  const card = {
    data,
    spec: 'chara_card_v2',
    spec_version: '2.0',
  };

  return JSON.stringify(card);
}

function injectCharaTextChunk(pngBytes, json) {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  if (pngBytes.length < signature.length || !signature.every((v, i) => pngBytes[i] === v)) {
    throw new Error('Invalid PNG signature.');
  }

  const encoded = new TextEncoder().encode(btoa(unescape(encodeURIComponent(json))));
  const keyword = new TextEncoder().encode('chara');
  const data = new Uint8Array(keyword.length + 1 + encoded.length);
  data.set(keyword, 0);
  data[keyword.length] = 0;
  data.set(encoded, keyword.length + 1);

  const newChunk = makePngChunk('tEXt', data);
  const chunks = [signature];
  let offset = 8;
  let inserted = false;

  while (offset + 12 <= pngBytes.length) {
    const length = readUint32(pngBytes, offset);
    const typeBytes = pngBytes.slice(offset + 4, offset + 8);
    const type = String.fromCharCode(...typeBytes);
    const end = offset + 12 + length;
    if (end > pngBytes.length) throw new Error('PNG chunk extends past file end.');

    const chunk = pngBytes.slice(offset, end);
    const isCharaText = (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') && chunkHasKeyword(chunk, type, 'chara');

    if (type === 'IEND') {
      if (!inserted) chunks.push(newChunk);
      chunks.push(chunk);
      inserted = true;
      offset = end;
      break;
    }

    if (!isCharaText) chunks.push(chunk);
    offset = end;
  }

  if (!inserted) throw new Error('PNG has no IEND chunk.');

  const total = chunks.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let cursor = 0;
  for (const part of chunks) {
    output.set(part, cursor);
    cursor += part.length;
  }
  return output;
}

function chunkHasKeyword(chunk, type, wanted) {
  const dataStart = 8;
  const length = readUint32(chunk, 0);
  const data = chunk.slice(dataStart, dataStart + length);
  if (type === 'tEXt' || type === 'zTXt') {
    const zero = data.indexOf(0);
    if (zero < 0) return false;
    return new TextDecoder().decode(data.slice(0, zero)).toLowerCase() === wanted;
  }
  if (type === 'iTXt') {
    const zero = data.indexOf(0);
    if (zero < 0) return false;
    return new TextDecoder().decode(data.slice(0, zero)).toLowerCase() === wanted;
  }
  return false;
}

function makePngChunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const total = 12 + data.length;
  const out = new Uint8Array(total);
  writeUint32(out, 0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crc = crc32(out.slice(4, 8 + data.length));
  writeUint32(out, 8 + data.length, crc);
  return out;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readUint32(bytes, offset) {
  return (((bytes[offset] << 24) >>> 0) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]) >>> 0;
}

function writeUint32(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function isPng(bytes) {
  return bytes.length >= 8 &&
    bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 &&
    bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10;
}

async function safeText(response) {
  try { return await response.text(); } catch { return ''; }
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) throw new Error('SillyTavern URL must use http or https.');
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new Error('Invalid SillyTavern URL. Example: http://127.0.0.1:8000');
  }
}

async function findOrOpenSillyTavernTab(stUrl, openIfMissing) {
  const target = new URL(stUrl);
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => {
    if (!tab.url) return false;
    try { return new URL(tab.url).origin === target.origin; } catch { return false; }
  });

  if (existing) return existing;
  if (!openIfMissing) return null;

  const created = await chrome.tabs.create({ url: stUrl, active: true });
  await waitForTabComplete(created.id, 15000);
  return await chrome.tabs.get(created.id);
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('SillyTavern did not finish loading in time.'));
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete' || settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function makeFileName(name) {
  const base = String(name || 'character')
    .replace(/\.png$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim()
    .slice(0, 140);
  return base || 'character';
}

async function importIntoSillyTavern(base64, fileName) {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], fileName, { type: 'image/png' });

    if (typeof window.importCharacter === 'function') {
      const importedFileName = await window.importCharacter(file);
      if (importedFileName) {
        if (typeof window.toastr?.success === 'function') {
          window.toastr.success(`Imported ${importedFileName}`, 'Chub → SillyTavern');
        }
        return {
          ok: true,
          fileName: importedFileName,
          characterName: String(importedFileName).replace(/\.png$/i, ''),
        };
      }
    }

    const tokenResponse = await fetch('/csrf-token', { credentials: 'include', cache: 'no-store' });
    if (!tokenResponse.ok) throw new Error(`Could not get SillyTavern CSRF token (HTTP ${tokenResponse.status}).`);
    const tokenData = await tokenResponse.json();
    const csrfToken = tokenData?.token;
    if (!csrfToken) throw new Error('SillyTavern did not return a CSRF token.');

    const form = new FormData();
    form.append('avatar', file);
    form.append('file_type', 'png');

    const response = await fetch('/api/characters/import', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'X-CSRF-Token': csrfToken,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: form,
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }

    if (!response.ok || data?.error || !data?.file_name) {
      throw new Error(`SillyTavern import failed (HTTP ${response.status}). ${text.slice(0, 260)}`);
    }

    if (typeof window.toastr?.success === 'function') {
      window.toastr.success(`Imported ${data.file_name}`, 'Chub → SillyTavern');
    }

    return {
      ok: true,
      fileName: data.file_name,
      characterName: data.file_name.replace(/\.png$/i, ''),
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
