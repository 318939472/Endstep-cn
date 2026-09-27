// ==UserScript==
// @name           Endstep 简体中文卡牌浮窗
// @name:zh-CN     Endstep 简体中文卡牌浮窗
// @name:en        Endstep Simplified Chinese Card Tooltip
// @namespace      https://endstep.cc/
// @version        0.4.0
// @description     在 endstep.cc 悬停卡牌时显示简体中文卡名、类别、规则文本与关键词释义，并把卡图替换为大学院废墟中文卡图
// @description:zh-CN 在 endstep.cc 悬停卡牌时显示简体中文卡名、类别、规则文本与关键词释义，并把卡图替换为大学院废墟中文卡图
// @description:en    Show Simplified Chinese card name, type, rules text and keyword explanations on hover for endstep.cc, and swap card images to mtgch Chinese card images
// @author         endstep-cn contributors
// @license        GPL-3.0
// @match          https://endstep.cc/*
// @match          https://www.endstep.cc/*
// @match          https://*.endstep.cc/*
// @run-at         document-idle
// @grant          GM_registerMenuCommand
// @grant          GM_getValue
// @grant          GM_setValue
// @grant          GM_xmlhttpRequest
// @connect        mtgch.com
// @connect        images.mtgch.com
// @updateURL      https://raw.githubusercontent.com/318939472/Endstep-cn/main/endstep-cn/probe/endstep-cn.user.js
// @downloadURL    https://raw.githubusercontent.com/318939472/Endstep-cn/main/endstep-cn/probe/endstep-cn.user.js
// ==/UserScript==

/*
 * 实现说明
 *
 *  1. 骨架：单文件用户脚本，仅匹配 https://endstep.cc/*；所有数据请求走 GM_xmlhttpRequest
 *     （规避页面 CSP / CORS），并带 @connect 白名单。
 *  2. 站点适配层：只读 DOM，按「UUID -> 系列+编号 -> 英文名（二次核对）」的顺序识别鼠标下的卡；
 *     不接入 endstep 的私有接口，也不预扫描对手隐藏区域。
 *  3. 数据/翻译层：调用「大学院废墟」公开 API https://mtgch.com/api/v1 取中文；
 *     串行限速 + in-flight 去重 + 内存/持久双层缓存 + 失败回退英文。
 *  4. 展示层：跟随/固定两种模式的浮窗，显示中文卡名（含法术力费用）、中文类别、
 *     中文规则文本（逐行 · 标记）、关键词释义与来源标注。
 *  5. 设置与菜单：GM 菜单切换固定/调试模式、打开样式设置、清空本地缓存。
 */

(function () {
  'use strict';

  const root = window;

  // --- 常量 ---------------------------------------------------------------

  const SCRIPT_VERSION = '0.4.0';
  const MTGCH_API_BASE = 'https://mtgch.com/api/v1';
  const MTGCH_SITE = 'https://mtgch.com';
  const CACHE_KEY = 'endstep-cn-card-cache-v1';
  const SETTINGS_KEY = 'endstep-cn-settings';
  const DEBUG_KEY = 'endstep-cn-debug';
  const GLOSSARY_URL_KEY = 'endstep-cn-glossary-url';
  const MTGCH_IMAGE_PATTERN = /^https:\/\/images\.mtgch\.com\/zhs\//i; // 仅中文卡图（英文图不含 /zhs/）
  const IMAGE_CACHE_MAX_ENTRIES = 300; // 中文卡图（data URL）内存缓存上限

  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
  const CACHE_MAX_ENTRIES = 600;
  const REQUEST_MIN_INTERVAL_MS = 220; // 请求最小间隔（礼貌限速）
  const REQUEST_TIMEOUT_MS = 12000;
  const REQUEST_MAX_RETRIES = 2;

  const ATTRIBUTION_TEXT = '译名 / 文本来源：大学院废墟（mtgch.com）';
  const FALLBACK_NOTE = '暂无中文数据，显示英文原文';
  const LOADING_TEXT = '中文卡牌数据加载中…';
  const CARD_ZONE_PATTERN = /(card|deck|hand|library|grave|stack|battle|board|zone|pile|permanent|command)/i;
  const IDENTITY_ATTR_PATTERN = /(card|uuid|scryfall|set|collector|edition|number|face|name|image|art)/i;
  const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  // --- 内置关键词词库（离线兜底；阶段 6 将由 data/keyword-glossary.zh-CN.json 构建替换） ---

  const BUILTIN_GLOSSARY = {
    flying: { name_zh: '飞行', desc_zh: '此生物只能被具有飞行或延势的生物阻挡。' },
    reach: { name_zh: '延势', desc_zh: '此生物可以阻挡具有飞行的生物。' },
    'first strike': { name_zh: '先攻', desc_zh: '此生物在正常战斗伤害步骤之前先造成战斗伤害。' },
    'double strike': { name_zh: '连击', desc_zh: '此生物在先攻伤害步骤与正常战斗伤害步骤各造成一次战斗伤害。' },
    deathtouch: { name_zh: '死触', desc_zh: '此生物造成的任何数量伤害都足以消灭生物。' },
    trample: { name_zh: '践踏', desc_zh: '此生物攻击时，可将超过阻挡生物防御力的战斗伤害分配给防御牌手或鹏洛客。' },
    haste: { name_zh: '敏捷', desc_zh: '此生物不受召唤失调影响，可以立即攻击或使用其起动式异能。' },
    vigilance: { name_zh: '警戒', desc_zh: '此生物攻击不会使其横置。' },
    lifelink: { name_zh: '系命', desc_zh: '此生物造成的伤害同时使你获得等量的生命。' },
    menace: { name_zh: '威慑', desc_zh: '此生物不能被单个生物阻挡。' },
    flash: { name_zh: '闪现', desc_zh: '你可以于任何你能够使用瞬间牌的时机使用此牌。' },
    hexproof: { name_zh: '辟邪', desc_zh: '此永久物不能成为对手操控之咒语或异能的目标。' },
    indestructible: { name_zh: '不灭', desc_zh: '此永久物不会被消灭，并忽略致命伤害。' },
    ward: { name_zh: '守护', desc_zh: '当此永久物成为对手操控之咒语或异能的目标时，反击之，除非该牌手支付守护费用。' },
    prowess: { name_zh: '灵技', desc_zh: '每当你使用非生物咒语时，此生物得 +1/+1 直到回合结束。' },
    defender: { name_zh: '守军', desc_zh: '此生物不能攻击。' },
    protection: { name_zh: '保护', desc_zh: '具有「保护」的永久物不能被该特性的东西伤害、结附、阻挡或成为其目标。' },
    regenerate: { name_zh: '重生', desc_zh: '下次此永久物将被消灭时，改为横置它、移除其上的所有伤害并使其离开战斗。' },
    intimidate: { name_zh: '威吓', desc_zh: '此生物只能被神器生物或与它同色的生物阻挡。' },
    fear: { name_zh: '恐惧', desc_zh: '此生物只能被神器生物或黑色生物阻挡。' },
    skulk: { name_zh: '潜匿', desc_zh: '此生物不能被力量大于它的生物阻挡。' },
    shadow: { name_zh: '阴影', desc_zh: '此生物只能被具有阴影的生物阻挡，且只能阻挡具有阴影的生物。' },
    horsemanship: { name_zh: '马术', desc_zh: '此生物只能被具有马术的生物阻挡。' },
    flanking: { name_zh: '侧击', desc_zh: '每当此生物成为不具有侧击之生物的攻击对象时，该生物得 -1/-1 直到回合结束。' },
    infectious: { name_zh: '染毒', desc_zh: '此生物对生物造成伤害时以 -1/-1 指示物形式，对牌手则以毒指示物形式。' },
    wither: { name_zh: '凋萎', desc_zh: '此生物对生物造成的伤害以 -1/-1 指示物形式放置。' },
    'toxic': { name_zh: '剧毒', desc_zh: '此生物对牌手造成战斗伤害时，该牌手额外得到若干毒指示物。' },
    changeling: { name_zh: '化形', desc_zh: '此牌具有所有生物类别。' },
    'battle cry': { name_zh: '战呼', desc_zh: '每当此生物攻击时，其他每个攻击生物得 +1/+0 直到回合结束。' },
    exalted: { name_zh: '崇高', desc_zh: '每当一个生物单独攻击时，它得 +1/+1 直到回合结束。' },
    scry: { name_zh: '占卜', desc_zh: '检视你牌库顶的若干张牌，然后将其中任意数量以任意顺序置于牌库底，其余放回牌库顶。' },
    surveil: { name_zh: '窥探', desc_zh: '检视你牌库顶的若干张牌，将其中任意数量置入你的坟场，其余以任意顺序放回牌库顶。' },
    cycling: { name_zh: '循环', desc_zh: '支付循环费用并弃掉此牌：抽一张牌。' },
    flashback: { name_zh: '返照', desc_zh: '你可以从坟场支付返照费用来使用此牌，之后将它放逐。' },
    kicker: { name_zh: '增幅', desc_zh: '你可以额外支付增幅费用，以获得该牌的增幅效应。' },
    escape: { name_zh: '脱逸', desc_zh: '你可以从坟场支付脱逸费用并使用此牌，同时放逐指定数量的其他牌。' },
    foretell: { name_zh: '预示', desc_zh: '在你的回合，你可以支付 {2} 将此牌面朝下放逐；在之后的回合支付其预示费用来使用它。' },
    cascade: { name_zh: '倾曳', desc_zh: '当你使用此咒语时，放逐你牌库顶的牌直到放逐一非法术牌，你可以不支付其费用来使用它。' },
    convoke: { name_zh: '召集', desc_zh: '你可以横置你的生物来协助支付此咒语的费用，每个生物支付 {1} 或一点该生物颜色的法术力。' },
    delve: { name_zh: '掘穴', desc_zh: '你每从坟场放逐一牌，此咒语的费用便减少 {1}。' },
    dredge: { name_zh: '发掘', desc_zh: '若你将抽牌，你可以改为磨若干张牌并将此牌从坟场移回你手上。' },
    mutate: { name_zh: '突变', desc_zh: '你可以将此咒语的突变费用支付后，将它置于一个非人类生物的底下或顶上并使其突变。' },
    adventure: { name_zh: '历险', desc_zh: '此牌具有一张历险牌面，你可以先行使用该牌面。' },
    companion: { name_zh: '行侣', desc_zh: '若你的起始牌库符合其限制，你可以将一张行侣牌置于备牌区并从游戏外使用它。' },
    partner: { name_zh: '拍档', desc_zh: '你可以将两张具有拍档的指挥官一同作为你的指挥官。' },
    equip: { name_zh: '佩带', desc_zh: '支付佩带费用：将此装备附着在你操控的目标生物上，仅可在你的回合使用。' },
    enchant: { name_zh: '结附', desc_zh: '此牌结附于指定的永久物或牌手上。' },
    investigate: { name_zh: '探查', desc_zh: '创造一个线索衍生物。' },
    learn: { name_zh: '研习', desc_zh: '你可以从游戏外取一张课程牌入手，或弃一张牌后抽一张牌。' },
    exploit: { name_zh: '榨取', desc_zh: '当你使用此生物时，你可以牺牲一个生物以获得其榨取效应。' },
    bolster: { name_zh: '增援', desc_zh: '选择你操控的一个生物，在其上放置若干 +1/+1 指示物。' },
    proliferate: { name_zh: '增殖', desc_zh: '为你选择的任意数量永久物或牌手，各增加一个其上已有种类的指示物。' },
    amass: { name_zh: '屯军', desc_zh: '创造一个屯军衍生物，或在已有的屯军衍生物上放置若干 +1/+1 指示物。' },
    'cipher': { name_zh: '暗码', desc_zh: '你可以放逐此牌并将其暗码于一个你操控的生物上。' },
    overload: { name_zh: '超载', desc_zh: '你可以支付超载费用，使此咒语影响所有符合条件的对象，而非仅一个目标。' },
    bestow: { name_zh: '赋礼', desc_zh: '你可以支付赋礼费用将此牌作为灵气咒语使用。' },
    emerge: { name_zh: '涌现', desc_zh: '你可以牺牲一个生物并支付涌现费用来使用此咒语。' },
    melee: { name_zh: '近战', desc_zh: '每当此生物攻击时，本回合每有一个其他攻击你的对手，它便得 +1/+1 直到回合结束。' },
    'suspend': { name_zh: '延缓', desc_zh: '你可以支付延缓费用将此牌放逐并在其上放置若干计时指示物，在其移除最后一个计时指示物时使用它。' },
    'coven': { name_zh: '结社', desc_zh: '若你操控三个或更多力量不同的生物，则结社条件成立。' },
    'daybound': { name_zh: '昼形', desc_zh: '若由你操控且为白天的状态下，此永久物进入战场时为昼形。' },
    'nightbound': { name_zh: '夜形', desc_zh: '若由你操控且为黑夜的状态下，此永久物进入战场时为夜形。' },
    'prepared': { name_zh: '预备', desc_zh: '此生物处于预备状态时，你可以复制其预备牌并在之后使用该副本。' },
    'start your engines': { name_zh: '启动引擎', desc_zh: '若你没有速度，你拥有 1 点速度；之后每回合你对对手造成伤害时速度 +1（最大 4）。' },
    'blitz': { name_zh: '突击', desc_zh: '你可以支付突击费用使用此牌，它将获得敏捷并在回合结束时被牺牲，且你抽一张牌。' },
    'casualty': { name_zh: '牺牲副价', desc_zh: '你可以牺牲一个力量大于等于指定值的生物来复制此咒语。' },
    backup: { name_zh: '后援', desc_zh: '当你使用此生物时，在至多指定数量其他你操控的生物上各放置一个 +1/+1 指示物。' },
    'enlist': { name_zh: '征召', desc_zh: '此生物攻击时，你可以横置一个非攻击的生物使其力量加入此生物。' },
    'bargain': { name_zh: '议价', desc_zh: '你可以牺牲一个神器、生物或结界，以启用此牌的议价附加效应。' },
    'escalate': { name_zh: '升级', desc_zh: '此咒语每选择一个额外目标，其费用便增加一次升级费用。' },
    'jump-start': { name_zh: '跳跃起动', desc_zh: '你可以从坟场支付跳跃起动费用并使用此牌，同时弃一张牌，之后将此牌放逐。' },
    'aftermath': { name_zh: '余响', desc_zh: '此牌具有一张余响牌面，你可以从坟场使用该牌面，之后将它放逐。' },
    'eternalize': { name_zh: '永世', desc_zh: '你可以从坟场支付永世费用，将此牌作为 4/4 黑色殭尸战士衍生物置于战场。' },
    'embalm': { name_zh: '遗存', desc_zh: '你可以从坟场支付遗存费用，将此牌作为失去所有异能的白色殭尸衍生物置于战场。' },
    'afflict': { name_zh: '折磨', desc_zh: '每当此生物攻击时，防御牌手失去若干生命，除非其以一个生物阻挡它。' },
    'ascend': { name_zh: '升华', desc_zh: '若你操控十个或更多永久物，则你获得「黄金城祝福」直到游戏结束。' },
    'riot': { name_zh: '暴动', desc_zh: '此生物进入战场时，你选择使其获得敏捷或一个 +1/+1 指示物。' },
    'mentor': { name_zh: '训导', desc_zh: '每当此生物攻击时，在另一个力量小于它的攻击生物上放置一个 +1/+1 指示物。' },
    'adapt': { name_zh: '适应', desc_zh: '若此生物上没有 +1/+1 指示物，则支付适应费用并在其上放置若干 +1/+1 指示物。' },
    'undergrowth': { name_zh: '林下', desc_zh: '若你坟场中的生物牌数量达到指定值，则林下条件成立。' },
    'spectacle': { name_zh: '奇观', desc_zh: '若本回合有对手失去过生命，你可以支付奇观费用来使用此牌。' },
    'addendum': { name_zh: '补录', desc_zh: '若你在你的主阶段使用此咒语，则追加其补录效应。' },
  };

  // --- 设置 -----------------------------------------------------------------

  const SETTINGS_DEFAULTS = {
    bgColor: '12, 10, 8',
    bgOpacity: 0.95,
    borderColor: '217, 180, 91',
    borderOpacity: 0.4,
    textColor: '#f2ead8',
    textSize: 13,
    nameColor: '#d9b45b',
    nameSize: 15,
    typeColor: '#c8bfa6',
    typeSize: 12,
    keywordColor: '#8fd8c7',
    keywordSize: 11,
    uiTranslate: true,
    cardImage: true,
    panelMode: 'follow',
    panelPosition: null,
  };

  function loadSettings() {
    try {
      if (typeof GM_getValue !== 'function') return Object.assign({}, SETTINGS_DEFAULTS);
      const stored = GM_getValue(SETTINGS_KEY, null);
      if (stored) {
        const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
        return Object.assign({}, SETTINGS_DEFAULTS, parsed);
      }
    } catch (_) { /* GM 存储不可用 */ }
    return Object.assign({}, SETTINGS_DEFAULTS);
  }

  function saveSettings(settings) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(SETTINGS_KEY, JSON.stringify(settings));
      }
    } catch (_) { /* 尽力而为 */ }
  }

  function rgbToHex(rgb) {
    const parts = String(rgb || '').match(/\d+/g) || ['12', '10', '8'];
    let hex = '#';
    for (let i = 0; i < 3; i++) {
      const n = parseInt(parts[i] || 0, 10);
      hex += ('0' + n.toString(16)).slice(-2);
    }
    return hex;
  }

  function isDebugEnabled() {
    try {
      return Boolean(root.localStorage) && root.localStorage.getItem(DEBUG_KEY) === '1';
    } catch (_) {
      return false;
    }
  }

  // --- 通用小工具 -----------------------------------------------------------

  function str(value) {
    return typeof value === 'string' && value.trim() ? value : '';
  }

  function unique(values) {
    return [...new Set(values)];
  }

  // 是否为「大学院废墟」的中文卡图地址（images.mtgch.com/zhs/…）。英文图与插画裁切图都不含 /zhs/。
  function isChineseCardImageUrl(url) {
    return typeof url === 'string' && MTGCH_IMAGE_PATTERN.test(url);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // 注意：本文件里不能直接书写 HTML 实体字面量（写入/构建管线会把实体解码成裸字符），
  // 因此 "&" 一律用 fromCharCode 构造，实体解码走通用正则。
  const AMP = String.fromCharCode(38);

  const HTML_ENTITIES = {
    nbsp: ' ',
    amp: AMP,
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    mdash: '—',
    ndash: '–',
    hellip: '…',
  };

  function decodeHtmlEntities(text) {
    return String(text == null ? '' : text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
      if (code.charAt(0) === '#') {
        const isHex = code.charAt(1) === 'x' || code.charAt(1) === 'X';
        const numeric = parseInt(isHex ? code.slice(2) : code.slice(1), isHex ? 16 : 10);
        return Number.isFinite(numeric) ? String.fromCharCode(numeric) : match;
      }
      const key = code.toLowerCase();
      return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, key) ? HTML_ENTITIES[key] : match;
    });
  }

  function escapeHtml(value) {
    const map = {
      [AMP]: AMP + 'amp;',
      '<': AMP + 'lt;',
      '>': AMP + 'gt;',
      '"': AMP + 'quot;',
      "'": AMP + 'apos;',
    };
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => map[ch] || ch);
  }

  // 把 API 返回的 HTML（法术力符号写在 <i class="sr-only">{R}</i> 里）转成纯文本，
  // 于是 {R}、{2} 等符号会自然保留，无需额外字体。
  function htmlToText(html) {
    if (typeof html !== 'string' || !html) return '';
    let s = html;
    s = s.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
    s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
    s = s.replace(/<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n');
    s = s.replace(/<[^>]*>/g, '');
    s = decodeHtmlEntities(s);
    s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return s;
  }

  // API 的正文偶尔把换行写成字面量 "\n"（反斜杠 + n），这里统一还原。
  function toPlainText(value) {
    return String(value == null ? '' : value)
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\r\n/g, '\n')
      .trim();
  }

  // --- 卡牌身份识别（站点适配层，只读 DOM） ---------------------------------

  function extractUuid(value) {
    if (typeof value !== 'string' || !value) return null;
    const match = value.match(UUID_PATTERN);
    return match ? match[0].toLowerCase() : null;
  }

  // 从 URL（图片地址或 endstep 的 /api/cards/image 代理参数）里取「系列码 + 编号」。
  // 只在参数名明确、或路径形如 /card/<SET>/<NUM> 时才接受，避免误判。
  function extractSetCollector(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    let parsed;
    try {
      parsed = new URL(value, (root.location && root.location.href) || 'https://endstep.cc/');
    } catch (_) {
      return null;
    }
    const setKeys = ['set', 'setcode', 'set_code', 'edition', 'editioncode', 'code'];
    const numKeys = ['collector', 'collector_number', 'collectornumber', 'number', 'num', 'cn', 'card_number'];
    let set = null;
    let collector = null;
    for (const key of setKeys) {
      const value2 = parsed.searchParams.get(key);
      if (value2 && /^[A-Za-z0-9]{2,6}$/.test(value2)) { set = value2; break; }
    }
    for (const key of numKeys) {
      const value2 = parsed.searchParams.get(key);
      if (value2 && /^\d{1,5}[a-z]?$/i.test(value2)) { collector = value2; break; }
    }
    if (!set || !collector) {
      const match = parsed.pathname.match(/\/card\/([A-Za-z0-9]{2,6})\/(\d{1,5}[a-z]?)\b/i);
      if (match) {
        set = set || match[1];
        collector = collector || match[2];
      }
    }
    return set && collector ? { set: set.toLowerCase(), collector: collector } : null;
  }

  // 去掉行首数量、尾部（系列 编号）等噪音，得到可用作查询的英文卡名。
  function cleanNameCandidate(value) {
    if (typeof value !== 'string') return null;
    let s = value.replace(/\u00a0/g, ' ').trim();
    if (!s) return null;
    s = s.replace(/^\s*(?:\d+\s*[x×]?|[x×]\s*\d+)\s+/i, '');
    // 依次剥掉尾部噪音：先「… 113」，再「… SOS 113」，再「(SOS) 113」/「[SOS:113]」，
    // 最后再剥一次可能露出来的行尾数字。
    s = s.replace(/\s+\d+\s*$/, '');
    s = s.replace(/\s+[A-Z]{2,6}\s+\d+[a-z]?\s*$/, '');
    s = s.replace(/\s*[([{]\s*[A-Za-z0-9]{2,6}\s*[:#]?\s*\d{0,4}\s*[)\]}]+\s*$/i, '').trim();
    s = s.replace(/\s+\d+\s*$/, '');
    s = s.replace(/^["'\u201c\u201d\u2018\u2019]+|["'\u201c\u201d\u2018\u2019]+$/g, '').trim();
    if (!s || s.length > 80) return null;
    if (!/[A-Za-z]/.test(s)) return null;
    return s.replace(/\s+/g, ' ');
  }

  // 部分拉丁字母（æ / ø / ð / ß ...）在 NFKD 下不会分解，先手工折叠成 ASCII，
  // 这样 "Ærathi"、"Jarl Vetreiði" 之类的英文名也能与 ASCII 译名正确比对。
  const LATIN_FOLD = {
    '\u00e6': 'ae', '\u0153': 'oe', '\u00f8': 'o', '\u00f0': 'd',
    '\u00fe': 'th', '\u0142': 'l', '\u00df': 'ss', '\u0111': 'd',
    '\u0131': 'i', '\u014b': 'ng',
  };

  // 卡名规范化：用于「二次核对」，比较前统一大小写、撇号、双面牌分隔符与标点。
  function normalizeName(value) {
    return String(value == null ? '' : value)
      .replace(/[\u00c0-\u024f]/g, (ch) => LATIN_FOLD[ch] || ch)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\u2018\u2019`\u00b4]/g, "'")
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/\s*\/\/\s*/g, '//')
      .toLowerCase()
      .replace(/[^a-z0-9//' ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 展示层去重用的比较键：保留任意语言的字母，去掉空白与标点（中文牌名同样适用）。
  function normalizeComparable(value) {
    return String(value == null ? '' : value)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '')
      .replace(/[^\p{L}\p{N}/]+/gu, '');
  }

  function splitFaces(normalized) {
    return String(normalized || '')
      .split('//')
      .map((part) => part.trim())
      .filter(Boolean);
  }

  // 按用户约定：按英文名查询后必须二次核对——完整名称相同得 2 分，
  // 命中双面牌的某一面名称得 1 分，不匹配得 0 分。绝不直接采用第一条结果。
  function scoreSearchItem(targetName, item) {
    const target = normalizeName(targetName);
    if (!target || !item || typeof item !== 'object') return 0;
    const candidates = [];
    if (item.display_name) candidates.push(item.display_name);
    for (const face of item.other_faces || []) {
      if (face && face.display_name) candidates.push(face.display_name);
    }
    let best = 0;
    for (const candidate of candidates) {
      const normalized = normalizeName(candidate);
      if (!normalized) continue;
      if (normalized === target) return 2;
      const targetFaces = splitFaces(target);
      const candidateFaces = splitFaces(normalized);
      if (candidateFaces.includes(target) || targetFaces.some((face) => candidateFaces.includes(face))) {
        best = Math.max(best, 1);
      }
    }
    return best;
  }

  function verifySearchItemName(targetName, item) {
    return scoreSearchItem(targetName, item) > 0;
  }

  function attributeEntries(element) {
    if (!element || !element.attributes) return [];
    return Array.from(element.attributes, (attribute) => ({
      name: String(attribute.name || '').toLowerCase(),
      value: String(attribute.value || ''),
    }));
  }

  function extractCssImageUrls(value) {
    if (typeof value !== 'string' || !value.trim()) return [];
    const urls = [];
    const pattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
    let match;
    while ((match = pattern.exec(value))) {
      const url = String(match[1] || match[2] || match[3] || '').trim();
      if (url && !urls.includes(url)) urls.push(url);
    }
    return urls;
  }

  function looksLikeCardImage(url) {
    if (typeof url !== 'string' || !url) return false;
    if (extractUuid(url)) return true;
    if (/scryfall\.io|mtgch\.com|scryfall\.com/i.test(url)) return true;
    if (/\/api\/cards\/image|\/cards\/image\//i.test(url)) return true;
    return false;
  }

  function looksLikeCardContainer(element) {
    if (!element) return false;
    const haystack = [
      String(element.className || ''),
      String(element.id || ''),
      String(element.getAttribute ? element.getAttribute('data-testid') || '' : ''),
      String(element.getAttribute ? element.getAttribute('role') || '' : ''),
    ].join(' ');
    return CARD_ZONE_PATTERN.test(haystack);
  }

  function collectCandidates(element) {
    const result = {
      tagName: String((element && element.tagName) || '').toLowerCase(),
      className: String((element && element.className) || ''),
      imageUrls: [],
      textHints: [],
      attributes: {},
    };
    if (!element) return result;

    const entries = attributeEntries(element);
    const known = new Map(entries.map(({ name, value }) => [name, value]));
    const addImageUrl = (value) => {
      if (typeof value !== 'string' || !value.trim()) return;
      if (!result.imageUrls.includes(value)) result.imageUrls.push(value);
    };
    const addTextHint = (value) => {
      if (typeof value !== 'string' || !value.trim()) return;
      const trimmed = value.trim();
      if (trimmed.length > 120) return;
      if (!result.textHints.includes(trimmed)) result.textHints.push(trimmed);
    };

    addImageUrl(element.src || known.get('src'));
    addImageUrl(element.currentSrc);
    const srcset = element.srcset || known.get('srcset');
    if (typeof srcset === 'string' && srcset.trim()) {
      addImageUrl(srcset.split(',')[0].trim().split(/\s+/)[0]);
    }

    let backgroundImage = (element.style && element.style.backgroundImage) || known.get('style');
    if (!backgroundImage && element.className &&
        element.ownerDocument && element.ownerDocument.defaultView &&
        typeof element.ownerDocument.defaultView.getComputedStyle === 'function') {
      try {
        backgroundImage = element.ownerDocument.defaultView.getComputedStyle(element).backgroundImage;
      } catch (_) { /* 保留内联值 */ }
    }
    for (const url of extractCssImageUrls(backgroundImage)) {
      if (looksLikeCardImage(url)) addImageUrl(url);
    }

    for (const attr of ['alt', 'title', 'aria-label', 'data-name', 'data-card-name', 'data-cardname']) {
      addTextHint(element.getAttribute ? element.getAttribute(attr) : known.get(attr));
    }

    const text = element.textContent;
    if (typeof text === 'string' && text.trim() && text.length <= 80 && text.indexOf('\n') === -1) {
      addTextHint(text);
    }

    for (const { name, value } of entries) {
      if (name.indexOf('data-') !== 0) continue;
      if (!IDENTITY_ATTR_PATTERN.test(name)) continue;
      const trimmed = value.trim();
      if (!trimmed || trimmed.length > 200) continue;
      if (!result.attributes[name]) result.attributes[name] = [];
      if (!result.attributes[name].includes(trimmed)) result.attributes[name].push(trimmed);
    }

    return result;
  }

  // 判定「这个元素是否像一张卡」。要求有图片、或明确的身份属性，
  // 或位于卡牌区域（class / data-testid / role 命中）内的短文本，
  // 以免悬停任意带 title 的按钮就触发查询。
  function hasCandidateSignals(candidate, element) {
    if (!candidate) return false;
    if (candidate.imageUrls.length) return true;
    const attributeValues = Object.values(candidate.attributes).flat();
    if (attributeValues.some((value) => extractUuid(value) || extractSetCollector(value))) return true;
    if (candidate.textHints.length && looksLikeCardContainer(element)) return true;
    return false;
  }

  function imageUnderPointer(image, clientX, clientY) {
    if (clientX == null || clientY == null) return true;
    let rect = null;
    try {
      if (typeof image.getBoundingClientRect === 'function') rect = image.getBoundingClientRect();
    } catch (_) { /* 布局不可用 */ }
    if (!rect) return false;
    const tolerance = Math.max(8, Math.round((rect.width || 0) * 0.06));
    return clientX >= rect.left - tolerance && clientX <= rect.right + tolerance &&
           clientY >= rect.top - tolerance && clientY <= rect.bottom + tolerance;
  }

  function findImageCandidateUnderPointer(container, clientX, clientY) {
    if (!container || typeof container.querySelectorAll !== 'function') return null;
    let descendants;
    try {
      descendants = container.querySelectorAll('img');
    } catch (_) {
      return null;
    }
    for (let i = 0; i < descendants.length; i++) {
      const image = descendants[i];
      if (!collectCandidates(image).imageUrls.length) continue;
      if (imageUnderPointer(image, clientX, clientY)) return image;
    }
    return null;
  }

  function findProbeTarget(target, doc, clientX, clientY) {
    let current = target;
    let depth = 0;
    while (current && depth <= 6 && current !== doc.body) {
      const candidate = collectCandidates(current);
      if (hasCandidateSignals(candidate, current)) return current;
      const imageCandidate = findImageCandidateUnderPointer(current, clientX, clientY);
      if (imageCandidate) return imageCandidate;
      current = current.parentElement || current.parentNode;
      depth += 1;
    }
    return null;
  }

  function findCardAnchor(target, doc, clientX, clientY) {
    const detected = findProbeTarget(target, doc, clientX, clientY);
    if (!detected) return null;
    let anchor = detected;
    if (String(detected.tagName || '').toLowerCase() !== 'img' && typeof detected.querySelector === 'function') {
      const image = detected.querySelector('img');
      if (image) anchor = image;
    }
    if (!imageUnderPointer(anchor, clientX, clientY)) return null;
    return anchor;
  }

  // 从 URL 查询参数里提取卡名提示（例如卡图代理 /api/cards/image?name=Lightning+Bolt）。
  function extractQueryNameHints(value) {
    if (typeof value !== 'string' || !value.trim()) return [];
    let parsed;
    try {
      parsed = new URL(value, (root.location && root.location.href) || 'https://endstep.cc/');
    } catch (_) {
      return [];
    }
    const keys = ['name', 'card', 'cardname', 'card_name', 'card-name', 'q', 'title', 'face'];
    const hints = [];
    for (const key of keys) {
      const raw = parsed.searchParams.get(key);
      if (!raw) continue;
      const cleaned = cleanNameCandidate(raw);
      if (cleaned && !hints.includes(cleaned)) hints.push(cleaned);
    }
    return hints;
  }

  // 某串是否本身就是界面词表里的词（用于过滤 Hand / Deck 这类区域名，避免被当作卡名去查询）。
  function isUiTermText(text) {
    try {
      const key = normalizeUiKey(text);
      return key ? Object.prototype.hasOwnProperty.call(UI_TERMS, key) : false;
    } catch (_) {
      return false;
    }
  }

  // 悬停卡图时，UUID / 系列编号 / 卡名常挂在祖先容器上（卡牌砖块的 data-*，或紧邻的名称文本），
  // 因此除元素自身外，再向上收集若干层作为兜底。
  function collectAncestorIdentities(element) {
    const values = [];
    const names = [];
    let current = element ? (element.parentElement || element.parentNode) : null;
    let depth = 0;
    while (current && depth < 3 && current.nodeType === 1) {
      for (const { name, value } of attributeEntries(current)) {
        if (!IDENTITY_ATTR_PATTERN.test(name)) continue;
        const trimmed = value.trim();
        if (trimmed && !values.includes(trimmed)) values.push(trimmed);
      }
      const text = typeof current.textContent === 'string' ? current.textContent.trim() : '';
      if (text && text.length <= 80 && text.indexOf('\n') === -1) {
        const cleaned = cleanNameCandidate(text);
        if (cleaned && !isUiTermText(cleaned) && !names.includes(cleaned)) names.push(cleaned);
      }
      current = current.parentElement || current.parentNode;
      depth += 1;
    }
    return { values: values, names: names };
  }

  // 汇总一个元素的全部身份线索：UUID / 系列+编号 / 英文名候选（含祖先与 URL 参数兜底）。
  function extractIdentity(element) {
    const candidate = collectCandidates(element);
    const ancestors = collectAncestorIdentities(element);
    const attributeValues = Object.values(candidate.attributes).flat();
    const scanSources = [...candidate.imageUrls, ...attributeValues, ...ancestors.values];

    let uuid = null;
    for (const source of scanSources) {
      uuid = extractUuid(source);
      if (uuid) break;
    }

    let setCollector = null;
    for (const source of scanSources) {
      setCollector = extractSetCollector(source);
      if (setCollector) break;
    }

    const names = unique([
      ...candidate.textHints.map(cleanNameCandidate).filter(Boolean),
      ...candidate.imageUrls.flatMap(extractQueryNameHints),
      ...ancestors.names,
    ]);

    return { candidate, uuid, setCollector, names, ancestors };
  }

  // --- 限速队列 -------------------------------------------------------------

  // 串行执行并保证两次请求之间有最小间隔；失败不会阻断队列。
  function createThrottleQueue(minInterval) {
    let chain = Promise.resolve();
    let lastStart = 0;
    return function enqueue(task) {
      const run = chain.then(async () => {
        const wait = Math.max(0, minInterval - (Date.now() - lastStart));
        if (wait > 0) await sleep(wait);
        lastStart = Date.now();
        return task();
      });
      chain = run.then(() => undefined, () => undefined);
      return run;
    };
  }

  // --- 数据/翻译层：大学院废墟客户端 ---------------------------------------

  function createMtgchClient(options) {
    const opts = options || {};
    const enqueue = createThrottleQueue(REQUEST_MIN_INTERVAL_MS);
    const memory = new Map();   // key -> record | null
    const inflight = new Map(); // key -> promise
    let store = loadPersistentCache();
    let saveTimer = null;

    function loadPersistentCache() {
      try {
        if (typeof GM_getValue !== 'function') return {};
        const raw = GM_getValue(CACHE_KEY, null);
        if (!raw) return {};
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (_) {
        return {};
      }
    }

    function scheduleSave() {
      if (typeof setTimeout !== 'function') return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
          if (typeof GM_setValue !== 'function') return;
          const now = Date.now();
          const entries = Object.entries(store)
            .filter(([, value]) => value && now - value.t < CACHE_TTL_MS)
            .sort((a, b) => (b[1].t || 0) - (a[1].t || 0))
            .slice(0, CACHE_MAX_ENTRIES);
          store = Object.fromEntries(entries);
          GM_setValue(CACHE_KEY, JSON.stringify(store));
        } catch (_) { /* 尽力而为 */ }
      }, 800);
    }

    function cacheGet(key) {
      const hit = store[key];
      if (!hit) return undefined;
      if (Date.now() - (hit.t || 0) > CACHE_TTL_MS) {
        delete store[key];
        return undefined;
      }
      return hit.r || null;
    }

    function cacheSet(key, record) {
      store[key] = { t: Date.now(), r: record };
      scheduleSave();
    }

    // --- 网络请求（GM_xmlhttpRequest 优先，fetch 兜底） ---

    function requestJson(url) {
      return enqueue(() => attempt(url, 0));
    }

    function parseJson(text) {
      try {
        return JSON.parse(text);
      } catch (_) {
        throw new Error('响应不是有效 JSON');
      }
    }

    function attempt(url, retry) {
      return new Promise((resolve, reject) => {
        const onOk = (text) => {
          try {
            resolve(parseJson(text));
          } catch (error) {
            reject(error);
          }
        };
        const onFailure = (message) => {
          if (retry < REQUEST_MAX_RETRIES) {
            const delay = 400 * (retry + 1);
            setTimeout(() => {
              attempt(url, retry + 1).then(resolve, reject);
            }, delay);
            return;
          }
          reject(new Error(message));
        };
        const onStatus = (status, text) => {
          if (status >= 200 && status < 300) {
            onOk(text);
          } else if (status >= 400 && status < 500) {
            reject(new Error('HTTP ' + status)); // 客户端错误不重试
          } else {
            onFailure('HTTP ' + status);
          }
        };

        const fetchFallback = () => {
          const fetchFn = root.fetch || (typeof fetch === 'function' ? fetch : null);
          if (typeof fetchFn !== 'function') {
            reject(new Error('当前环境不支持网络请求'));
            return;
          }
          fetchFn(url, { headers: { Accept: 'application/json' } })
            .then((response) => response.text().then((text) => ({ status: response.status, text })))
            .then(({ status, text }) => onStatus(status, text))
            .catch((error) => onFailure(error && error.message ? error.message : String(error)));
        };

        if (typeof GM_xmlhttpRequest === 'function') {
          try {
            GM_xmlhttpRequest({
              method: 'GET',
              url: url,
              responseType: 'text',
              timeout: REQUEST_TIMEOUT_MS,
              onload: (response) => onStatus(response ? response.status : 0, response ? response.responseText : ''),
              onerror: () => onFailure('网络错误'),
              ontimeout: () => onFailure('请求超时'),
            });
            return;
          } catch (_) {
            fetchFallback();
            return;
          }
        }
        fetchFallback();
      });
    }

    function cardUrl(uuid) {
      return MTGCH_API_BASE + '/card/' + encodeURIComponent(uuid) + '/';
    }

    function setCollectorUrl(set, collector) {
      return MTGCH_API_BASE + '/card/' + encodeURIComponent(set) + '/' + encodeURIComponent(collector) + '/';
    }

    function searchUrl(name) {
      return MTGCH_API_BASE + '/result?q=' + encodeURIComponent(name) +
        '&priority_chinese=true&unique=oracle_id&view=1&page_size=20';
    }

    // --- 记录规范化 ---

    function pickImageUri(uris) {
      if (!uris) return null;
      if (typeof uris === 'string') return uris;
      return str(uris.normal) || str(uris.large) || str(uris.small) || null;
    }

    function formatPt(raw) {
      const power = str(raw.power);
      const toughness = str(raw.toughness);
      if (power && toughness) return power + '/' + toughness;
      if (str(raw.loyalty)) return '忠诚 ' + str(raw.loyalty);
      if (str(raw.defense)) return '防护 ' + str(raw.defense);
      return '';
    }

    function normalizeFace(face) {
      if (!face || typeof face !== 'object') return null;
      const nameEn = str(face.face_name) || str(face.name);
      const nameZh = str(face.atomic_translated_name) || str(face.zhs_name) || str(face.printed_name);
      const typeZh = str(face.atomic_translated_type) || str(face.zhs_type_line) || str(face.printed_type_line);
      const textZh = toPlainText(str(face.atomic_translated_text) || str(face.zhs_text) || str(face.printed_text));
      const textEn = toPlainText(str(face.oracle_text));
      const typeEn = str(face.type_line);
      if (!nameEn && !nameZh) return null;
      return { name_en: nameEn, name_zh: nameZh, type_en: typeEn, type_zh: typeZh, text_en: textEn, text_zh: textZh };
    }

    function normalizeDetail(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const faces = Array.isArray(raw.other_faces)
        ? raw.other_faces.map(normalizeFace).filter(Boolean)
        : [];
      const nameEn = str(raw.full_official_name) || str(raw.name);
      const nameZh = str(raw.full_translated_name) || str(raw.atomic_translated_name) ||
        str(raw.zhs_name) || str(raw.printed_name);
      const typeZh = str(raw.atomic_translated_type) || str(raw.zhs_type_line) || str(raw.printed_type_line);
      const textZh = toPlainText(str(raw.atomic_translated_text) || str(raw.zhs_text) || str(raw.printed_text));
      const record = {
        key: str(raw.id) || null,
        name_en: str(raw.name) || nameEn,
        name_zh: nameZh,
        full_name_en: nameEn || str(raw.name),
        full_name_zh: nameZh || str(raw.name),
        type_en: str(raw.type_line),
        type_zh: typeZh,
        text_en: toPlainText(str(raw.oracle_text)),
        text_zh: textZh,
        mana_cost: str(raw.mana_cost),
        pt: formatPt(raw),
        keywords: Array.isArray(raw.keywords) ? raw.keywords.slice() : [],
        set: str(raw.set),
        set_name: str(raw.set_name),
        set_zh: str(raw.set_translated_name) || str(raw.set_name),
        collector_number: str(raw.collector_number),
        rarity: str(raw.rarity),
        released_at: str(raw.released_at),
        scryfall_uri: str(raw.scryfall_uri),
        image_en: pickImageUri(raw.image_uris),
        image_zh: pickImageUri(raw.zhs_image_uris),
        faces: faces,
        source: 'mtgch',
      };
      record.hasZh = Boolean(nameZh || typeZh || textZh);
      return record;
    }

    function normalizeSearchItem(item) {
      if (!item || typeof item !== 'object') return null;
      const nameZh = str(item.display_name_zh);
      const textZh = htmlToText(str(item.oracle_text_html));
      const faces = Array.isArray(item.other_faces)
        ? item.other_faces.map((face) => ({
          name_en: str(face.display_name),
          name_zh: str(face.display_name_zh),
          type_en: '',
          type_zh: str(face.display_type_line),
          text_en: '',
          text_zh: htmlToText(str(face.oracle_text_html)),
        })).filter((face) => face.name_en || face.name_zh)
        : [];
      const record = {
        key: str(item.id) || null,
        name_en: str(item.display_name),
        name_zh: nameZh,
        full_name_en: str(item.display_name),
        full_name_zh: nameZh || str(item.display_name),
        type_en: '',
        type_zh: str(item.display_type_line),
        text_en: '',
        text_zh: textZh,
        mana_cost: htmlToText(str(item.mana_cost_html)).replace(/\s+/g, ''),
        pt: str(item.power_toughness_loyalty_defense),
        keywords: [],
        set: str(item.set),
        set_name: '',
        set_zh: str(item.set_name) || str(item.set),
        collector_number: str(item.collector_number),
        rarity: str(item.rarity),
        released_at: '',
        scryfall_uri: '',
        image_en: null,
        image_zh: str(item.image_url) || null,
        faces: faces,
        source: 'mtgch',
      };
      record.hasZh = Boolean(nameZh || record.type_zh || textZh);
      return record;
    }

    // 详情优先（含 keywords 与 atomic_translated_*），用搜索结果补充详情缺失的字段。
    function mergeRecords(primary, secondary) {
      if (!primary) return secondary || null;
      if (!secondary) return primary;
      const merged = Object.assign({}, primary);
      const fields = ['name_zh', 'type_zh', 'text_zh', 'text_en', 'mana_cost', 'pt', 'set_zh', 'collector_number', 'rarity', 'image_zh'];
      for (const field of fields) {
        if (!merged[field] && secondary[field]) merged[field] = secondary[field];
      }
      if ((!merged.faces || !merged.faces.length) && secondary.faces && secondary.faces.length) {
        merged.faces = secondary.faces;
      }
      merged.hasZh = Boolean(merged.name_zh || merged.type_zh || merged.text_zh);
      return merged;
    }

    // --- 名称查询（含二次核对） ---

    async function resolveByName(name) {
      const raw = await requestJson(searchUrl(name));
      const items = (raw && Array.isArray(raw.items)) ? raw.items : [];
      let best = null;
      let bestScore = 0;
      for (const item of items) {
        const score = scoreSearchItem(name, item);
        if (score > bestScore) {
          best = item;
          bestScore = score;
        }
      }
      if (!best || bestScore === 0) return null;
      const normalizedItem = normalizeSearchItem(best);
      if (best.id) {
        try {
          const detail = normalizeDetail(await requestJson(cardUrl(best.id)));
          if (detail) return mergeRecords(detail, normalizedItem);
        } catch (_) { /* 详情失败则退回搜索项 */ }
      }
      return normalizedItem;
    }

    // --- 带缓存与 in-flight 去重的取数 ---

    function getByKey(key, loader, persist) {
      if (memory.has(key)) return Promise.resolve(memory.get(key));
      if (inflight.has(key)) return inflight.get(key);
      const shouldPersist = persist !== false;
      if (shouldPersist) {
        const stored = cacheGet(key);
        if (stored !== undefined) {
          memory.set(key, stored);
          return Promise.resolve(stored);
        }
      }
      const promise = (async () => {
        try {
          const record = await loader();
          const value = record || null;
          memory.set(key, value);
          if (value && shouldPersist) cacheSet(key, value);
          return value;
        } catch (error) {
          memory.set(key, null); // 记忆失败，避免反复请求
          if (isDebugEnabled() && typeof console !== 'undefined' && console.warn) {
            console.warn('[Endstep CN][debug] 请求失败:', key, error);
          }
          return null;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, promise);
      return promise;
    }

    function loadDetailByUuid(uuid) {
      return getByKey('uuid:' + uuid, async () => normalizeDetail(await requestJson(cardUrl(uuid))));
    }

    function loadDetailBySetCollector(set, collector) {
      return getByKey('sc:' + set + '/' + collector, async () =>
        normalizeDetail(await requestJson(setCollectorUrl(set, collector))));
    }

    function loadByName(name) {
      return getByKey('name:' + normalizeName(name), () => resolveByName(name));
    }

    // 识别顺序：UUID -> 系列+编号 -> 英文名（二次核对）。
    // 若前面命中但无中文，则用英文名再试一次中文版本；全部失败回退英文记录。
    async function lookup(element) {
      const identity = extractIdentity(element);
      const debugInfo = { identity, stages: [], fallbackName: null };
      let fallback = null;

      if (identity.uuid) {
        const record = await loadDetailByUuid(identity.uuid);
        debugInfo.stages.push('uuid:' + identity.uuid + (record ? (record.hasZh ? '→zh' : '→en') : '→miss'));
        if (record) {
          if (record.hasZh) return { record, stage: 'uuid', debug: debugInfo };
          fallback = fallback || record;
        }
      }

      if (identity.setCollector) {
        const { set, collector } = identity.setCollector;
        const record = await loadDetailBySetCollector(set, collector);
        debugInfo.stages.push('set:' + set + '/' + collector + (record ? (record.hasZh ? '→zh' : '→en') : '→miss'));
        if (record) {
          if (record.hasZh) return { record, stage: 'set-collector', debug: debugInfo };
          fallback = fallback || record;
        }
      }

      const nameSeeds = unique(
        [(fallback && fallback.name_en) || null, ...identity.names].filter(Boolean),
      );
      for (const name of nameSeeds) {
        if (!name || name.length < 2) continue;
        const record = await loadByName(name);
        debugInfo.stages.push('name:' + name + (record ? (record.hasZh ? '→zh' : '→en') : '→miss'));
        if (record) {
          if (record.hasZh) return { record, stage: 'name', debug: debugInfo };
          fallback = fallback || record;
        }
      }

      if (fallback) return { record: fallback, stage: 'en-only', debug: debugInfo };
      return { record: null, stage: 'miss', debug: debugInfo };
    }

    function clearCache() {
      store = {};
      memory.clear();
      try {
        if (typeof GM_setValue === 'function') GM_setValue(CACHE_KEY, '{}');
      } catch (_) { /* 尽力而为 */ }
    }

    function cacheSize() {
      return Object.keys(store).length;
    }

    return {
      lookup: lookup,
      clearCache: clearCache,
      cacheSize: cacheSize,
      fetchCardDetail: async (uuid) => normalizeDetail(await requestJson(cardUrl(uuid))),
      __test: { htmlToText: htmlToText, normalizeDetail: normalizeDetail, normalizeSearchItem: normalizeSearchItem },
    };
  }

  // --- 关键词释义 -----------------------------------------------------------

  function lookupKeywordEntry(keyword, glossary) {
    if (!glossary) return null;
    const base = String(keyword || '').toLowerCase().trim();
    if (!base) return null;
    const candidates = [base, base.replace(/\s+\d+$/, ''), base.replace(/\s+x$/, '')];
    const preposition = base.match(/^([a-z' -]+?)\s+(?:from|of)\s+/);
    if (preposition) candidates.push(preposition[1].trim());
    const words = base.split(/\s+/);
    if (words.length > 1) candidates.push(words.slice(0, 2).join(' '));
    for (const candidate of candidates) {
      if (glossary[candidate]) return glossary[candidate];
    }
    return null;
  }

  function loadGlossary() {
    const glossary = Object.assign({}, BUILTIN_GLOSSARY);
    let url = null;
    try {
      url = root.localStorage && root.localStorage.getItem(GLOSSARY_URL_KEY);
    } catch (_) { /* 忽略 */ }
    if (!url || typeof GM_xmlhttpRequest !== 'function') return Promise.resolve(glossary);
    return new Promise((resolve) => {
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url: String(url),
          responseType: 'text',
          timeout: REQUEST_TIMEOUT_MS,
          onload: (response) => {
            try {
              const extra = JSON.parse(response.responseText);
              if (extra && typeof extra === 'object') Object.assign(glossary, extra);
            } catch (_) { /* 保持内置词库 */ }
            resolve(glossary);
          },
          onerror: () => resolve(glossary),
          ontimeout: () => resolve(glossary),
        });
      } catch (_) {
        resolve(glossary);
      }
    });
  }

  // --- 界面汉化 -------------------------------------------------------------
  //
  // 安全原则：
  //   1. 只做「整串精确匹配 / 有限动态模式 / 全词可译的短组合」，绝不逐词乱序替换；
  //   2. 跳过 script/style/code/pre/输入框、聊天与玩家名区域、我们的浮窗自身，
  //      以及带卡图的卡牌元素（保护卡名与 alt，避免破坏卡牌识别）；
  //   3. 每处改动都记录原文，关闭开关时完整还原；
  //   4. React 重渲染覆写后由 MutationObserver 重新应用，且永不重复翻译已含中文的文本。

  const UI_SKIP_TAGS = /^(script|style|noscript|code|pre|textarea|input|select|option|svg|canvas|title|iframe)$/i;
  const UI_SKIP_CONTAINER = /(endstep-cn|chat|message|comment|username|player-?name|deck-?name|tooltip|log-line)/i;
  const UI_TEXT_ATTRS = ['placeholder', 'title', 'aria-label'];

  const UI_TERMS = {
    // 通用操作
    'ok': '确定',
    'yes': '是',
    'no': '否',
    'cancel': '取消',
    'confirm': '确认',
    'close': '关闭',
    'save': '保存',
    'reset': '重置',
    'done': '完成',
    'next': '下一步',
    'back': '返回',
    'skip': '跳过',
    'apply': '应用',
    'clear': '清除',
    'all': '全部',
    'none': '无',
    'any': '任意',
    'search': '搜索',
    'filter': '筛选',
    'sort': '排序',
    'random': '随机',
    'copy': '复制',
    'copied': '已复制',
    'share': '分享',
    'invite': '邀请',
    'join': '加入',
    'leave': '离开',
    'create': '创建',
    'start': '开始',
    'stop': '停止',
    'resume': '继续',
    'undo': '撤销',
    'redo': '重做',
    'help': '帮助',
    'settings': '设置',
    'options': '选项',
    'about': '关于',
    'profile': '个人资料',
    'account': '账户',
    'logout': '退出登录',
    'login': '登录',
    'sign in': '登录',
    'sign up': '注册',
    'loading': '加载中',
    'error': '错误',
    'warning': '警告',
    'success': '成功',
    'connected': '已连接',
    'disconnected': '已断开',
    'reconnecting': '重新连接中',
    'waiting': '等待中',
    'waiting for opponent': '等待对手',
    'ready': '准备就绪',
    'not ready': '未准备',
    'spectate': '观战',
    'watch': '观看',
    'replay': '回放',
    'delete': '删除',
    'remove': '移除',
    'add': '添加',
    'edit': '编辑',
    'rename': '重命名',
    'refresh': '刷新',
    'retry': '重试',
    'continue': '继续',
    'finish': '结束',
    'submit': '提交',
    'select': '选择',
    'selected': '已选择',
    'deselect': '取消选择',
    'move': '移动',
    'move to': '移至',

    // 连接词（仅在整串全词可译时才参与组合）
    'to': '至',
    'of': '的',
    'the': '',
    'a': '',
    'an': '',
    'in': '在',
    'on': '于',
    'at': '于',
    'from': '从',
    'for': '为',
    'with': '带有',
    'and': '和',
    'or': '或',
    'not': '不',
    'by': '由',
    'your': '你的',
    'you': '你',
    'their': '其',
    'this': '此',
    'that': '该',
    'each': '每个',
    'per': '每',
    'if': '若',
    'then': '则',
    'when': '当',
    'card': '牌',
    'cards': '牌',
    'player': '牌手',
    'players': '牌手',
    'opponent': '对手',
    'opponents': '对手',
    'turn': '回合',

    // 对局动作
    'play': '使用',
    'cast': '施放',
    'activate': '起动',
    'attack': '攻击',
    'attacks': '攻击',
    'attacking': '攻击时',
    'block': '阻挡',
    'blocks': '阻挡',
    'blocking': '阻挡时',
    'unblocked': '未被阻挡',
    'damage': '伤害',
    'deal damage': '造成伤害',
    'assign damage': '分配伤害',
    'target': '目标',
    'targets': '目标',
    'choose target': '选择目标',
    'resolve': '结算',
    'counter': '反击',
    'counterspell': '反击咒语',
    'copy spell': '复制咒语',
    'token': '衍生物',
    'tokens': '衍生物',
    'permanent': '永久物',
    'permanents': '永久物',
    'spell': '咒语',
    'spells': '咒语',
    'tap': '横置',
    'untap': '重置',
    'tapped': '已横置',
    'untapped': '未横置',
    'full control': '完全操控',
    'auto pass': '自动让过',
    'priority': '优先权',
    'pass priority': '让过优先权',
    'pass': '让过',
    'end turn': '结束回合',
    'reveal': '展示',
    'discard': '弃牌',
    'mill': '磨',
    'scry': '占卜',
    'surveil': '刺探',
    'look': '检视',
    'draw': '抽牌',
    'draw card': '抽一张牌',
    'exile': '放逐',
    'destroy': '消灭',
    'sacrifice': '牺牲',
    'return': '移回',
    'shuffle': '洗牌',

    // 区域
    'zone': '区域',
    'library': '牌库',
    'graveyard': '坟场',
    'battlefield': '战场',
    'stack': '堆叠',
    'hand': '手牌',
    'command zone': '指挥官区',
    'sideboard': '备牌',
    'main deck': '主牌',
    'deck': '牌组',
    'deck list': '牌表',
    'deck builder': '牌组构筑器',
    'card pool': '卡池',
    'exile zone': '放逐区',
    'top of library': '牌库顶',
    'bottom of library': '牌库底',
    'library search': '牌库搜寻',

    // 阶段
    'upkeep': '维持',
    'draw step': '抽牌步骤',
    'main phase': '主阶段',
    'combat phase': '战斗阶段',
    'ending phase': '结束阶段',
    'beginning phase': '开始阶段',
    'first main phase': '第一主阶段',
    'second main phase': '第二主阶段',
    'cleanup step': '清空步骤',
    'declare attackers': '宣告攻击者',
    'declare blockers': '宣告阻挡者',
    'combat damage': '战斗伤害',
    'end step': '结束步骤',
    'untap step': '重置步骤',

    // 牌张类别
    'creature': '生物',
    'creatures': '生物',
    'artifact': '神器',
    'artifacts': '神器',
    'enchantment': '结界',
    'enchantments': '结界',
    'instant': '瞬间',
    'instants': '瞬间',
    'sorcery': '法术',
    'sorceries': '法术',
    'land': '地',
    'lands': '地',
    'planeswalker': '鹏洛客',
    'planeswalkers': '鹏洛客',
    'battle': '战役',
    'legendary': '传奇',
    'basic': '基本',
    'snow': '雪境',
    'aura': '灵气',
    'equipment': '装备',
    'vehicle': '载具',
    'keywords': '关键词',
    'card type': '牌张类别',
    'type line': '类别栏',
    'rules text': '规则文本',
    'flavor text': '背景叙述',
    'mana cost': '法术力费用',
    'mana': '法术力',
    'mana pool': '法术力池',
    'color identity': '颜色标识',
    'converted mana cost': '总法术力费用',
    'power': '力量',
    'toughness': '防御力',
    'loyalty': '忠诚',
    'defense': '防护',
    'set': '系列',
    'set code': '系列代码',
    'collector number': '收藏编号',
    'rarity': '稀有度',

    // 模式与赛制
    'format': '赛制',
    'formats': '赛制',
    'cube': '轮抽盒',
    'draft': '轮抽',
    'sealed': '现开',
    'constructed': '构筑',
    'commander': '指挥官',
    'standard': '标准',
    'modern': '摩登',
    'legacy': '薪传',
    'vintage': '特选',
    'pauper': '纯铁',
    'pioneer': '先驱',
    'brawl': '争锋',
    'booster draft': '补充包轮抽',
    'pod': '牌局桌',
    'lobby': '大厅',
    'room': '房间',
    'game': '对局',
    'match': '比赛',
    'game log': '对局日志',
    'turn order': '回合顺序',
    'mulligan': '再调度',
    'keep hand': '保留手牌',
    'london mulligan': '伦敦调度',
    'starting player': '起始牌手',
    'play first': '先手',
    'draw first': '后手',

    // 对局控制
    'surrender': '投降',
    'concede': '认输',
    'rematch': '再战一局',
    'new game': '新对局',
    'leave game': '离开对局',
    'create game': '创建对局',
    'join game': '加入对局',
    'start game': '开始对局',
    'add to deck': '加入牌组',
    'remove from deck': '从牌组移除',
    'life': '生命',
    'life total': '生命总计',
    'poison counters': '毒指示物',
    'commander damage': '指挥官伤害',
    'energy': '能量',
    'experience counters': '经验指示物',
    'emblems': '徽记',
    'treasure': '珍宝',
    'clue': '线索',
    'food': '食物',
    'blood': '血滴',
    'map': '地图',
    'powerstone': '能量石',

    // 以下为完整词表的补充条目（已并入脚本，保证单文件自包含）
    'previous': '上一步',
    'clear all': '全部清除',
    'select all': '全选',
    'search cards': '搜索卡牌',
    'copy link': '复制链接',
    'paste': '粘贴',
    'share link': '分享链接',
    'undo all': '全部撤销',
    'game settings': '对局设置',
    'match settings': '比赛设置',
    'connection lost': '连接已断开',
    'connecting': '连接中',
    'spectating': '观战中',
    'spectators': '观战者',
    'join as spectator': '以观战者身份加入',
    'remove all': '全部移除',
    'add all': '全部添加',
    'choose': '选择',
    'choose one': '选择一项',
    'choose a card': '选择一张牌',
    'choose a color': '选择一种颜色',
    'import': '导入',
    'export': '导出',
    'import deck': '导入牌组',
    'export deck': '导出牌组',
    'print': '打印',
    'printing': '版本',
    'foil': '闪卡',
    'nonfoil': '平卡',
    'condition': '品相',
    'language': '语言',
    'english': '英文',
    'chinese': '中文',
    'japanese': '日文',
    'owned': '已拥有',
    'owned only': '仅显示已拥有',
    'missing': '缺少',
    'include sideboard': '包含备牌',
    'show tokens': '显示衍生物',
    'total cards': '牌张总数',
    'deck size': '牌组张数',
    'deck name': '牌组名称',
    'mana curve': '法术力曲线',
    'average mana value': '平均法术力值',
    'color': '颜色',
    'colors': '颜色',
    'type': '类别',
    'types': '类别',
    'sets': '系列',
    'host': '房主',
    'guest': '访客',
    'kick': '移出房间',
    'ban': '封禁',
    'report': '举报',
    'public': '公开',
    'private': '私有',
    'password': '密码',
    'room name': '房间名称',
    'game name': '对局名称',
    'your turn': '你的回合',
    'next turn': '下一个回合',
    'pass turn': '让过回合',
    'attackers': '攻击者',
    'blockers': '阻挡者',
    'order blockers': '排列阻挡者',
    'auto assign': '自动分配',
    'no valid targets': '没有合法目标',
    'resolve all': '全部结算',
    'tap all': '全部横置',
    'untap all': '全部重置',
    'auto': '自动',
    'manual': '手动',
    'yield': '让过',
    'stops': '停止点',
    'end of turn': '回合结束时',
    'draw a card': '抽一张牌',
    'command': '指挥官',
    'phase': '阶段',
    'step': '步骤',
    'take mulligan': '再调度',
    'concede game': '认输',
    'poison': '毒',
    'ticket': '票券',
    'tickets': '票券',
    'storm': '风暴',
    'time left': '剩余时间',
    'out of time': '时间耗尽',
    'time out': '超时',
    'you have priority': '你有优先权',
    'opponent is thinking': '对手思考中',
    'premodern': '前摩登',
  };

  const UI_PATTERNS = [
    { pattern: '^turn\\s+(\\d+)$', flags: 'i', replace: '回合 $1' },
    { pattern: '^round\\s+(\\d+)$', flags: 'i', replace: '第 $1 轮' },
    { pattern: '^game\\s+(\\d+)$', flags: 'i', replace: '第 $1 局' },
    { pattern: '^(\\d+)\\s*lives?$', flags: 'i', replace: '$1 生命' },
    { pattern: '^(\\d+)\\s*cards?$', flags: 'i', replace: '$1 张牌' },
    { pattern: '^(\\d+)\\s*mana$', flags: 'i', replace: '$1 法术力' },
    { pattern: '^(\\d+)\\s*damage$', flags: 'i', replace: '$1 点伤害' },
    { pattern: '^(\\d+)\\s*counters?$', flags: 'i', replace: '$1 个指示物' },
    { pattern: '^(\\d+)\\s*seconds?\\s+left$', flags: 'i', replace: '剩余 $1 秒' },
    { pattern: '^choose\\s+(\\d+)$', flags: 'i', replace: '选择 $1' },
    { pattern: '^select\\s+(\\d+)$', flags: 'i', replace: '选择 $1' },
    { pattern: '^(\\d+)\\s*x$', flags: 'i', replace: '$1 张' },
    { pattern: '^x\\s*(\\d+)$', flags: 'i', replace: '$1 张' },
    { pattern: '^waiting\\s+for\\s+(.+)$', flags: 'i', replace: '等待 $1' },
    { pattern: '^pass\\s+to\\s+(.+)$', flags: 'i', replace: '让过给 $1' },
    { pattern: '^(\\d+)\\s*poison$', flags: 'i', replace: '$1 毒指示物' },
    { pattern: '^(\\d+)\\s*\\/\\s*(\\d+)\\s*life$', flags: 'i', replace: '$1 / $2 生命' },
  ];

  function normalizeUiKey(text) {
    return String(text == null ? '' : text)
      .replace(/[\u00a0\u3000]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function createUiDictionary(terms, patterns) {
    const dictionary = { terms: Object.create(null), patterns: [] };
    for (const [key, value] of Object.entries(terms || {})) {
      const normalized = normalizeUiKey(key);
      if (!normalized || value == null) continue;
      dictionary.terms[normalized] = String(value);
    }
    for (const entry of patterns || []) {
      if (!entry || !entry.pattern || entry.replace == null) continue;
      try {
        dictionary.patterns.push({
          re: new RegExp(entry.pattern, entry.flags || ''),
          replace: String(entry.replace),
        });
      } catch (_) { /* 忽略非法模式 */ }
    }
    return dictionary;
  }

  function lookupUiTerm(text, dictionary) {
    if (!dictionary || !dictionary.terms || text == null) return null;
    const key = normalizeUiKey(text);
    if (!key) return null;
    const terms = dictionary.terms;
    if (Object.prototype.hasOwnProperty.call(terms, key)) return terms[key];
    if (key.endsWith(':')) {
      const bare = key.slice(0, -1).trim();
      if (bare && Object.prototype.hasOwnProperty.call(terms, bare) && terms[bare]) {
        return terms[bare] + '：';
      }
    }
    for (const suffix of ['es', 's']) {
      if (!key.endsWith(suffix)) continue;
      const singular = key.slice(0, key.length - suffix.length);
      if (singular && Object.prototype.hasOwnProperty.call(terms, singular)) return terms[singular];
    }
    return null;
  }

  function applyUiPattern(text, dictionary) {
    if (!dictionary || !dictionary.patterns || !text) return null;
    for (const entry of dictionary.patterns) {
      if (!entry.re.test(text)) continue;
      const replaced = text.replace(entry.re, entry.replace);
      if (replaced && replaced !== text) return replaced;
    }
    return null;
  }

  // 组合模式：只有当每一个英文词都能查到译名时才整体替换，否则整串放弃。
  function translateUiTokens(text, dictionary) {
    if (!dictionary || !text) return null;
    const parts = String(text).split(/([A-Za-z][A-Za-z'\u2019-]*|\d+)/).filter((part) => part !== '');
    if (!parts.length) return null;
    const out = [];
    let translated = 0;
    for (const part of parts) {
      if (/^[A-Za-z]/.test(part)) {
        const zh = lookupUiTerm(part, dictionary);
        if (zh == null) return null;
        out.push(zh);
        translated += 1;
      } else {
        out.push(part);
      }
    }
    if (!translated) return null;
    // 中文之间不留英文空格，避免出现「移动 至 牌库」
    return out.join('').replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1');
  }

  // 返回翻译后的完整字符串；无法安全翻译时返回 null（调用方保持原文）。
  function translateUiText(rawText, dictionary) {
    if (!dictionary || typeof rawText !== 'string' || !rawText) return null;
    if (/[\u4e00-\u9fff]/.test(rawText)) return null; // 已含中文，不再处理
    const leading = rawText.match(/^\s*/)[0];
    const trailing = rawText.match(/\s*$/)[0];
    const core = rawText.slice(leading.length, rawText.length - trailing.length);
    if (!core || core.length > 60) return null;
    if (!/[A-Za-z]/.test(core)) return null;

    const exact = lookupUiTerm(core, dictionary);
    if (exact != null && exact !== '' && exact !== core) return leading + exact + trailing;

    const patterned = applyUiPattern(core, dictionary);
    if (patterned) return leading + patterned + trailing;

    // 以句末标点结尾的完整句子不做逐词组合，避免把规则文本拼得支离破碎
    if (/[.!?]$/.test(core)) return null;

    const tokens = translateUiTokens(core, dictionary);
    if (tokens && tokens !== core) return leading + tokens + trailing;
    return null;
  }

  function createUiTranslator(doc, dictionary, options) {
    const opts = options || {};
    const originals = new WeakMap();
    const attrOriginals = new WeakMap();
    const trackedTexts = new Set();
    const trackedAttrs = new Set();
    const htmlLangOriginal = doc.documentElement ? doc.documentElement.getAttribute('lang') : null;
    const titleOriginal = doc.title;
    let observer = null;
    let pending = false;
    let queue = [];
    let applying = false;
    let enabled = false;

    function isCardLikeElement(element) {
      if (!element || element.nodeType !== 1) return false;
      if (String(element.tagName || '').toLowerCase() === 'img') return true;
      if (typeof element.querySelector !== 'function') return false;
      try {
        return Boolean(element.querySelector('img'));
      } catch (_) {
        return false;
      }
    }

    function isInsideSkipped(node, includeSelf) {
      if (!node) return true;
      let element = node.nodeType === 1 ? node : node.parentElement;
      if (!includeSelf) element = element ? element.parentElement : null;
      let depth = 0;
      while (element && depth <= 8) {
        if (UI_SKIP_TAGS.test(String(element.tagName || ''))) return true;
        if (element.isContentEditable) return true;
        const marker = String(element.className || '') + ' ' + String(element.id || '');
        if (UI_SKIP_CONTAINER.test(marker)) return true;
        if (element.getAttribute && element.getAttribute('data-endstep-cn-skip') != null) return true;
        element = element.parentElement;
        depth += 1;
      }
      return false;
    }

    function translateTextNode(node) {
      if (!node || node.nodeType !== 3) return;
      const raw = node.nodeValue;
      if (!raw || !raw.trim()) return;
      const record = originals.get(node);
      if (record) {
        if (raw === record.translated) return;      // 已是我们的译文
        if (raw === record.raw) {                   // React 覆写回原文 → 重新应用
          applying = true;
          node.nodeValue = record.translated;
          applying = false;
          return;
        }
        originals.delete(node);                     // 内容已变化 → 当作新节点处理
        trackedTexts.delete(node);
      }
      if (isInsideSkipped(node, true)) return;
      const translated = translateUiText(raw, dictionary);
      if (!translated || translated === raw) return;
      originals.set(node, { raw: raw, translated: translated });
      trackedTexts.add(node);
      applying = true;
      node.nodeValue = translated;
      applying = false;
    }

    function translateAttributes(element) {
      if (!element || element.nodeType !== 1) return;
      if (isCardLikeElement(element)) return;
      if (isInsideSkipped(element, false)) return;
      for (const attr of UI_TEXT_ATTRS) {
        if (typeof element.hasAttribute !== 'function' || !element.hasAttribute(attr)) continue;
        const raw = element.getAttribute(attr);
        if (!raw || !raw.trim()) continue;
        let store = attrOriginals.get(element);
        if (!store) {
          store = {};
          attrOriginals.set(element, store);
        }
        if (!Object.prototype.hasOwnProperty.call(store, attr)) store[attr] = raw;
        const translated = translateUiText(store[attr], dictionary);
        if (translated && translated !== raw) {
          element.setAttribute(attr, translated);
          trackedAttrs.add(element);
        } else if (!translated && raw !== store[attr]) {
          element.setAttribute(attr, store[attr]);
        }
      }
    }

    function walk(node) {
      if (!node) return;
      if (node.nodeType === 3) {
        translateTextNode(node);
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
      applying = true;
      if (node.nodeType === 1) translateAttributes(node);
      if (typeof doc.createTreeWalker === 'function') {
        try {
          // 5 = SHOW_ELEMENT | SHOW_TEXT
          const walker = doc.createTreeWalker(node, 5);
          let current = walker.nextNode();
          while (current) {
            if (current.nodeType === 3) translateTextNode(current);
            else translateAttributes(current);
            current = walker.nextNode();
          }
          applying = false;
          return;
        } catch (_) { /* 退回递归遍历 */ }
      }
      const children = node.childNodes ? Array.from(node.childNodes) : [];
      for (const child of children) walk(child);
      applying = false;
    }

    function pruneTracked() {
      if (trackedTexts.size <= 4000 && trackedAttrs.size <= 4000) return;
      for (const node of trackedTexts) {
        if (node.isConnected === false) trackedTexts.delete(node);
      }
      for (const element of trackedAttrs) {
        if (element.isConnected === false) trackedAttrs.delete(element);
      }
    }

    function report() {
      if (typeof opts.onStats !== 'function') return;
      try {
        // 统计口径 = 当前生效的汉化处数（关闭或还原后自然归零）
        opts.onStats({ enabled: enabled, translatedTexts: trackedTexts.size, tracked: trackedTexts.size });
      } catch (_) { /* 忽略 */ }
    }

    function flush() {
      pending = false;
      if (!enabled) {
        queue = [];
        return;
      }
      const batch = queue;
      queue = [];
      for (const item of batch) {
        try {
          walk(item);
        } catch (_) { /* 单个节点失败不影响其他 */ }
      }
      pruneTracked();
      report();
    }

    function schedule(node) {
      if (!enabled || applying) return;
      queue.push(node || doc.body);
      if (pending) return;
      pending = true;
      if (typeof root.requestIdleCallback === 'function') {
        root.requestIdleCallback(flush, { timeout: 300 });
      } else {
        setTimeout(flush, 60);
      }
    }

    function onMutations(mutations) {
      if (!enabled || applying) return;
      for (const mutation of mutations) {
        if (!mutation) continue;
        if (mutation.type === 'characterData') {
          if (mutation.target) schedule(mutation.target);
        } else if (mutation.type === 'childList') {
          for (const added of Array.from(mutation.addedNodes || [])) schedule(added);
        } else if (mutation.type === 'attributes') {
          schedule(mutation.target);
        }
      }
    }

    function translateTitle() {
      if (!titleOriginal) return;
      const translated = translateUiText(titleOriginal, dictionary);
      if (translated) {
        try { doc.title = translated; } catch (_) { /* 忽略 */ }
      }
    }

    function restoreAll() {
      for (const node of trackedTexts) {
        const record = originals.get(node);
        if (record && node.nodeValue === record.translated) {
          applying = true;
          node.nodeValue = record.raw;
          applying = false;
        }
      }
      trackedTexts.clear();
      for (const element of trackedAttrs) {
        const store = attrOriginals.get(element);
        if (!store) continue;
        for (const [attr, raw] of Object.entries(store)) {
          try {
            if (element.getAttribute(attr) !== raw) element.setAttribute(attr, raw);
          } catch (_) { /* 忽略 */ }
        }
      }
      trackedAttrs.clear();
    }

    function enable() {
      if (enabled) return;
      enabled = true;
      try {
        if (doc.documentElement) doc.documentElement.setAttribute('lang', 'zh-CN');
      } catch (_) { /* 忽略 */ }
      translateTitle();
      schedule(doc.body);
      if (typeof root.MutationObserver === 'function') {
        try {
          observer = new root.MutationObserver(onMutations);
          observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
        } catch (_) {
          observer = null;
        }
      }
      report();
    }

    function disable() {
      if (!enabled && !observer) return;
      enabled = false;
      if (observer) {
        try { observer.disconnect(); } catch (_) { /* 忽略 */ }
        observer = null;
      }
      restoreAll();
      try {
        if (doc.documentElement) {
          if (htmlLangOriginal == null) doc.documentElement.removeAttribute('lang');
          else doc.documentElement.setAttribute('lang', htmlLangOriginal);
        }
        if (titleOriginal != null) doc.title = titleOriginal;
      } catch (_) { /* 忽略 */ }
      report();
    }

    return {
      enable: enable,
      disable: disable,
      // 手动重扫：测试用，也用于「框架整体替换 DOM 但未触发可观察变更」的场景。
      scan: function (node) {
        if (!enabled) return;
        walk(node || doc.body);
        report();
      },
      isEnabled: function () { return enabled; },
      getStats: function () {
        return { enabled: enabled, translatedTexts: trackedTexts.size, tracked: trackedTexts.size };
      },
    };
  }

  // --- 浮窗定位与渲染 -------------------------------------------------------

  function calculatePanelPosition(anchorRect, panelSize, viewport, options) {
    const opts = options || {};
    const gap = opts.gap != null ? opts.gap : 12;
    const margin = opts.margin != null ? opts.margin : 12;
    const width = Math.max(0, panelSize.width || 0);
    const height = Math.max(0, panelSize.height || 0);
    const rightSpace = viewport.width - anchorRect.right;
    const leftSpace = anchorRect.left;
    const fitsRight = rightSpace >= width + gap;
    const fitsLeft = leftSpace >= width + gap;
    const side = fitsRight || (!fitsLeft && rightSpace >= leftSpace) ? 'right' : 'left';
    const preferredLeft = side === 'right'
      ? anchorRect.right + gap
      : anchorRect.left - width - gap;
    const preferredTop = anchorRect.top + (anchorRect.height - height) / 2;
    const maxLeft = Math.max(margin, viewport.width - width - margin);
    const maxTop = Math.max(margin, viewport.height - height - margin);
    return {
      left: Math.min(Math.max(preferredLeft, margin), maxLeft),
      top: Math.min(Math.max(preferredTop, margin), maxTop),
      side: side,
    };
  }

  function clearPanel(panel) {
    if (typeof panel.replaceChildren === 'function') {
      panel.replaceChildren();
      return;
    }
    if (Array.isArray(panel.children)) panel.children.length = 0;
  }

  function prefixLines(text) {
    return String(text || '').split('\n').map((line) => (
      line.trim() === '' ? line : '· ' + line
    )).join('\n');
  }

  // 把记录拆成若干「牌面」区块：本体 + 名称不同的其他牌面（如双面牌）。
  function buildSections(record) {
    if (!record) return [];
    const mainName = record.name_zh || record.name_en || '';
    const mainKey = normalizeComparable(mainName);
    const sections = [{
      name: mainName,
      type: record.type_zh || record.type_en || '',
      text: record.text_zh || record.text_en || '',
      isMain: true,
    }];
    for (const face of record.faces || []) {
      const faceName = face.name_zh || face.name_en;
      if (!faceName) continue;
      const faceKey = normalizeComparable(faceName);
      if (!faceKey || faceKey === mainKey) continue;
      if (sections.some((section) => normalizeComparable(section.name) === faceKey)) continue;
      sections.push({
        name: faceName,
        type: face.type_zh || face.type_en || '',
        text: face.text_zh || face.text_en || '',
        isMain: false,
      });
    }
    return sections;
  }

  function renderCardPanel(doc, panel, record, glossary) {
    clearPanel(panel);

    const sections = buildSections(record);
    sections.forEach((section, index) => {
      if (index > 0) {
        const divider = doc.createElement('div');
        divider.className = 'endstep-cn-card-divider';
        divider.style.cssText = 'margin:8px 0 6px;border-top:1px dashed rgba(255,255,255,.22);';
        panel.appendChild(divider);
      }

      const name = doc.createElement('div');
      name.className = 'endstep-cn-card-name';
      name.style.color = 'var(--endstep-cn-name-color)';
      name.style.fontSize = 'var(--endstep-cn-name-size)';
      name.style.fontWeight = '700';
      name.textContent = section.name;
      if (section.isMain && record.mana_cost) {
        const mana = doc.createElement('span');
        mana.className = 'endstep-cn-card-mana';
        mana.textContent = ' ' + record.mana_cost.replace(/\s+/g, '');
        mana.style.color = 'var(--endstep-cn-type-color)';
        mana.style.fontSize = 'var(--endstep-cn-type-size)';
        mana.style.fontWeight = '400';
        name.appendChild(mana);
      }
      panel.appendChild(name);

      if (section.type) {
        const type = doc.createElement('div');
        type.className = 'endstep-cn-card-type';
        type.textContent = section.type;
        type.style.color = 'var(--endstep-cn-type-color)';
        type.style.fontSize = 'var(--endstep-cn-type-size)';
        type.style.fontStyle = 'italic';
        type.style.fontWeight = '300';
        type.style.textDecoration = 'underline';
        type.style.marginTop = '2px';
        panel.appendChild(type);
      }

      const text = doc.createElement('div');
      text.className = 'endstep-cn-card-text';
      text.textContent = prefixLines(section.text);
      text.style.fontSize = 'var(--endstep-cn-text-size)';
      text.style.color = 'var(--endstep-cn-text-color)';
      text.style.fontWeight = '400';
      text.style.lineHeight = '1.5';
      text.style.marginTop = '6px';
      text.style.whiteSpace = 'pre-wrap';
      if (section.text) panel.appendChild(text);
    });

    if (!record.hasZh) {
      const note = doc.createElement('div');
      note.className = 'endstep-cn-card-note';
      note.textContent = FALLBACK_NOTE;
      note.style.cssText = 'margin-top:6px;font-size:11px;color:#e0a3a3;';
      panel.appendChild(note);
    }

    const resolvedKeywords = [];
    for (const keyword of record.keywords || []) {
      const entry = lookupKeywordEntry(keyword, glossary);
      if (entry) resolvedKeywords.push({ keyword, entry });
    }
    if (resolvedKeywords.length) {
      const block = doc.createElement('div');
      block.className = 'endstep-cn-card-keywords';
      block.style.color = 'var(--endstep-cn-keyword-color)';
      block.style.fontSize = 'var(--endstep-cn-keyword-size)';
      block.style.lineHeight = '1.5';
      block.style.marginTop = '6px';
      const label = doc.createElement('div');
      label.textContent = '关键词';
      label.style.fontWeight = '600';
      label.style.marginBottom = '1px';
      block.appendChild(label);
      for (const { keyword, entry } of resolvedKeywords) {
        const line = doc.createElement('div');
        line.textContent = '· ' + (entry.name_zh || keyword) + '：' + (entry.desc_zh || '');
        block.appendChild(line);
      }
      panel.appendChild(block);
    }

    const footer = doc.createElement('div');
    footer.className = 'endstep-cn-card-footer';
    footer.style.cssText = 'margin-top:7px;font-size:10px;line-height:1.4;color:rgba(255,255,255,.45);';
    const setLine = [record.set_zh || record.set, record.collector_number].filter(Boolean).join(' · ');
    footer.textContent = (record.hasZh ? ATTRIBUTION_TEXT : '来源：Scryfall（英文）') +
      (setLine ? ' · ' + setLine : '');
    panel.appendChild(footer);
  }

  // --- 主安装 ---------------------------------------------------------------

  function installProbe(doc, injected) {
    if (!doc || !doc.body || typeof doc.createElement !== 'function') {
      return { destroy: function () {} };
    }

    const options = injected || {};
    let settings = loadSettings();
    const client = options.client || createMtgchClient();
    let glossary = Object.assign({}, BUILTIN_GLOSSARY);

    // --- 样式变量 ---

    const styleTag = doc.createElement('style');
    styleTag.id = 'endstep-cn-styles';
    styleTag.textContent = '';
    (doc.head || doc.documentElement || doc.body).appendChild(styleTag);

    function applyStyleVariables(vars) {
      styleTag.textContent =
        ':root {' +
        '--endstep-cn-bg-color:' + (vars.bgColor || '12, 10, 8') + ';' +
        '--endstep-cn-bg-opacity:' + (vars.bgOpacity != null ? vars.bgOpacity : 0.95) + ';' +
        '--endstep-cn-border-color:' + (vars.borderColor || '217, 180, 91') + ';' +
        '--endstep-cn-border-opacity:' + (vars.borderOpacity != null ? vars.borderOpacity : 0.4) + ';' +
        '--endstep-cn-text-color:' + (vars.textColor || '#f2ead8') + ';' +
        '--endstep-cn-name-color:' + (vars.nameColor || '#d9b45b') + ';' +
        '--endstep-cn-name-size:' + (vars.nameSize || 15) + 'px;' +
        '--endstep-cn-type-color:' + (vars.typeColor || '#c8bfa6') + ';' +
        '--endstep-cn-type-size:' + (vars.typeSize || 12) + 'px;' +
        '--endstep-cn-text-size:' + (vars.textSize || 13) + 'px;' +
        '--endstep-cn-keyword-color:' + (vars.keywordColor || '#8fd8c7') + ';' +
        '--endstep-cn-keyword-size:' + (vars.keywordSize || 11) + 'px;' +
        '}';
    }
    applyStyleVariables(settings);

    if (!options.client) {
      loadGlossary().then((loaded) => {
        glossary = loaded;
        if (currentRecord && panel.style.display !== 'none') {
          presentCard(currentAnchor, currentRecord, currentStage, currentDebug);
        }
      });
    }

    // --- 界面汉化接线 --------------------------------------------------------

    const uiDictionary = options.uiDictionary || createUiDictionary(UI_TERMS, UI_PATTERNS);
    let uiStats = { enabled: false, translatedTexts: 0, tracked: 0 };
    const uiTranslator = options.uiTranslator || createUiTranslator(doc, uiDictionary, {
      onStats: (stats) => { uiStats = stats; },
    });

    function refreshUiMenu() {
      const on = settings.uiTranslate !== false;
      registerMenuCommand((on ? '☑ ' : '☐ ') + '界面汉化', toggleUiTranslation, 'endstep-cn-menu-ui', false);
    }

    function setUiTranslation(nextEnabled) {
      settings.uiTranslate = Boolean(nextEnabled);
      saveSettings(settings);
      try {
        if (settings.uiTranslate) uiTranslator.enable();
        else uiTranslator.disable();
      } catch (_) { /* 汉化失败不影响卡牌浮窗 */ }
      refreshUiMenu();
    }

    function toggleUiTranslation() {
      setUiTranslation(settings.uiTranslate !== true);
      showModeToast(settings.uiTranslate ? '界面汉化已开启' : '界面汉化已关闭（已还原原文）');
    }

    // --- 中文卡图（大学院废墟） ----------------------------------------------
    // 站点 CSP 的 img-src 只允许 'self' / data: / blob: / *.scryfall.io，
    // 直接给 <img> 填 images.mtgch.com 的地址会被浏览器拦掉，因此这里用 GM_xmlhttpRequest
    // 取回图片二进制，转成 CSP 允许的 data: URL 再交给 <img>。
    // 数据来源仍是识别阶段已取到的 record.image_zh，所以不会产生额外的 API 请求。

    const swappedImages = new Map(); // img 元素 -> { src, srcset }（原始值，用于还原）
    const originalToZh = new Map();  // 原始 src -> 可直接显示的 data: URL（便于重渲染后重放）
    const imageCache = new Map();    // 中文图址 -> { status, url, promise }
    const imageOrder = [];
    let imageObserver = null;

    function pushImageCache(key, entry) {
      imageCache.set(key, entry);
      imageOrder.push(key);
      while (imageOrder.length > IMAGE_CACHE_MAX_ENTRIES) {
        const oldest = imageOrder.shift();
        const stale = imageCache.get(oldest);
        // 仍在下载中的条目先留着，避免重复发起请求
        if (stale && stale.status === 'pending') { imageOrder.push(oldest); break; }
        imageCache.delete(oldest);
      }
    }

    function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return typeof root.btoa === 'function' ? root.btoa(binary) : '';
    }

    function blobToDataUrl(blob) {
      return new Promise((resolve, reject) => {
        try {
          const reader = new root.FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error('读取图片失败'));
          reader.readAsDataURL(blob);
        } catch (error) {
          reject(error);
        }
      });
    }

    function requestImageArrayBuffer(url) {
      return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest !== 'function') {
          reject(new Error('当前环境不支持 GM_xmlhttpRequest'));
          return;
        }
        try {
          GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            responseType: 'arraybuffer',
            timeout: REQUEST_TIMEOUT_MS,
            onload: (response) => {
              const status = response ? response.status : 0;
              if (status < 200 || status >= 300) { reject(new Error('HTTP ' + status)); return; }
              const buffer = response && response.response;
              if (!buffer) { reject(new Error('空响应')); return; }
              const base64 = arrayBufferToBase64(buffer);
              if (!base64) { reject(new Error('无法编码图片')); return; }
              resolve('data:image/webp;base64,' + base64);
            },
            onerror: () => reject(new Error('网络错误')),
            ontimeout: () => reject(new Error('请求超时')),
          });
        } catch (error) {
          reject(error);
        }
      });
    }

    function requestImageDataUrl(url) {
      return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest !== 'function') {
          reject(new Error('当前环境不支持 GM_xmlhttpRequest'));
          return;
        }
        try {
          GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            responseType: 'blob',
            timeout: REQUEST_TIMEOUT_MS,
            onload: (response) => {
              const status = response ? response.status : 0;
              if (status < 200 || status >= 300) { reject(new Error('HTTP ' + status)); return; }
              const blob = response && response.response;
              if (blob && typeof blob.size === 'number' && blob.size > 0) {
                blobToDataUrl(blob).then(resolve, reject);
                return;
              }
              // 少数管理器不支持 blob 响应，退回 arraybuffer 再自行编码
              requestImageArrayBuffer(url).then(resolve, reject);
            },
            onerror: () => reject(new Error('网络错误')),
            ontimeout: () => reject(new Error('请求超时')),
          });
        } catch (error) {
          reject(error);
        }
      });
    }

    function getChineseImageDataUrl(zhUrl) {
      const cached = imageCache.get(zhUrl);
      if (cached) return cached.promise;
      const entry = { status: 'pending', url: null };
      entry.promise = requestImageDataUrl(zhUrl)
        .then((dataUrl) => {
          if (!dataUrl || dataUrl.indexOf('data:') !== 0) throw new Error('图片格式无效');
          entry.status = 'ready';
          entry.url = dataUrl;
          return dataUrl;
        })
        .catch(() => {
          entry.status = 'error';
          entry.url = null;
          return null;
        });
      pushImageCache(zhUrl, entry);
      return entry.promise;
    }

    function resolveAnchorImage(anchor) {
      if (!anchor) return null;
      if (String(anchor.tagName || '').toLowerCase() === 'img') return anchor;
      if (typeof anchor.querySelector === 'function') return anchor.querySelector('img');
      return null;
    }

    // <picture> 内的 <source> 与 <img> 自身的 srcset 优先级都高于 src，需一并让位。
    function pictureSources(image) {
      const parent = image && image.parentElement;
      if (!parent || String(parent.tagName || '').toLowerCase() !== 'picture') return [];
      if (typeof parent.querySelectorAll !== 'function') return [];
      try { return Array.from(parent.querySelectorAll('source')); } catch (_) { return []; }
    }

    function suppressSrcset(image) {
      for (const source of pictureSources(image)) source.removeAttribute('srcset');
      image.removeAttribute('srcset');
    }

    function swapImage(img, originalSrc, displayUrl) {
      if (!img || !displayUrl) return;
      if (!swappedImages.has(img)) {
        swappedImages.set(img, {
          src: originalSrc,
          srcset: img.getAttribute('srcset'),
          sources: pictureSources(img).map((source) => ({ el: source, srcset: source.getAttribute('srcset') })),
        });
      }
      try {
        suppressSrcset(img);
        img.setAttribute('src', displayUrl);
        img.setAttribute('data-endstep-cn-image', '1');
      } catch (_) { /* 忽略 */ }
    }

    function restoreCardImages() {
      for (const [img, original] of swappedImages) {
        try {
          if (original.src != null) img.setAttribute('src', original.src);
          else img.removeAttribute('src');
          if (original.srcset != null) img.setAttribute('srcset', original.srcset);
          for (const entry of original.sources || []) {
            if (entry.srcset != null) entry.el.setAttribute('srcset', entry.srcset);
          }
          if (typeof img.removeAttribute === 'function') img.removeAttribute('data-endstep-cn-image');
        } catch (_) { /* 元素可能已被移除 */ }
      }
      swappedImages.clear();
    }

    function reapplyKnownImage(img) {
      if (settings.cardImage === false || !img || img.nodeType !== 1) return;
      const src = img.getAttribute('src');
      if (!src) return;
      const dataUrl = originalToZh.get(src);
      if (dataUrl && dataUrl !== src) { swapImage(img, src, dataUrl); return; }
      // 已换成 data: URL 但 React 又把 srcset / <source> 补回来时，重新压制以免覆盖
      const hasSrcset = typeof img.hasAttribute === 'function' && img.hasAttribute('srcset');
      if (src.indexOf('data:') === 0 && (hasSrcset || pictureSources(img).length)) {
        try { suppressSrcset(img); } catch (_) { /* 忽略 */ }
      }
    }

    function reapplyKnownImagesIn(node) {
      if (!node || node.nodeType !== 1) return;
      if (String(node.tagName || '').toLowerCase() === 'img') { reapplyKnownImage(node); return; }
      if (typeof node.querySelectorAll !== 'function') return;
      try {
        node.querySelectorAll('img').forEach(reapplyKnownImage);
      } catch (_) { /* 忽略 */ }
    }

    function ensureImageObserver() {
      const ObserverCtor = root.MutationObserver;
      if (imageObserver || typeof ObserverCtor !== 'function') return;
      imageObserver = new ObserverCtor((mutations) => {
        if (settings.cardImage === false) return;
        for (const mutation of mutations) {
          if (mutation.type === 'attributes') {
            reapplyKnownImage(mutation.target);
          } else if (mutation.addedNodes) {
            mutation.addedNodes.forEach((node) => {
              if (node && node.nodeType === 1) reapplyKnownImagesIn(node);
            });
          }
        }
      });
      const target = doc.documentElement || doc.body;
      if (target) {
        imageObserver.observe(target, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['src', 'srcset'],
        });
      }
    }

    function stopImageObserver() {
      if (!imageObserver) return;
      try { imageObserver.disconnect(); } catch (_) { /* 忽略 */ }
      imageObserver = null;
    }

    // 悬停识别成功后调用：把该卡的中文卡图换成大学院废墟的图（失败则静默保留原图）。
    async function applyChineseImageFor(anchor, record) {
      if (settings.cardImage === false) return null;
      const img = resolveAnchorImage(anchor);
      if (!img || swappedImages.has(img)) return null;
      const zhUrl = str(record && record.image_zh);
      if (!isChineseCardImageUrl(zhUrl)) return null;
      const originalSrc = img.getAttribute('src') || '';
      if (!originalSrc || originalSrc.indexOf('data:') === 0) return null;
      const dataUrl = await getChineseImageDataUrl(zhUrl);
      if (!dataUrl || settings.cardImage === false) return null;
      if (typeof img.isConnected === 'boolean' && !img.isConnected) return null;
      originalToZh.set(originalSrc, dataUrl);
      swapImage(img, originalSrc, dataUrl);
      reapplyKnownImagesIn(doc.body); // 同名卡的多份副本一并替换
      return zhUrl;
    }

    function refreshCardImageMenu() {
      const on = settings.cardImage !== false;
      registerMenuCommand((on ? '☑ ' : '☐ ') + '中文卡图', toggleCardImage, 'endstep-cn-menu-image', false);
    }

    function setCardImage(nextEnabled) {
      settings.cardImage = Boolean(nextEnabled);
      saveSettings(settings);
      if (settings.cardImage) {
        ensureImageObserver();
        reapplyKnownImagesIn(doc.body);
      } else {
        restoreCardImages();
      }
      refreshCardImageMenu();
    }

    function toggleCardImage() {
      setCardImage(settings.cardImage === false);
      showModeToast(settings.cardImage
        ? '中文卡图已开启（悬停过的卡牌改用大学院废墟中文卡图）'
        : '中文卡图已关闭（已还原原文卡图）');
    }

    // --- 浮窗 ---

    const panel = doc.createElement('div');
    panel.id = 'endstep-cn-panel';
    panel.style.cssText = [
      'position:fixed',
      'left:0',
      'top:0',
      'z-index:2147483647',
      'display:none',
      'visibility:hidden',
      'max-width:330px',
      'max-height:48vh',
      'overflow:auto',
      'padding:9px 11px',
      'border:1px solid rgba(var(--endstep-cn-border-color),var(--endstep-cn-border-opacity))',
      'border-radius:6px',
      'background:rgba(var(--endstep-cn-bg-color),var(--endstep-cn-bg-opacity))',
      'color:var(--endstep-cn-text-color)',
      'box-shadow:0 4px 18px rgba(0,0,0,.4)',
      'pointer-events:none',
      'font:13px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    ].join(';');
    doc.body.appendChild(panel);

    // --- 固定模式抓手 ---

    const dragHandle = doc.createElement('div');
    dragHandle.className = 'endstep-cn-drag-handle';
    dragHandle.title = '按住拖动可移动窗格';
    dragHandle.textContent = '⠿ ⠿ ⠿';
    dragHandle.style.cssText = [
      'display:none',
      'height:20px',
      'cursor:grab',
      'margin:-9px -11px 6px -11px',
      'border-radius:6px 6px 0 0',
      'background:rgba(255,255,255,0.06)',
      'color:rgba(255,255,255,0.45)',
      'text-align:center',
      'font-size:11px',
      'line-height:20px',
      'letter-spacing:4px',
      'user-select:none',
      '-webkit-user-select:none',
    ].join(';');
    dragHandle.addEventListener('mouseenter', () => {
      dragHandle.style.background = 'rgba(255,255,255,0.14)';
      dragHandle.style.color = 'rgba(255,255,255,0.8)';
    });
    dragHandle.addEventListener('mouseleave', () => {
      dragHandle.style.background = 'rgba(255,255,255,0.06)';
      dragHandle.style.color = 'rgba(255,255,255,0.45)';
    });
    panel.insertBefore(dragHandle, panel.firstChild);

    let dragState = null;

    function onDragMouseDown(event) {
      if (settings.panelMode !== 'fixed') return;
      if (event.target !== dragHandle) return;
      if (event.button !== 0) return;
      event.preventDefault();
      dragHandle.style.cursor = 'grabbing';
      dragState = {
        startX: event.clientX,
        startY: event.clientY,
        startLeft: panel.offsetLeft,
        startTop: panel.offsetTop,
      };
      doc.addEventListener('mousemove', onDragMouseMove);
      doc.addEventListener('mouseup', onDragMouseUp);
    }

    function onDragMouseMove(event) {
      if (!dragState) return;
      panel.style.left = (dragState.startLeft + event.clientX - dragState.startX) + 'px';
      panel.style.top = (dragState.startTop + event.clientY - dragState.startY) + 'px';
    }

    function onDragMouseUp() {
      if (!dragState) return;
      doc.removeEventListener('mousemove', onDragMouseMove);
      doc.removeEventListener('mouseup', onDragMouseUp);
      dragState = null;
      dragHandle.style.cursor = 'grab';
      settings.panelPosition = {
        left: parseInt(panel.style.left, 10) || 0,
        top: parseInt(panel.style.top, 10) || 0,
      };
      saveSettings(settings);
    }

    panel.addEventListener('mousedown', onDragMouseDown);

    // --- 状态 ---

    let hoverSerial = 0;
    let currentAnchor = null;
    let currentRecord = null;
    let currentStage = '';
    let currentDebug = null;
    let debugState = {
      anchorTag: '', anchorClass: '', anchorUuid: null, anchorSet: null,
      anchorNames: [], stages: [], stage: '', fallback: false, source: '',
    };

    const getViewport = () => ({
      width: Number(root.innerWidth) || 1024,
      height: Number(root.innerHeight) || 768,
    });

    const repositionPanel = () => {
      if (settings.panelMode === 'fixed') return;
      if (!currentAnchor || panel.style.display === 'none') return;
      if (typeof currentAnchor.getBoundingClientRect !== 'function') return;
      const anchorRect = currentAnchor.getBoundingClientRect();
      const panelSize = {
        width: Number(panel.offsetWidth) || 300,
        height: Number(panel.offsetHeight) || 100,
      };
      const position = calculatePanelPosition(anchorRect, panelSize, getViewport());
      panel.style.left = position.left + 'px';
      panel.style.top = position.top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    };

    let followRafId = null;

    function scheduleFollowingTick(fn) {
      if (typeof root.requestAnimationFrame === 'function') return root.requestAnimationFrame(fn);
      if (typeof setTimeout === 'function') return setTimeout(fn, 16);
      return null;
    }

    function cancelFollowingTick(id) {
      if (id == null) return;
      if (typeof root.cancelAnimationFrame === 'function') root.cancelAnimationFrame(id);
      else clearTimeout(id);
    }

    function startFollowing() {
      stopFollowing();
      function tick() {
        if (settings.panelMode === 'fixed' || !currentAnchor || panel.style.display === 'none') {
          stopFollowing();
          return;
        }
        repositionPanel();
        followRafId = scheduleFollowingTick(tick);
      }
      followRafId = scheduleFollowingTick(tick);
    }

    function stopFollowing() {
      if (followRafId) {
        cancelFollowingTick(followRafId);
        followRafId = null;
      }
    }

    // --- 调试区块 ---

    function renderDebugPanel() {
      if (!isDebugEnabled()) return;
      let dbg = typeof panel.querySelector === 'function' ? panel.querySelector('.endstep-cn-debug') : null;
      if (!dbg) {
        dbg = doc.createElement('div');
        dbg.className = 'endstep-cn-debug';
        dbg.style.cssText = [
          'margin-top:6px;padding-top:4px;',
          'border-top:1px dashed rgba(255,255,255,.25);',
          'font-size:10px;line-height:1.4;',
          'color:rgba(255,255,255,.6);white-space:pre-wrap;',
        ].join('');
        panel.appendChild(dbg);
      }
      dbg.textContent = [
        '元素: ' + (debugState.anchorTag || '(无)') + (debugState.anchorClass ? ' .' + debugState.anchorClass : ''),
        'uuid: ' + (debugState.anchorUuid || '(无)'),
        'set: ' + (debugState.anchorSet || '(无)'),
        '名称候选: ' + (debugState.anchorNames.join(' | ') || '(无)'),
        '阶段: ' + (debugState.stage || '(无)') + (debugState.fallback ? ' (英文回退)' : ''),
        '轨迹: ' + (debugState.stages.join(' , ') || '(无)'),
        '汉化: ' + (uiStats && uiStats.enabled
          ? '开 · 已译 ' + uiStats.translatedTexts + ' 处'
          : '关'),
        '中文卡图: ' + (settings.cardImage === false ? '关' : '开 · 已换 ' + swappedImages.size + ' 张'),
      ].join('\n');
    }

    // --- 显隐 ---

    function showLoading(anchor) {
      currentAnchor = anchor;
      currentRecord = null;
      panel.textContent = LOADING_TEXT;
      if (settings.panelMode === 'fixed') panel.insertBefore(dragHandle, panel.firstChild);
      panel.style.display = 'block';
      panel.style.visibility = 'hidden';
      repositionPanel();
      panel.style.visibility = 'visible';
      if (settings.panelMode === 'follow') startFollowing();
    }

    function presentCard(anchor, record, stage, debug) {
      currentAnchor = anchor;
      currentRecord = record;
      currentStage = stage || '';
      currentDebug = debug || null;
      panel.style.display = 'block';
      panel.style.visibility = 'hidden';
      renderCardPanel(doc, panel, record, glossary);
      applyChineseImageFor(anchor, record);
      if (isDebugEnabled() && debug && debug.identity) {
        debugState.anchorTag = String((anchor && anchor.tagName) || '').toLowerCase();
        debugState.anchorClass = String((anchor && anchor.className) || '');
        debugState.anchorUuid = debug.identity.uuid || null;
        debugState.anchorSet = debug.identity.setCollector
          ? debug.identity.setCollector.set + '/' + debug.identity.setCollector.collector
          : null;
        debugState.anchorNames = debug.identity.names || [];
        debugState.stages = debug.stages || [];
        debugState.stage = currentStage;
        debugState.fallback = !record.hasZh;
      }
      renderDebugPanel();
      if (settings.panelMode === 'fixed') panel.insertBefore(dragHandle, panel.firstChild);
      repositionPanel();
      panel.style.visibility = 'visible';
      if (settings.panelMode === 'follow') startFollowing();
    }

    function hidePanel() {
      currentAnchor = null;
      currentRecord = null;
      stopFollowing();
      if (settings.panelMode === 'fixed') return;
      panel.style.display = 'none';
      panel.style.visibility = 'hidden';
    }

    // --- 模式切换 ---

    function updatePanelMode(mode) {
      settings.panelMode = mode;
      if (mode === 'fixed') {
        panel.style.pointerEvents = 'auto';
        dragHandle.style.display = 'block';
        stopFollowing();
        if (settings.panelPosition) {
          panel.style.left = settings.panelPosition.left + 'px';
          panel.style.top = settings.panelPosition.top + 'px';
        } else {
          const rect = panel.getBoundingClientRect();
          let pinnedLeft = rect.left;
          let pinnedTop = rect.top;
          if (!pinnedLeft && !pinnedTop && panel.style.display === 'none') {
            const viewport = getViewport();
            pinnedLeft = Math.round(viewport.width * 0.7);
            pinnedTop = Math.round(viewport.height * 0.12);
          }
          settings.panelPosition = { left: pinnedLeft, top: pinnedTop };
        }
        panel.style.left = settings.panelPosition.left + 'px';
        panel.style.top = settings.panelPosition.top + 'px';
        panel.style.display = 'block';
        panel.style.visibility = 'visible';
      } else {
        panel.style.pointerEvents = 'none';
        dragHandle.style.display = 'none';
        settings.panelPosition = null;
        if (!currentAnchor) hidePanel();
      }
      saveSettings(settings);
    }

    let modeFeedbackTimer = null;

    function showModeToast(text) {
      if (modeFeedbackTimer) {
        if (typeof clearTimeout === 'function') clearTimeout(modeFeedbackTimer);
        modeFeedbackTimer = null;
      }
      panel.textContent = text;
      if (settings.panelMode === 'fixed') panel.insertBefore(dragHandle, panel.firstChild);
      panel.style.display = 'block';
      panel.style.visibility = 'visible';
      if (typeof setTimeout === 'function') {
        modeFeedbackTimer = setTimeout(() => {
          modeFeedbackTimer = null;
          if (settings.panelMode === 'fixed') return;
          hidePanel();
        }, 1600);
      }
    }

    function togglePanelMode() {
      const newMode = settings.panelMode === 'follow' ? 'fixed' : 'follow';
      updatePanelMode(newMode);
      refreshPanelModeMenu();
      showModeToast(newMode === 'fixed'
        ? '浮窗已固定 — 拖住顶部抓手可移动'
        : '已切换为跟随卡牌模式');
    }

    function toggleDebugMode() {
      const on = isDebugEnabled();
      try {
        if (on) root.localStorage.removeItem(DEBUG_KEY);
        else root.localStorage.setItem(DEBUG_KEY, '1');
      } catch (_) { /* localStorage 不可用 */ }
      refreshDebugMenu();
      showModeToast(on ? '调试模式已关闭' : '调试模式已开启 — 悬停卡牌可按 F12 查看控制台');
    }

    // 初始化固定模式的持久位置
    if (settings.panelMode === 'fixed' && settings.panelPosition) {
      panel.style.left = settings.panelPosition.left + 'px';
      panel.style.top = settings.panelPosition.top + 'px';
      panel.style.pointerEvents = 'auto';
      dragHandle.style.display = 'block';
      panel.style.display = 'block';
      panel.style.visibility = 'visible';
      panel.textContent = '已固定 — 悬停卡牌查看中文';
      panel.insertBefore(dragHandle, panel.firstChild);
    }

    // --- 设置对话框 ---

    let settingsOverlay = null;

    function closeSettingsDialog() {
      if (settingsOverlay) {
        if (settingsOverlay._keydownHandler) {
          doc.removeEventListener('keydown', settingsOverlay._keydownHandler);
        }
        settingsOverlay.remove();
        settingsOverlay = null;
      }
    }

    function openSettingsDialog() {
      closeSettingsDialog();
      const saved = loadSettings();

      settingsOverlay = doc.createElement('div');
      settingsOverlay.id = 'endstep-cn-settings-overlay';
      settingsOverlay.style.cssText = [
        'position:fixed;inset:0;z-index:2147483646;',
        'background:rgba(0,0,0,.5);',
        'display:flex;align-items:center;justify-content:center;',
      ].join('');

      const dialog = doc.createElement('div');
      dialog.id = 'endstep-cn-settings-dialog';
      dialog.style.cssText = [
        'background:#17130d;color:#e8e0cf;',
        'border:1px solid rgba(217,180,91,.35);border-radius:10px;',
        'padding:12px 14px;width:330px;max-width:calc(100vw - 20px);',
        'max-height:90vh;overflow-y:auto;',
        'font:13px/1.4 system-ui,sans-serif;',
        'box-shadow:0 8px 32px rgba(0,0,0,.55);',
      ].join('');
      dialog.addEventListener('click', (event) => event.stopPropagation());

      const previewLabel = doc.createElement('div');
      previewLabel.textContent = '效果预览';
      previewLabel.style.cssText = 'font-size:11px;font-weight:600;color:#a99a78;margin-bottom:4px;';
      dialog.appendChild(previewLabel);

      const preview = doc.createElement('div');
      preview.id = 'endstep-cn-settings-preview';
      preview.style.cssText = [
        'margin-bottom:10px;padding:8px 10px;border-radius:6px;',
        'border:1px solid rgba(var(--endstep-cn-border-color),var(--endstep-cn-border-opacity));',
        'background:rgba(var(--endstep-cn-bg-color),var(--endstep-cn-bg-opacity));',
        'color:var(--endstep-cn-text-color);',
      ].join('');

      const previewName = doc.createElement('div');
      previewName.textContent = '闪电击 {R}';
      previewName.style.cssText = 'color:var(--endstep-cn-name-color);font-size:var(--endstep-cn-name-size);font-weight:700;';
      const previewType = doc.createElement('div');
      previewType.textContent = '瞬间';
      previewType.style.cssText = [
        'color:var(--endstep-cn-type-color);font-size:var(--endstep-cn-type-size);',
        'font-style:italic;font-weight:300;text-decoration:underline;margin-top:2px;',
      ].join('');
      const previewText = doc.createElement('div');
      previewText.textContent = '· 对任意一个目标造成 3 点伤害。';
      previewText.style.cssText = 'font-size:var(--endstep-cn-text-size);line-height:1.5;margin-top:4px;white-space:pre-wrap;';
      const previewKeyword = doc.createElement('div');
      previewKeyword.textContent = '关键词\n· 先攻：此生物在正常战斗伤害步骤之前先造成战斗伤害。';
      previewKeyword.style.cssText = 'color:var(--endstep-cn-keyword-color);font-size:var(--endstep-cn-keyword-size);line-height:1.5;margin-top:4px;white-space:pre-wrap;';
      preview.appendChild(previewName);
      preview.appendChild(previewType);
      preview.appendChild(previewText);
      preview.appendChild(previewKeyword);
      dialog.appendChild(preview);

      function makeRow(label) {
        const row = doc.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px;';
        const lbl = doc.createElement('span');
        lbl.textContent = label;
        lbl.style.cssText = 'flex:0 0 auto;font-size:12px;';
        row.appendChild(lbl);
        return row;
      }

      function sectionTitle(text) {
        const t = doc.createElement('div');
        t.textContent = text;
        t.style.cssText = 'font-size:11px;font-weight:600;color:#a99a78;margin:6px 0 4px;';
        return t;
      }

      function makeColorSwatch(value, onChange) {
        const wrap = doc.createElement('span');
        wrap.style.cssText = 'position:relative;display:inline-block;width:22px;height:22px;flex:0 0 auto;';
        const swatch = doc.createElement('span');
        swatch.style.cssText = 'position:absolute;inset:0;border-radius:4px;background-color:' + value + ';border:1px solid rgba(255,255,255,.35);pointer-events:none;';
        const input = doc.createElement('input');
        input.type = 'color';
        input.value = value;
        input.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;border:none;padding:0;';
        input.addEventListener('input', () => {
          swatch.style.backgroundColor = input.value;
          onChange(input.value);
        });
        wrap.appendChild(swatch);
        wrap.appendChild(input);
        return { wrap: wrap, input: input };
      }

      function makeRange(value, onChange) {
        const wrap = doc.createElement('span');
        wrap.style.cssText = 'display:flex;align-items:center;gap:5px;';
        const input = doc.createElement('input');
        input.type = 'range';
        input.min = '0';
        input.max = '1';
        input.step = '0.05';
        input.value = String(value);
        input.style.width = '84px';
        const val = doc.createElement('span');
        val.textContent = String(value);
        val.style.cssText = 'font-size:11px;min-width:28px;text-align:right;';
        input.addEventListener('input', () => {
          val.textContent = String(parseFloat(input.value).toFixed(2));
          onChange(parseFloat(input.value));
        });
        wrap.appendChild(input);
        wrap.appendChild(val);
        return { wrap: wrap, input: input };
      }

      function makeNumber(value, onChange) {
        const wrap = doc.createElement('span');
        wrap.style.cssText = 'display:flex;align-items:center;gap:3px;';
        const input = doc.createElement('input');
        input.type = 'number';
        input.min = '8';
        input.max = '30';
        input.value = String(value);
        input.style.cssText = 'width:50px;background:#241d14;color:#e8e0cf;border:1px solid rgba(255,255,255,.15);border-radius:4px;padding:2px 5px;font-size:12px;';
        input.addEventListener('input', () => {
          const v = parseInt(input.value, 10);
          if (!isNaN(v)) onChange(Math.min(30, Math.max(8, v)));
        });
        const px = doc.createElement('span');
        px.textContent = 'px';
        px.style.cssText = 'font-size:11px;color:#a99a78;';
        wrap.appendChild(input);
        wrap.appendChild(px);
        return { wrap: wrap, input: input };
      }

      dialog.appendChild(sectionTitle('底色与边框'));
      const bgRow = makeRow('底色');
      const bgColorField = makeColorSwatch(rgbToHex(saved.bgColor), previewChanges);
      const bgOpacityField = makeRange(saved.bgOpacity, previewChanges);
      bgRow.appendChild(bgColorField.wrap);
      bgRow.appendChild(bgOpacityField.wrap);
      const borderRow = makeRow('边框');
      const borderColorField = makeColorSwatch(rgbToHex(saved.borderColor), previewChanges);
      const borderOpacityField = makeRange(saved.borderOpacity, previewChanges);
      borderRow.appendChild(borderColorField.wrap);
      borderRow.appendChild(borderOpacityField.wrap);
      dialog.appendChild(bgRow);
      dialog.appendChild(borderRow);

      dialog.appendChild(sectionTitle('字体'));
      function makeFontRow(label, colorValue, sizeValue) {
        const row = makeRow(label);
        const colorField = makeColorSwatch(colorValue, previewChanges);
        const sizeField = makeNumber(sizeValue, previewChanges);
        row.appendChild(colorField.wrap);
        row.appendChild(sizeField.wrap);
        return { row: row, colorField: colorField, sizeField: sizeField };
      }
      const nameFont = makeFontRow('卡名', saved.nameColor, saved.nameSize);
      const typeFont = makeFontRow('类别', saved.typeColor, saved.typeSize);
      const textFont = makeFontRow('正文', saved.textColor, saved.textSize);
      const keywordFont = makeFontRow('关键词', saved.keywordColor, saved.keywordSize);
      dialog.appendChild(nameFont.row);
      dialog.appendChild(typeFont.row);
      dialog.appendChild(textFont.row);
      dialog.appendChild(keywordFont.row);

      dialog.appendChild(sectionTitle('界面'));

      const uiToggleRow = doc.createElement('div');
      uiToggleRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:5px;';
      const uiToggle = doc.createElement('input');
      uiToggle.type = 'checkbox';
      uiToggle.checked = settings.uiTranslate !== false;
      uiToggle.style.cssText = 'width:14px;height:14px;accent-color:#d9b45b;cursor:pointer;margin:0;';
      const uiToggleLabel = doc.createElement('label');
      uiToggleLabel.textContent = '汉化界面文本（按钮 / 菜单 / 标签）';
      uiToggleLabel.style.cssText = 'font-size:12px;cursor:pointer;user-select:none;';
      uiToggleLabel.addEventListener('click', () => { uiToggle.checked = !uiToggle.checked; });
      uiToggleRow.appendChild(uiToggle);
      uiToggleRow.appendChild(uiToggleLabel);
      dialog.appendChild(uiToggleRow);

      const imgToggleRow = doc.createElement('div');
      imgToggleRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:5px;';
      const imgToggle = doc.createElement('input');
      imgToggle.type = 'checkbox';
      imgToggle.checked = settings.cardImage !== false;
      imgToggle.style.cssText = 'width:14px;height:14px;accent-color:#d9b45b;cursor:pointer;margin:0;';
      const imgToggleLabel = doc.createElement('label');
      imgToggleLabel.textContent = '卡牌改用中文卡图（大学院废墟 · 悬停后替换）';
      imgToggleLabel.style.cssText = 'font-size:12px;cursor:pointer;user-select:none;';
      imgToggleLabel.addEventListener('click', () => { imgToggle.checked = !imgToggle.checked; });
      imgToggleRow.appendChild(imgToggle);
      imgToggleRow.appendChild(imgToggleLabel);
      dialog.appendChild(imgToggleRow);

      function hexToRgbString(hex) {
        const clean = String(hex || '').replace('#', '');
        return [
          parseInt(clean.substring(0, 2), 16),
          parseInt(clean.substring(2, 4), 16),
          parseInt(clean.substring(4, 6), 16),
        ].join(', ');
      }

      function readFieldValues() {
        return {
          bgColor: hexToRgbString(bgColorField.input.value),
          borderColor: hexToRgbString(borderColorField.input.value),
          bgOpacity: parseFloat(bgOpacityField.input.value),
          borderOpacity: parseFloat(borderOpacityField.input.value),
          nameColor: nameFont.colorField.input.value,
          nameSize: parseInt(nameFont.sizeField.input.value, 10),
          typeColor: typeFont.colorField.input.value,
          typeSize: parseInt(typeFont.sizeField.input.value, 10),
          textColor: textFont.colorField.input.value,
          textSize: parseInt(textFont.sizeField.input.value, 10),
          keywordColor: keywordFont.colorField.input.value,
          keywordSize: parseInt(keywordFont.sizeField.input.value, 10),
        };
      }

      function previewChanges() {
        applyStyleVariables(readFieldValues());
      }

      const buttonRow = doc.createElement('div');
      buttonRow.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;margin-top:8px;';
      function makeButton(text, primary) {
        const btn = doc.createElement('button');
        btn.textContent = text;
        btn.style.cssText = [
          'padding:5px 12px;border-radius:5px;border:1px solid rgba(255,255,255,.15);',
          'cursor:pointer;font-size:12px;',
          primary
            ? 'background:#d9b45b;color:#1a1409;border-color:#d9b45b;font-weight:600;'
            : 'background:transparent;color:#ccc;',
        ].join('');
        return btn;
      }
      const resetBtn = makeButton('恢复默认', false);
      const cancelBtn = makeButton('取消', false);
      const saveBtn = makeButton('保存', true);
      buttonRow.appendChild(resetBtn);
      buttonRow.appendChild(cancelBtn);
      buttonRow.appendChild(saveBtn);
      dialog.appendChild(buttonRow);

      resetBtn.addEventListener('click', () => {
        settings = Object.assign({}, SETTINGS_DEFAULTS);
        saveSettings(settings);
        applyStyleVariables(SETTINGS_DEFAULTS);
        setCardImage(settings.cardImage);
        closeSettingsDialog();
        openSettingsDialog();
      });
      cancelBtn.addEventListener('click', () => {
        applyStyleVariables(settings);
        closeSettingsDialog();
      });
      saveBtn.addEventListener('click', () => {
        const values = readFieldValues();
        values.panelMode = settings.panelMode;
        values.panelPosition = settings.panelPosition;
        values.uiTranslate = Boolean(uiToggle.checked);
        values.cardImage = Boolean(imgToggle.checked);
        settings = Object.assign({}, SETTINGS_DEFAULTS, values);
        setUiTranslation(settings.uiTranslate);
        setCardImage(settings.cardImage);
        saveSettings(settings);
        applyStyleVariables(settings);
        closeSettingsDialog();
      });

      settingsOverlay.addEventListener('click', (event) => {
        if (event.target === settingsOverlay) {
          applyStyleVariables(settings);
          closeSettingsDialog();
        }
      });

      function onKeyDown(event) {
        if (event.key === 'Escape') {
          applyStyleVariables(settings);
          closeSettingsDialog();
        }
      }
      settingsOverlay._keydownHandler = onKeyDown;
      doc.addEventListener('keydown', onKeyDown);

      settingsOverlay.appendChild(dialog);
      doc.body.appendChild(settingsOverlay);
    }

    // --- GM 菜单 ---

    const menuIds = {
      pin: 'endstep-cn-menu-pin',
      debug: 'endstep-cn-menu-debug',
      style: 'endstep-cn-menu-style',
      cache: 'endstep-cn-menu-cache',
    };

    function registerMenuCommand(label, handler, id, autoClose) {
      if (typeof GM_registerMenuCommand !== 'function') return;
      try {
        GM_registerMenuCommand(label, handler, { id: id, autoClose: autoClose !== false });
      } catch (_) { /* GM 菜单不可用 */ }
    }

    function refreshPanelModeMenu() {
      const on = settings.panelMode === 'fixed';
      registerMenuCommand((on ? '☑ ' : '☐ ') + '固定模式', togglePanelMode, menuIds.pin, false);
    }

    function refreshDebugMenu() {
      const on = isDebugEnabled();
      registerMenuCommand((on ? '☑ ' : '☐ ') + '调试模式', toggleDebugMode, menuIds.debug, false);
    }

    function clearCacheFromMenu() {
      client.clearCache();
      showModeToast('本地缓存已清空');
    }

    function registerGmMenu() {
      try {
        refreshPanelModeMenu();
        refreshDebugMenu();
        refreshUiMenu();
        refreshCardImageMenu();
        registerMenuCommand('⚙ 设置样式…', openSettingsDialog, menuIds.style);
        registerMenuCommand('🧹 清空本地缓存', clearCacheFromMenu, menuIds.cache);
      } catch (_) { /* GM 菜单不可用 */ }
    }

    registerGmMenu();

    // 按用户设置决定是否在启动时开启界面汉化
    if (settings.uiTranslate) {
      try { uiTranslator.enable(); } catch (_) { /* 忽略 */ }
    }

    // 按用户设置启用中文卡图：监听 DOM 变化，React 重渲染后自动重放替换
    if (settings.cardImage !== false) {
      ensureImageObserver();
      reapplyKnownImagesIn(doc.body);
    }

    // --- 事件 ---

    function onPointerOver(event) {
      const anchor = findCardAnchor(event && event.target, doc,
        event ? event.clientX : null, event ? event.clientY : null);
      if (!anchor) {
        if (settings.panelMode !== 'fixed') hidePanel();
        return;
      }
      const serial = ++hoverSerial;
      showLoading(anchor);
      client.lookup(anchor)
        .then((result) => {
          if (serial !== hoverSerial) return;
          if (result && result.record) {
            presentCard(anchor, result.record, result.stage, result.debug);
          } else {
            hidePanel();
          }
        })
        .catch((error) => {
          if (serial !== hoverSerial) return;
          panel.textContent = '卡牌数据加载失败：' + ((error && error.message) || error);
          panel.style.display = 'block';
          panel.style.visibility = 'visible';
          repositionPanel();
        });
    }

    function onViewportChange() {
      repositionPanel();
    }

    doc.addEventListener('pointerover', onPointerOver);
    if (typeof root.addEventListener === 'function') {
      root.addEventListener('resize', onViewportChange);
      root.addEventListener('scroll', onViewportChange, true);
    }

    return {
      destroy: function () {
        try { uiTranslator.disable(); } catch (_) { /* 忽略 */ }
        stopImageObserver();
        restoreCardImages();
        doc.removeEventListener('pointerover', onPointerOver);
        if (typeof root.removeEventListener === 'function') {
          root.removeEventListener('resize', onViewportChange);
          root.removeEventListener('scroll', onViewportChange, true);
        }
        hidePanel();
        closeSettingsDialog();
        doc.removeEventListener('mousemove', onDragMouseMove);
        doc.removeEventListener('mouseup', onDragMouseUp);
        if (typeof panel.remove === 'function') panel.remove();
        else if (doc.body && typeof doc.body.removeChild === 'function') doc.body.removeChild(panel);
        if (styleTag && typeof styleTag.remove === 'function') styleTag.remove();
      },
      __test: { panel: panel, settings: settings },
    };
  }

  // --- 对外 API（供测试与调试） ---------------------------------------------

  const api = {
    MTGCH_API_BASE: MTGCH_API_BASE,
    SETTINGS_DEFAULTS: SETTINGS_DEFAULTS,
    BUILTIN_GLOSSARY: BUILTIN_GLOSSARY,
    loadSettings: loadSettings,
    rgbToHex: rgbToHex,
    htmlToText: htmlToText,
    toPlainText: toPlainText,
    extractUuid: extractUuid,
    extractSetCollector: extractSetCollector,
    cleanNameCandidate: cleanNameCandidate,
    normalizeName: normalizeName,
    normalizeComparable: normalizeComparable,
    splitFaces: splitFaces,
    isChineseCardImageUrl: isChineseCardImageUrl,
    scoreSearchItem: scoreSearchItem,
    UI_TERMS: UI_TERMS,
    UI_PATTERNS: UI_PATTERNS,
    createUiDictionary: createUiDictionary,
    normalizeUiKey: normalizeUiKey,
    lookupUiTerm: lookupUiTerm,
    applyUiPattern: applyUiPattern,
    translateUiTokens: translateUiTokens,
    translateUiText: translateUiText,
    createUiTranslator: createUiTranslator,
    verifySearchItemName: verifySearchItemName,
    collectCandidates: collectCandidates,
    hasCandidateSignals: hasCandidateSignals,
    looksLikeCardContainer: looksLikeCardContainer,
    findCardAnchor: findCardAnchor,
    extractIdentity: extractIdentity,
    createMtgchClient: createMtgchClient,
    lookupKeywordEntry: lookupKeywordEntry,
    buildSections: buildSections,
    renderCardPanel: renderCardPanel,
    calculatePanelPosition: calculatePanelPosition,
    prefixLines: prefixLines,
    installProbe: installProbe,
  };

  root.EndstepCn = api;

  // 在 DOM 上留一个可见标记。带 @grant 的脚本运行在油猴沙箱里，它设置的 window.EndstepCn
  // 在页面上下文看不到；而 DOM 是共享的，因此用 <html data-endstep-cn="..."> 才能可靠判断脚本
  // 是否真的运行（页面控制台执行：document.documentElement.getAttribute('data-endstep-cn')）。
  function setMarker(value) {
    try {
      const element = root.document && root.document.documentElement;
      if (element && typeof element.setAttribute === 'function') {
        element.setAttribute('data-endstep-cn', String(value));
      }
    } catch (_) { /* 忽略 */ }
  }

  if (typeof console !== 'undefined' && console.log) {
    console.log('[Endstep CN] 已加载 v' + SCRIPT_VERSION +
      '，当前页面：' + String((root.location && root.location.href) || ''));
  }
  setMarker('loaded:' + SCRIPT_VERSION);

  if (root.document) {
    try {
      root.EndstepCnInstance = installProbe(root.document);
      setMarker(root.EndstepCnInstance && root.EndstepCnInstance.__test
        ? 'ready:' + SCRIPT_VERSION
        : 'no-body:' + SCRIPT_VERSION);
    } catch (error) {
      setMarker('error:' + ((error && error.message) || error));
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[Endstep CN] 初始化失败:', error);
      }
    }
  }

  return api;
})();
