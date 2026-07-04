import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8787);
const DB_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'orders.db');
const CSV_PATH = path.join(__dirname, 'orders_export.csv');
const SHOPS_CONFIG_PATH = path.join(__dirname, 'shops.config.json');
const ADMIN_USER = process.env.ADMIN_USER ?? 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'jkdnanmdsk23829';
const ADMIN_SESSION = createHash('sha256').update(`${ADMIN_USER}:${ADMIN_PASSWORD}:order-admin`).digest('hex');
const DEFAULT_CARRIER = process.env.DEFAULT_CARRIER ?? '其他';

const shopsConfig = JSON.parse(await readFile(SHOPS_CONFIG_PATH, 'utf8'));
const shops = Object.fromEntries(
  Object.entries(shopsConfig).map(([id, config]) => [id, { id, ...config }]),
);

const publicFields = ['shouhuoname', 'shouhuotel', 'shouhuodizhi', 'chanpingname', 'type'];
const adminFields = [
  'id',
  ...publicFields,
  'status',
  'worker_phone',
  'tracking_no',
  'carrier',
  'screenshot_order_url',
  'screenshot_shipping_url',
];
const carriers = [
  '极兔速递',
  '申通快递',
  '中通快递',
  '圆通快递',
  '韵达快递',
  '邮政快递包裹',
  '京东配送',
  '邮政电商标快',
  '顺丰快递',
  '德邦快递',
  '邮政EMS',
  '笨鸟速运',
  '中通快运',
  '菜鸟速递',
  '其他',
];

await mkdir(DB_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    shop_id TEXT NOT NULL,
    id TEXT NOT NULL,
    shouhuoname TEXT DEFAULT '',
    shouhuotel TEXT DEFAULT '',
    shouhuodizhi TEXT DEFAULT '',
    chanpingname TEXT DEFAULT '',
    type TEXT DEFAULT '',
    source TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    worker_phone TEXT DEFAULT '',
    worker_order_no TEXT DEFAULT '',
    claimed_at TEXT DEFAULT '',
    tracking_no TEXT DEFAULT '',
    carrier TEXT DEFAULT '',
    screenshot_order_url TEXT DEFAULT '',
    screenshot_shipping_url TEXT DEFAULT '',
    synced_at TEXT DEFAULT '',
    updated_at TEXT DEFAULT '',
    PRIMARY KEY (shop_id, id)
  );
  CREATE TABLE IF NOT EXISTS meta (
    shop_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT DEFAULT '',
    PRIMARY KEY (shop_id, key)
  );
`);

function now() {
  return new Date().toISOString();
}

function shopOrThrow(shopId) {
  const shop = shops[shopId];
  if (!shop) throw new Error(`未知店铺：${shopId}`);
  return shop;
}

function assertShopConfigured(shop) {
  if (!shop.user || !shop.cookie) {
    throw new Error(`${shop.name} 还没有配置 user/cookie`);
  }
}

function endpoints(shop) {
  return {
    list: `${shop.baseUrl}/user/index2apics.php`,
    validate: `${shop.baseUrl}/api/user/shixiaoyanzheng.php`,
    upload: `${shop.baseUrl}/user/upload.php`,
    recognizeCarrier: `${shop.baseUrl}/api/user/kuaidishibie.php`,
    realtimeSave: `${shop.baseUrl}/api/user/shishibaocun.php`,
    origin: shop.baseUrl,
    referer: `${shop.baseUrl}/user/index2.php`,
  };
}

function commonHeaders(shop, accept = '*/*') {
  const ep = endpoints(shop);
  return {
    accept,
    cookie: shop.cookie,
    origin: ep.origin,
    referer: ep.referer,
    'user-agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36',
    'x-requested-with': 'XMLHttpRequest',
  };
}

function csvParse(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((items) => items.some(Boolean));
}

function csvPathForShop(shopId) {
  const shopCsv = path.join(__dirname, `orders_export_${shopId}.csv`);
  if (existsSync(shopCsv)) return shopCsv;
  if (shopId === 'shop-a' && existsSync(CSV_PATH)) return CSV_PATH;
  throw new Error(`未找到 ${shopId} 的 CSV：orders_export_${shopId}.csv`);
}

function normalizeOrder(order, source = 'csv') {
  const normalized = {
    id: String(order.id ?? '').trim(),
    shouhuoname: String(order.shouhuoname ?? ''),
    shouhuotel: String(order.shouhuotel ?? ''),
    shouhuodizhi: String(order.shouhuodizhi ?? ''),
    chanpingname: String(order.chanpingname ?? ''),
    type: String(order.type ?? ''),
    source,
    updated_at: now(),
  };
  return normalized;
}

function orderKey(shopId, id) {
  return createHash('sha256').update(`order-sync:${shopId}:${id}`).digest('base64url').slice(0, 20);
}

function rowToAdmin(row) {
  const result = {};
  for (const field of adminFields) result[field] = row[field] ?? '';
  return result;
}

function rowToWorker(row) {
  const result = {};
  for (const field of publicFields) result[field] = row[field] ?? '';
  result.key = orderKey(row.shop_id, row.id);
  result.status = row.status ?? 'pending';
  result.claimed = Boolean(row.worker_phone);
  result.mine = false;
  result.trackingNo = row.tracking_no ?? '';
  result.screenshotOrderUploaded = Boolean(row.screenshot_order_url);
  result.screenshotShippingUploaded = Boolean(row.screenshot_shipping_url);
  result.screenshotOrderUrl = row.screenshot_order_url ?? '';
  result.screenshotShippingUrl = row.screenshot_shipping_url ?? '';
  return result;
}

function setMeta(shopId, key, value) {
  db.prepare(`
    INSERT INTO meta (shop_id, key, value)
    VALUES (?, ?, ?)
    ON CONFLICT(shop_id, key) DO UPDATE SET value = excluded.value
  `).run(shopId, key, JSON.stringify(value));
}

function getMeta(shopId, key) {
  const row = db.prepare('SELECT value FROM meta WHERE shop_id = ? AND key = ?').get(shopId, key);
  return row ? JSON.parse(row.value) : null;
}

function listOrders(shopId) {
  return db.prepare('SELECT * FROM orders WHERE shop_id = ? ORDER BY CAST(id AS INTEGER) DESC, id DESC').all(shopId);
}

function getOrder(shopId, id) {
  return db.prepare('SELECT * FROM orders WHERE shop_id = ? AND id = ?').get(shopId, id);
}

function findByKey(shopId, key) {
  return listOrders(shopId).find((order) => orderKey(shopId, order.id) === key);
}

export async function importCsv(shopId = 'shop-a') {
  shopOrThrow(shopId);
  const csvPath = csvPathForShop(shopId);
  const text = await readFile(csvPath, 'utf8');
  const [headers, ...rows] = csvParse(text);
  const insert = db.prepare(`
    INSERT INTO orders (
      shop_id, id, shouhuoname, shouhuotel, shouhuodizhi, chanpingname, type, source, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, id) DO UPDATE SET
      shouhuoname = excluded.shouhuoname,
      shouhuotel = excluded.shouhuotel,
      shouhuodizhi = excluded.shouhuodizhi,
      chanpingname = excluded.chanpingname,
      type = excluded.type,
      source = excluded.source,
      updated_at = excluded.updated_at
  `);

  let imported = 0;
  const duplicates = [];
  const seen = new Set();
  for (const row of rows) {
    const raw = Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']));
    const order = normalizeOrder(raw, 'csv');
    if (!order.id) continue;
    if (seen.has(order.id)) {
      duplicates.push(order.id);
      continue;
    }
    seen.add(order.id);
    insert.run(
      shopId,
      order.id,
      order.shouhuoname,
      order.shouhuotel,
      order.shouhuodizhi,
      order.chanpingname,
      order.type,
      order.source,
      order.updated_at,
    );
    imported += 1;
  }

  const result = { at: now(), source: path.basename(csvPath), imported, duplicates };
  setMeta(shopId, 'lastImport', result);
  return result;
}

async function fetchUpstreamType4(shop) {
  assertShopConfigured(shop);
  const response = await fetch(endpoints(shop).list, {
    method: 'POST',
    headers: {
      ...commonHeaders(shop, 'application/json, text/javascript, */*; q=0.01'),
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: new URLSearchParams({ type: '4', user: shop.user }),
  });
  if (!response.ok) throw new Error(`上游请求失败：${response.status} ${response.statusText}`);
  return response.json();
}

export async function syncUpstream(shopId = 'shop-a') {
  const shop = shopOrThrow(shopId);
  const upstream = await fetchUpstreamType4(shop);
  const rows = Array.isArray(upstream.dingdan) ? upstream.dingdan : [];
  const localIds = new Set(listOrders(shopId).map((order) => order.id));
  const upstreamIds = new Set(rows.map((order) => String(order.id)));
  const update = db.prepare(`
    UPDATE orders SET
      shouhuoname = ?,
      shouhuotel = ?,
      shouhuodizhi = ?,
      chanpingname = ?,
      type = ?,
      source = ?,
      updated_at = ?
    WHERE shop_id = ? AND id = ?
  `);
  const updatedIds = [];
  const skippedNewIds = [];

  for (const row of rows) {
    const order = normalizeOrder(row, 'upstream-type-4');
    if (!localIds.has(order.id)) {
      skippedNewIds.push(order.id);
      continue;
    }
    update.run(
      order.shouhuoname,
      order.shouhuotel,
      order.shouhuodizhi,
      order.chanpingname,
      order.type,
      order.source,
      order.updated_at,
      shopId,
      order.id,
    );
    updatedIds.push(order.id);
  }

  const missingLocalIds = [...localIds].filter((id) => !upstreamIds.has(id));
  const result = {
    at: now(),
    requestType: '4',
    upstreamRows: rows.length,
    upstreamCounts: upstream.shuliang ?? null,
    pendingCount: upstream.daichulidingdan?.shuliang ?? null,
    updated: updatedIds.length,
    skippedNewIds,
    missingLocalIds,
    has28630: upstreamIds.has('28630'),
  };
  setMeta(shopId, 'lastSync', result);
  return result;
}

export async function importUpstream(shopId = 'shop-a') {
  const shop = shopOrThrow(shopId);
  const upstream = await fetchUpstreamType4(shop);
  const rows = Array.isArray(upstream.dingdan) ? upstream.dingdan : [];
  const insert = db.prepare(`
    INSERT INTO orders (
      shop_id, id, shouhuoname, shouhuotel, shouhuodizhi, chanpingname, type, source, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shop_id, id) DO UPDATE SET
      shouhuoname = excluded.shouhuoname,
      shouhuotel = excluded.shouhuotel,
      shouhuodizhi = excluded.shouhuodizhi,
      chanpingname = excluded.chanpingname,
      type = excluded.type,
      source = excluded.source,
      updated_at = excluded.updated_at
  `);

  let imported = 0;
  const ids = [];
  for (const row of rows) {
    const order = normalizeOrder(row, 'upstream-type-4-import');
    if (!order.id) continue;
    insert.run(
      shopId,
      order.id,
      order.shouhuoname,
      order.shouhuotel,
      order.shouhuodizhi,
      order.chanpingname,
      order.type,
      order.source,
      order.updated_at,
    );
    imported += 1;
    ids.push(order.id);
  }

  const result = {
    at: now(),
    requestType: '4',
    upstreamRows: rows.length,
    upstreamCounts: upstream.shuliang ?? null,
    pendingCount: upstream.daichulidingdan?.shuliang ?? null,
    imported,
    ids,
  };
  setMeta(shopId, 'lastImport', result);
  return result;
}

async function validateUpstreamOrder(shop, id) {
  const response = await fetch(endpoints(shop).validate, {
    method: 'POST',
    headers: {
      ...commonHeaders(shop),
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: new URLSearchParams({ id, user: shop.user }),
  });
  const text = (await response.text()).trim();
  if (!response.ok || text !== '1') throw new Error(`上游订单校验失败：${text || response.status}`);
}

async function uploadUpstreamImage(shop, id, type, file) {
  const form = new FormData();
  form.append('image', new Blob([file.data], { type: file.contentType || 'application/octet-stream' }), file.filename || `${type}.png`);
  form.append('id', id);
  form.append('type', type);
  const response = await fetch(endpoints(shop).upload, {
    method: 'POST',
    headers: commonHeaders(shop),
    body: form,
  });
  const text = (await response.text()).trim();
  if (!response.ok || !text) throw new Error(`${type} 上传失败：${text || response.status}`);
  return {
    raw: text,
    url: text.startsWith('http') ? text : `https://img.lingmoucx.com/${text}?x-oss-process=image/resize,w_100/quality,q_90`,
  };
}

async function saveUpstreamField(shop, id, type, data) {
  const response = await fetch(endpoints(shop).realtimeSave, {
    method: 'POST',
    headers: {
      ...commonHeaders(shop),
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: new URLSearchParams({
      id,
      data,
      type,
      user: shop.user,
    }),
  });
  const text = (await response.text()).trim();
  if (!response.ok || ['400', '404', '444'].includes(text)) {
    throw new Error(`上游保存 ${type} 失败：${text || response.status}`);
  }
  return text;
}

async function recognizeUpstreamCarrier(shop, id, trackingNo) {
  const response = await fetch(endpoints(shop).recognizeCarrier, {
    method: 'POST',
    headers: {
      ...commonHeaders(shop, 'application/json, text/javascript, */*; q=0.01'),
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: new URLSearchParams({
      id,
      danhao: trackingNo,
      user: shop.user,
    }),
  });
  const text = (await response.text()).trim();
  if (!response.ok || !text) throw new Error(`上游识别快递失败：${text || response.status}`);
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function saveUpstreamDelivery(shop, id, trackingNo, carrier, imageUrls = {}) {
  const results = {};
  results.tracking = await saveUpstreamField(shop, id, 'kddh1', trackingNo);
  if (imageUrls.order) results.orderImage = await saveUpstreamField(shop, id, 'fukuan', imageUrls.order);
  if (imageUrls.shipping) results.shippingImage = await saveUpstreamField(shop, id, 'daifahuo', imageUrls.shipping);
  results.carrierRecognition = await recognizeUpstreamCarrier(shop, id, trackingNo);
  return results;
}

function imageDataForUpstream(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.hostname === 'img.lingmoucx.com') return url.pathname.replace(/^\/+/, '');
  } catch {
    // Already a relative OSS path.
  }
  return text.split('?')[0];
}

async function syncOrderDataToUpstream(shopId, payload) {
  const shop = shopOrThrow(shopId);
  assertShopConfigured(shop);
  const id = String(payload.id ?? '').trim();
  if (!id) throw new Error('缺少订单 id');

  const order = getOrder(shopId, id);
  if (!order) throw new Error('订单不存在');
  const trackingNo = String(order.tracking_no ?? '').trim();
  const carrier = String(order.carrier ?? DEFAULT_CARRIER).trim() || DEFAULT_CARRIER;
  if (!trackingNo) throw new Error('本地没有快递单号，不能同步上游');

  await validateUpstreamOrder(shop, order.id);
  const upstreamSaveResult = await saveUpstreamDelivery(shop, order.id, trackingNo, carrier, {
    order: imageDataForUpstream(order.screenshot_order_url),
    shipping: imageDataForUpstream(order.screenshot_shipping_url),
  });
  const recognizedCarrier = upstreamSaveResult.carrierRecognition?.kuaidi || carrier;
  db.prepare(`
    UPDATE orders
    SET carrier = ?, synced_at = ?, updated_at = ?
    WHERE shop_id = ? AND id = ?
  `).run(recognizedCarrier, now(), now(), shopId, order.id);

  return {
    ok: true,
    id: order.id,
    trackingNo,
    carrier: recognizedCarrier,
    hasOrderImage: Boolean(order.screenshot_order_url),
    hasShippingImage: Boolean(order.screenshot_shipping_url),
    upstreamSaveResult,
  };
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const body = await readRequestBody(req);
  return body.length ? JSON.parse(body.toString('utf8')) : {};
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) throw new Error('缺少 multipart boundary');
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const parts = [];
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    start += boundary.length;
    if (buffer[start] === 45 && buffer[start + 1] === 45) break;
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), start);
    if (headerEnd === -1) break;
    const headerText = buffer.slice(start, headerEnd).toString('utf8');
    const dataStart = headerEnd + 4;
    const next = buffer.indexOf(boundary, dataStart);
    if (next === -1) break;
    let dataEnd = next;
    if (buffer[dataEnd - 2] === 13 && buffer[dataEnd - 1] === 10) dataEnd -= 2;
    const name = /name="([^"]+)"/.exec(headerText)?.[1];
    const filename = /filename="([^"]*)"/.exec(headerText)?.[1];
    const partType = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1];
    if (name) parts.push({ name, filename, contentType: partType, data: buffer.slice(dataStart, dataEnd) });
    start = next;
  }
  const fields = {};
  const files = {};
  for (const part of parts) {
    if (part.filename != null) files[part.name] = part;
    else fields[part.name] = part.data.toString('utf8');
  }
  return { fields, files };
}

async function claimOrder(shopId, payload) {
  const phone = String(payload.phone ?? '').trim();
  const key = String(payload.key ?? '').trim();
  if (!/^1\d{10}$/.test(phone)) throw new Error('请填写正确手机号');
  if (!key) throw new Error('缺少订单标识');

  const order = findByKey(shopId, key);
  if (!order) throw new Error('订单不存在');
  if (order.worker_phone && order.worker_phone !== phone) throw new Error('订单已被领取');

  db.prepare(`
    UPDATE orders SET worker_phone = ?, claimed_at = COALESCE(NULLIF(claimed_at, ''), ?), status = CASE WHEN status = 'done' THEN status ELSE 'claimed' END, updated_at = ?
    WHERE shop_id = ? AND id = ?
  `).run(phone, now(), now(), shopId, order.id);
  return { ok: true };
}

async function unclaimOrder(shopId, payload) {
  const phone = String(payload.phone ?? '').trim();
  const key = String(payload.key ?? '').trim();
  if (!/^1\d{10}$/.test(phone)) throw new Error('请填写正确手机号');
  if (!key) throw new Error('缺少订单标识');

  const order = findByKey(shopId, key);
  if (!order) throw new Error('订单不存在');
  if (!order.worker_phone) throw new Error('订单还在公共池');
  if (order.worker_phone !== phone) throw new Error('只能撤回自己领取的订单');
  if (order.status === 'done') throw new Error('已完成订单不能撤回');

  db.prepare(`
    UPDATE orders
    SET worker_phone = '', claimed_at = '', status = 'pending', updated_at = ?
    WHERE shop_id = ? AND id = ?
  `).run(now(), shopId, order.id);
  return { ok: true };
}

async function uploadWorkerScreenshots(shopId, req) {
  const shop = shopOrThrow(shopId);
  assertShopConfigured(shop);
  const body = await readRequestBody(req);
  const { fields, files } = parseMultipart(body, req.headers['content-type']);
  const phone = String(fields.phone ?? '').trim();
  const trackingNo = String(fields.trackingNo ?? '').trim();
  const carrier = String(fields.carrier ?? DEFAULT_CARRIER).trim() || DEFAULT_CARRIER;
  const key = String(fields.key ?? '').trim();
  if (!/^1\d{10}$/.test(phone)) throw new Error('请填写正确手机号');
  if (!trackingNo) throw new Error('请填写快递单号');
  if (!files.orderImage) throw new Error('缺少订单截图');
  if (!files.shippingImage) throw new Error('缺少快递截图');

  const order = findByKey(shopId, key);
  if (!order) throw new Error('订单不存在');
  if (order.worker_phone && order.worker_phone !== phone) throw new Error('订单已被其他手机号领取');

  try {
    if (!order.worker_phone) await claimOrder(shopId, { key, phone });
    await validateUpstreamOrder(shop, order.id);
    const screenshotOrder = await uploadUpstreamImage(shop, order.id, 'fukuan', files.orderImage);
    const screenshotShipping = await uploadUpstreamImage(shop, order.id, 'daifahuo', files.shippingImage);
    const upstreamSaveResult = await saveUpstreamDelivery(shop, order.id, trackingNo, carrier, {
      order: screenshotOrder.raw,
      shipping: screenshotShipping.raw,
    });
    const recognizedCarrier = upstreamSaveResult.carrierRecognition?.kuaidi || carrier;

    db.prepare(`
      UPDATE orders SET
        worker_phone = ?,
        tracking_no = ?,
        carrier = ?,
        screenshot_order_url = ?,
        screenshot_shipping_url = ?,
        status = 'done',
        synced_at = ?,
        updated_at = ?
      WHERE shop_id = ? AND id = ?
    `).run(phone, trackingNo, recognizedCarrier, screenshotOrder.url, screenshotShipping.url, now(), now(), shopId, order.id);

    return { ok: true, screenshotOrderUrl: screenshotOrder.url, screenshotShippingUrl: screenshotShipping.url, upstreamSaveResult };
  } catch (error) {
    console.error('[worker/upload failed]', {
      shopId,
      orderId: order.id,
      phone,
      trackingNo,
      carrier,
      message: error.message,
    });
    throw error;
  }
}

async function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function sendFile(res, file, type) {
  const body = await readFile(file);
  res.writeHead(200, { 'content-type': type, 'content-length': body.length });
  res.end(body);
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf('=');
        return index === -1 ? [item, ''] : [item.slice(0, index), decodeURIComponent(item.slice(index + 1))];
      }),
  );
}

function isAdminAuthed(req) {
  return parseCookies(req).admin_session === ADMIN_SESSION;
}

async function sendBlank(res) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('');
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

function parseRoute(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (!parts.length) return { page: 'admin', shopId: 'shop-a' };
  if (parts[0] === 'admin') return { page: 'admin', shopId: parts[1] || 'shop-a' };
  if (parts[0] === 'worker') return { page: 'worker', shopId: parts[1] || 'shop-a' };
  if (parts[0] === 'api') return { page: 'api', shopId: parts[1] || 'shop-a', action: parts.slice(2).join('/') };
  return {};
}

export const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      await sendBlank(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin') {
      await sendFile(res, path.join(__dirname, 'admin-login.html'), 'text/html; charset=utf-8');
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/login') {
      const payload = await readJsonBody(req);
      if (payload.username !== ADMIN_USER || payload.password !== ADMIN_PASSWORD) {
        await sendJson(res, 401, { error: '账号或密码错误' });
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': `admin_session=${encodeURIComponent(ADMIN_SESSION)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const route = parseRoute(url.pathname);

    if (req.method === 'GET' && route.page === 'admin') {
      shopOrThrow(route.shopId);
      if (!isAdminAuthed(req)) {
        redirect(res, `/admin?next=${encodeURIComponent(url.pathname)}`);
        return;
      }
      await sendFile(res, path.join(__dirname, 'admin.html'), 'text/html; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && route.page === 'worker') {
      shopOrThrow(route.shopId);
      await sendFile(res, path.join(__dirname, 'worker.html'), 'text/html; charset=utf-8');
      return;
    }

    if (route.page === 'api') {
      const shop = shopOrThrow(route.shopId);

      if (req.method === 'GET' && route.action === 'orders') {
        if (!isAdminAuthed(req)) {
          await sendJson(res, 401, { error: '请先登录后台' });
          return;
        }
        const orders = listOrders(route.shopId).map(rowToAdmin);
        await sendJson(res, 200, {
          shop: { id: shop.id, name: shop.name },
          orders,
          total: orders.length,
          lastImport: getMeta(route.shopId, 'lastImport'),
          lastSync: getMeta(route.shopId, 'lastSync'),
          carriers,
        });
        return;
      }

      if (req.method === 'POST' && route.action === 'import-csv') {
        if (!isAdminAuthed(req)) {
          await sendJson(res, 401, { error: '请先登录后台' });
          return;
        }
        await sendJson(res, 200, await importCsv(route.shopId));
        return;
      }

      if (req.method === 'POST' && route.action === 'import-upstream') {
        if (!isAdminAuthed(req)) {
          await sendJson(res, 401, { error: '请先登录后台' });
          return;
        }
        await sendJson(res, 200, await importUpstream(route.shopId));
        return;
      }

      if (req.method === 'POST' && route.action === 'sync-upstream') {
        if (!isAdminAuthed(req)) {
          await sendJson(res, 401, { error: '请先登录后台' });
          return;
        }
        await sendJson(res, 200, await syncUpstream(route.shopId));
        return;
      }

      if (req.method === 'POST' && route.action === 'sync-order-upstream') {
        if (!isAdminAuthed(req)) {
          await sendJson(res, 401, { error: '请先登录后台' });
          return;
        }
        await sendJson(res, 200, await syncOrderDataToUpstream(route.shopId, await readJsonBody(req)));
        return;
      }

      if (req.method === 'GET' && route.action === 'worker/orders') {
        const phone = String(url.searchParams.get('phone') ?? '').trim();
        const orders = listOrders(route.shopId)
          .filter((order) => !order.worker_phone || order.worker_phone === phone)
          .map((order) => ({
            ...rowToWorker(order),
            mine: Boolean(phone && order.worker_phone === phone),
          }));
        await sendJson(res, 200, { shop: { id: shop.id, name: shop.name }, orders, total: orders.length, carriers });
        return;
      }

      if (req.method === 'POST' && route.action === 'worker/claim') {
        await sendJson(res, 200, await claimOrder(route.shopId, await readJsonBody(req)));
        return;
      }

      if (req.method === 'POST' && route.action === 'worker/unclaim') {
        await sendJson(res, 200, await unclaimOrder(route.shopId, await readJsonBody(req)));
        return;
      }

      if (req.method === 'POST' && route.action === 'worker/upload') {
        await sendJson(res, 200, await uploadWorkerScreenshots(route.shopId, req));
        return;
      }
    }

    notFound(res);
  } catch (error) {
    await sendJson(res, 500, { error: error.message });
  }
});

if (process.env.ORDER_SYSTEM_NO_LISTEN !== '1') {
  server.listen(PORT, HOST, () => {
    console.log(`Order sync admin: http://${HOST}:${PORT}/admin/shop-a`);
    console.log(`Worker page: http://${HOST}:${PORT}/worker/shop-a`);
  });
}
