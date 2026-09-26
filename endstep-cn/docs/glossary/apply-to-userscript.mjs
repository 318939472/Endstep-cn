// 把 docs/glossary/*.json 里的词表写回用户脚本（JSON → 脚本）。
//
// 用法（零依赖，Node >= 18）：
//   cd docs/glossary
//   node apply-to-userscript.mjs            # 写回 probe/endstep-cn.user.js
//   node apply-to-userscript.mjs --dry-run  # 只报告将要发生的变化，不写文件
//   node apply-to-userscript.mjs --check    # 同上，但有差异时以退出码 1 结束（便于提交前校验）
//
// 设计要点：
//   - 行级 upsert：只改动受影响的词条行，保留脚本里的注释、分组与原有写法，diff 最小；
//   - 每个条目区分两个概念：
//       key   —— 逻辑键（与 JSON 的键一致，已反转义）；
//       token —— 源文件里的原始写法（可能不带引号，正则里的反斜杠是双写形式）。
//     已存在条目沿用其原始 token，因此只有内容真变了才会产生 diff；
//   - 自动识别并保留原文件的换行风格（CRLF / LF）；
//   - 逐条校验字段类型，非法即报错退出，不会写出半成品。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, '..', '..', 'probe', 'endstep-cn.user.js');

const flags = process.argv.slice(2);
const checkMode = flags.includes('--check');
const dryRun = checkMode || flags.includes('--dry-run');

// --- 转义与引用 -------------------------------------------------------------

function unescapeJs(text) {
  return String(text).replace(/\\(.)/g, (match, char) => {
    switch (char) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '\\': return '\\';
      case "'": return "'";
      case '"': return '"';
      default: return char;
    }
  });
}

function escapeJs(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, '\\n');
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// 源文件里的键写法（带引号或不带）-> 逻辑键
function keyFromToken(token) {
  const text = String(token);
  return text.startsWith("'") ? unescapeJs(text.slice(1, -1)) : text;
}

// 逻辑键 -> 源文件里的键写法（新增条目时使用）
function tokenFromKey(key) {
  return IDENTIFIER.test(key) ? key : "'" + escapeJs(key) + "'";
}

function quoted(text) {
  return "'" + escapeJs(text) + "'";
}

// --- 三个区块的定义 ---------------------------------------------------------

const BLOCKS = [
  {
    id: 'keywords',
    file: 'keyword-glossary.zh-CN.json',
    startLine: 'const BUILTIN_GLOSSARY = {',
    endLine: '};',
    entryPattern: /^ {4}('(?:[^'\\]|\\.)*'|[A-Za-z_$][A-Za-z0-9_$]*): \{ name_zh: '((?:[^'\\]|\\.)*)', desc_zh: '((?:[^'\\]|\\.)*)' \},$/,
    tokenOf: (match) => match[1],
    keyOf: (match) => keyFromToken(match[1]),
    entries: (doc) => doc.keywords,
    validate: (key, value) => Boolean(value)
      && typeof value.name_zh === 'string'
      && typeof value.desc_zh === 'string',
    render: (token, value) => '    ' + token + ': { name_zh: ' + quoted(value.name_zh) +
      ', desc_zh: ' + quoted(value.desc_zh) + ' },',
    tokenForNew: (key) => tokenFromKey(key),
  },
  {
    id: 'terms',
    file: 'ui-glossary.zh-CN.json',
    startLine: 'const UI_TERMS = {',
    endLine: '};',
    // 兼容带引号与不带引号的键（后者可能是早期写回产生的），渲染时统一为带引号
    entryPattern: /^ {4}('(?:[^'\\]|\\.)*'|[A-Za-z_$][A-Za-z0-9_$]*): '((?:[^'\\]|\\.)*)',$/,
    tokenOf: (match) => match[1],
    keyOf: (match) => keyFromToken(match[1]),
    entries: (doc) => doc.terms,
    validate: (key, value) => typeof value === 'string',
    render: (token, value) => '    ' + quoted(keyFromToken(token)) + ': ' + quoted(value) + ',',
    tokenForNew: (key) => quoted(key),
  },
  {
    id: 'patterns',
    file: 'ui-glossary.zh-CN.json',
    startLine: 'const UI_PATTERNS = [',
    endLine: '];',
    entryPattern: /^ {4}\{ pattern: '((?:[^'\\]|\\.)*)', flags: '([^']*)', replace: '((?:[^'\\]|\\.)*)' \},$/,
    // token 是源文件里已转义的写法（正则中的 \ 为双写），逻辑键需反转义
    tokenOf: (match) => match[1],
    keyOf: (match) => unescapeJs(match[1]),
    entries: (doc) => {
      const map = {};
      for (const entry of doc.patterns || []) {
        if (!entry || typeof entry.pattern !== 'string') continue;
        map[entry.pattern] = {
          flags: typeof entry.flags === 'string' ? entry.flags : '',
          replace: entry.replace == null ? '' : String(entry.replace),
        };
      }
      return map;
    },
    validate: (key, value) => Boolean(value) && typeof value.replace === 'string',
    render: (token, value) => "    { pattern: '" + token + "', flags: '" + value.flags +
      "', replace: " + quoted(value.replace) + ' },',
    tokenForNew: (key) => escapeJs(key),
  },
];

// --- 区块更新（行级 upsert） ------------------------------------------------

function updateBlock(source, block, items) {
  const lines = source.split('\n');

  // 容错比较：忽略首尾空白，避免 CRLF 或多余空格导致定位失败
  let startIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === block.startLine) { startIndex = i; break; }
  }
  if (startIndex < 0) {
    throw new Error('在脚本中找不到区块起始行：' + block.startLine);
  }
  let endIndex = -1;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === block.endLine) { endIndex = i; break; }
  }
  if (endIndex < 0) {
    throw new Error('在脚本中找不到区块结束行：' + block.endLine);
  }

  const existing = new Map(); // 逻辑键 -> { index, token }
  for (let i = startIndex + 1; i < endIndex; i += 1) {
    const match = lines[i].match(block.entryPattern);
    if (!match) continue;
    existing.set(block.keyOf(match), { index: i, token: block.tokenOf(match) });
  }

  const updates = new Map(); // 行号 -> 新内容
  const removals = new Set();
  const additions = [];
  const stats = { unchanged: 0, updated: 0, added: 0, removed: 0 };

  for (const [key, value] of Object.entries(items)) {
    if (!block.validate(key, value)) {
      throw new Error('[' + block.id + '] 条目格式非法，请检查 JSON：' + JSON.stringify(key));
    }
    const hit = existing.get(key);
    if (!hit) {
      additions.push(block.render(block.tokenForNew(key), value));
      stats.added += 1;
      continue;
    }
    const rendered = block.render(hit.token, value);
    if (lines[hit.index] === rendered) {
      stats.unchanged += 1;
    } else {
      updates.set(hit.index, rendered);
      stats.updated += 1;
    }
  }

  for (const [key, hit] of existing) {
    if (!Object.prototype.hasOwnProperty.call(items, key)) {
      removals.add(hit.index);
      stats.removed += 1;
    }
  }

  const output = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i === endIndex) {
      for (const line of additions) output.push(line);
    }
    if (removals.has(i)) continue;
    output.push(updates.has(i) ? updates.get(i) : lines[i]);
  }

  return { text: output.join('\n'), stats: stats };
}

// --- 主流程 -----------------------------------------------------------------

if (!fs.existsSync(scriptPath)) {
  console.error('找不到用户脚本：' + scriptPath);
  process.exit(2);
}

const rawScript = fs.readFileSync(scriptPath, 'utf8');
const eol = rawScript.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
let source = rawScript.split('\r\n').join('\n');

const summary = [];
let totalChanges = 0;

for (const block of BLOCKS) {
  const filePath = path.join(here, block.file);
  if (!fs.existsSync(filePath)) {
    console.error('找不到词表文件：' + block.file);
    process.exit(2);
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error('解析失败：' + block.file + ' :: ' + (error && error.message));
    process.exit(2);
  }
  const items = block.entries(doc);
  if (!items || typeof items !== 'object') {
    console.error('[' + block.id + '] 在 ' + block.file + ' 中找不到词条对象。');
    process.exit(2);
  }
  const result = updateBlock(source, block, items);
  source = result.text;
  totalChanges += result.stats.updated + result.stats.added + result.stats.removed;
  summary.push({ id: block.id, stats: result.stats });
}

for (const row of summary) {
  const s = row.stats;
  console.log('  ' + row.id.padEnd(9) +
    ' 未变 ' + String(s.unchanged).padStart(4) +
    '  更新 ' + String(s.updated).padStart(3) +
    '  新增 ' + String(s.added).padStart(3) +
    '  删除 ' + String(s.removed).padStart(3));
}

if (dryRun) {
  if (totalChanges === 0) {
    console.log('✔ 脚本内嵌词表与 JSON 完全一致。');
    process.exit(0);
  }
  console.log(checkMode
    ? '✖ 存在 ' + totalChanges + ' 处差异：请运行 node apply-to-userscript.mjs 写回脚本。'
    : '（--dry-run）共 ' + totalChanges + ' 处差异，未写入文件。');
  process.exit(checkMode ? 1 : 0);
}

if (totalChanges === 0) {
  console.log('✔ 无需改动：脚本内嵌词表已与 JSON 一致。');
  process.exit(0);
}

fs.writeFileSync(scriptPath, eol === '\n' ? source : source.split('\n').join(eol), 'utf8');
console.log('✔ 已写回 ' + path.relative(process.cwd(), scriptPath) + '（共 ' + totalChanges + ' 处改动）。');
console.log('  提示：若脚本已在油猴中安装，请把新内容重新粘贴/更新后再刷新页面。');
