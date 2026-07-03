import fs from 'node:fs';

const args = process.argv.slice(2);
const outputPath = args.at(-1) ?? 'orders_export.csv';
const inputPaths = args.length > 1 ? args.slice(0, -1) : ['orders_raw.json'];

const seen = new Set();
const summaries = [];
const orders = [];

for (const inputPath of inputPaths) {
  const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const rows = Array.isArray(data.dingdan) ? data.dingdan : [];
  summaries.push({
    inputPath,
    rows: rows.length,
    responseCounts: data.shuliang ?? null,
    pendingCount: data.daichulidingdan?.shuliang ?? null,
  });

  for (const order of rows) {
    if (!order?.id || seen.has(order.id)) continue;
    seen.add(order.id);
    orders.push(order);
  }
}
const fields = [
  'id',
  'shouhuoname',
  'shouhuotel',
  'shouhuodizhi',
  'chanpingname',
  'type',
];

const csvEscape = (value) => {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const lines = [
  fields.join(','),
  ...orders.map((order) => fields.map((field) => csvEscape(order[field])).join(',')),
];

fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');

console.log(JSON.stringify({
  outputPath,
  exported: orders.length,
  inputs: summaries,
  firstId: orders[0]?.id ?? null,
  lastId: orders.at(-1)?.id ?? null,
}, null, 2));
