// 从用户脚本导出词表副本。
//
// 用法（零依赖，Node >= 18）：
//   cd docs/glossary
//   node extract-from-userscript.mjs
//
// 原理：用 node:vm 以最小沙箱加载 probe/endstep-cn.user.js，读取它挂到 window.EndstepCn
// 的三张内置词表，再写成 JSON。**请勿手工编辑生成的 JSON**——要改词表请改脚本后重跑本脚本。

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, '..', '..', 'probe', 'endstep-cn.user.js');

if (!fs.existsSync(scriptPath)) {
  console.error('找不到用户脚本：' + scriptPath);
  process.exit(1);
}

const source = fs.readFileSync(scriptPath, 'utf8');

// 最小沙箱：document.body 为 null，脚本会自动跳过页面安装，只留下纯函数与词表。
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  URL,
  encodeURIComponent,
  decodeURIComponent,
  document: { body: null },
  location: { href: 'https://endstep.cc/' },
  localStorage: null,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'endstep-cn.user.js' });

const api = sandbox.EndstepCn;
if (!api || !api.BUILTIN_GLOSSARY || !api.UI_TERMS || !api.UI_PATTERNS) {
  console.error('未能从用户脚本读取词表：window.EndstepCn 未按预期导出。');
  process.exit(1);
}

function meta(note, extra) {
  return Object.assign({
    _note: note + '（由 probe/endstep-cn.user.js 自动导出，请勿手工维护）',
    _source: 'probe/endstep-cn.user.js',
    _script_version: api.SETTINGS_DEFAULTS ? '见脚本 @version' : '',
    _extracted_at: new Date().toISOString(),
  }, extra || {});
}

// 1) 关键词释义：keyword(英文小写) -> { name_zh, desc_zh }
const keywords = {};
for (const key of Object.keys(api.BUILTIN_GLOSSARY).sort()) {
  keywords[key] = api.BUILTIN_GLOSSARY[key];
}
const keywordDoc = meta('关键词释义词表（用于浮窗「关键词」区块）', {
  count: Object.keys(keywords).length,
  keywords: keywords,
});
fs.writeFileSync(
  path.join(here, 'keyword-glossary.zh-CN.json'),
  JSON.stringify(keywordDoc, null, 2) + '\n',
  'utf8',
);

// 2) 界面汉化词表：terms + patterns（结构与脚本内 createUiDictionary 的入参一致）
const terms = {};
for (const key of Object.keys(api.UI_TERMS).sort()) {
  terms[key] = api.UI_TERMS[key];
}
const patterns = api.UI_PATTERNS.map((entry) => ({
  pattern: entry.pattern,
  flags: entry.flags || '',
  replace: entry.replace,
}));
const uiDoc = meta('界面汉化词表（整串匹配 + 动态模式；组合匹配由脚本内的逐词逻辑实现）', {
  term_count: Object.keys(terms).length,
  pattern_count: patterns.length,
  terms: terms,
  patterns: patterns,
});
fs.writeFileSync(
  path.join(here, 'ui-glossary.zh-CN.json'),
  JSON.stringify(uiDoc, null, 2) + '\n',
  'utf8',
);

console.log('已导出：');
console.log('  keyword-glossary.zh-CN.json  关键词 ' + Object.keys(keywords).length + ' 条');
console.log('  ui-glossary.zh-CN.json       界面词条 ' + Object.keys(terms).length + ' 条 / 模式 ' + patterns.length + ' 条');
