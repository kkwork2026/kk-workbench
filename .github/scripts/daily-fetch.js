#!/usr/bin/env node
// KK工作台 云端每日抓取脚本
// 通过智谱 AI (GLM) 联网搜索生成四类内容，写入 data/*.js，并升级 version.json
// 运行环境：GitHub Actions (ubuntu-latest) 或本地；需环境变量 ZHIPU_API_KEY
// 触发：北京时间 08:30 运动 / 09:00 美食+新闻+招聘 / 17:30(周五·法定节假日) 钓鱼

const fs = require('fs');
const path = require('path');

const KEY = process.env.ZHIPU_API_KEY;
const MODEL = process.env.ZHIPU_MODEL || 'glm-4-flash';
const BASE = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const DATA_DIR = path.join(__dirname, '..', 'data');
const REPO_DIR = path.join(__dirname, '..');

if (!KEY) {
  console.error('ERROR: 缺少环境变量 ZHIPU_API_KEY');
  process.exit(1);
}

// ---------- 北京时间工具 ----------
function bjParts() {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  });
  const o = {};
  for (const p of fmt.formatToParts(new Date())) if (p.type !== 'literal') o[p.type] = p.value;
  return o;
}
function bjHour() { return parseInt(bjParts().hour, 10); }
function stamp() { const o = bjParts(); return `${o.year}-${o.month}-${o.day} ${o.hour}:${o.minute}`; }
function weekdayShort() {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(new Date());
}

// 2026 中国法定节假日（简化版，仅用于钓鱼模块触发判断）
const HOLIDAYS_2026 = new Set([
  '2026-01-01',
  '2026-02-15','2026-02-16','2026-02-17','2026-02-18','2026-02-19','2026-02-20','2026-02-21','2026-02-22','2026-02-23','2026-02-24',
  '2026-04-04','2026-04-05','2026-04-06',
  '2026-05-01','2026-05-02','2026-05-03','2026-05-04','2026-05-05',
  '2026-06-19','2026-06-20','2026-06-21',
  '2026-09-25','2026-09-26','2026-09-27',
  '2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07'
]);
function isHoliday() {
  const o = bjParts();
  return HOLIDAYS_2026.has(`${o.year}-${o.month}-${o.day}`);
}

// ---------- 智谱调用（联网搜索） ----------
async function chatWithSearch(prompt, searchQuery) {
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    tools: [{ type: 'web_search', web_search: { enable: true, search_query: searchQuery } }],
    temperature: 0.7
  };
  const r = await fetch(BASE, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (j.error) throw new Error('ZHIPU_ERR ' + JSON.stringify(j.error));
  return j.choices?.[0]?.message?.content || '';
}

function extractJSON(text) {
  const s = text.search(/[[{]/);
  if (s < 0) throw new Error('未找到 JSON：' + text.slice(0, 200));
  const e = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  return text.slice(s, e + 1);
}
function parseJSON(text) { return JSON.parse(extractJSON(text)); }

function searchUrl(source, keyword) {
  const k = encodeURIComponent(keyword || '');
  if (source === '抖音') return `https://www.douyin.com/search/${k}`;
  return `https://www.xiaohongshu.com/search_result?keyword=${k}`;
}

// ---------- 各模块生成 ----------
async function genFood() {
  const p = `你是美食编辑。联网搜索今天抖音/小红书上流行的"两人食/家常菜/快手菜/下饭菜"做法（2026年7月附近）。
返回严格 JSON 数组，共10项，每项：{title(菜名), desc(2-3句做法要点), source('小红书'或'抖音'), keyword(用于搜索的中文关键词，如"番茄炒蛋 做法"), tag(如"下饭硬菜"/"快手8分钟"/"低脂高蛋白"/"新手友好")}。
来源请交替使用小红书和抖音。只返回 JSON 数组，不要任何解释文字。`;
  const data = parseJSON(await chatWithSearch(p, '抖音 小红书 两人食 家常菜 快手菜 做法 2026'));
  const items = data.map(it => ({
    title: it.title, desc: it.desc, source: it.source, tag: it.tag,
    url: searchUrl(it.source, it.keyword || it.title)
  }));
  return { updatedAt: stamp(), items };
}

async function genNews() {
  const p = `联网搜索央视新闻今天（北京时间）重要国内与国际头条（优先民生/科技/政策/社会）。
返回严格 JSON 数组，共10项，每项：{title(新闻标题), source('央视新闻'), url(真实央视新闻链接，优先 news.cctv.com 或 ysxw.cctv.cn 的具体文章地址)}。
只返回 JSON 数组，不要任何解释文字。`;
  const data = parseJSON(await chatWithSearch(p, '央视新闻 今天 重要 头条 国内 国际'));
  const items = data.map(it => ({ title: it.title, source: it.source || '央视新闻', url: it.url }));
  return { updatedAt: stamp(), items };
}

async function genJobs() {
  const p = `联网搜索西安 Boss直聘/店长直聘 上的"带货主播 / 新媒体运营 / 直播运营"岗位，优先双休、五险一金、法定节假日正常休。
返回严格 JSON 数组，共10项，每项：{title(岗位名), company(公司名+区域), salary(薪资范围), requirement(福利与要求1-2句), source('Boss直聘'或'店长直聘'), url(真实岗位链接，优先 m.zhipin.com 或 www.zhipin.com 或 dianzhangzhipin.com 的具体职位地址)}。
只返回 JSON 数组，不要任何解释文字。`;
  const data = parseJSON(await chatWithSearch(p, '西安 Boss直聘 带货主播 新媒体运营 双休 五险一金'));
  const items = data.map(it => ({
    title: it.title, company: it.company, salary: it.salary,
    requirement: it.requirement, source: it.source, url: it.url
  }));
  const note = '西安·带货主播/新媒体运营岗位精选，来源仅Boss直聘与店长直聘，优先双休/法定节假日正常休/五险一金。';
  return { updatedAt: stamp(), note, items };
}

const DEFAULT_WEEKPLAN = [
  '周一：周六野5分钟小蛮腰 + 欧阳春晓魔鬼瘦背操，唤醒核心与肩背',
  '周二：吉尼10组瘦手臂 + 周六野马甲线，局部精雕',
  '周三：欧阳春晓直角肩少女背 + 芭杆沙漏腰，改善体态显腰细',
  '周四：周六野小蛮腰 + 吉尼全身燃脂操，核心+有氧组合',
  '周五：欧阳春晓天鹅颈 + 吉尼居家减脂操，放松收尾迎接周末',
  '周六：任选两套跟练保持手感，练后好好拉伸',
  '周日：休息日，散步+拉伸即可，别忘多喝水'
];
async function genFitness() {
  const p = `你是健身博主。联网搜索抖音/小红书上 周六野Zoey、欧阳春晓Aurora、吉尼 的居家跟练视频（瘦腰/瘦臂/瘦背/直角肩/体态矫正）。
返回严格 JSON 对象：{plan('今日建议(周X)：...一句话训练建议'), items:[{title('【博主】动作名'), desc(1-2句要点), blogger('周六野Zoey'/'欧阳春晓Aurora'/'吉尼'), source('小红书'或'抖音'), keyword(搜索关键词), tag('瘦腰腹'/'瘦手臂'/'瘦背'/'直角肩'/'体态矫正'/'全身燃脂')}], weekPlan:['周一：...','周二：...','周三：...','周四：...','周五：...','周六：...','周日：...']}。
items 共10项，来源交替小红书与抖音，三位博主都要覆盖。只返回 JSON 对象，不要任何解释文字。`;
  const d = parseJSON(await chatWithSearch(p, '周六野 欧阳春晓 吉尼 居家跟练 瘦腰 瘦臂 瘦背 小红书 抖音'));
  const items = (d.items || []).map(it => ({
    title: it.title, desc: it.desc, blogger: it.blogger, source: it.source, tag: it.tag,
    url: searchUrl(it.source, it.keyword || it.title)
  }));
  return { updatedAt: stamp(), plan: d.plan || '', items, weekPlan: d.weekPlan || DEFAULT_WEEKPLAN };
}

async function genFishing() {
  const p = `联网搜索西安/陕西 钓点（抖音/小红书分享），覆盖免费野钓、水库、溪流。
返回严格 JSON 数组，共10项，每项：{title(钓点名), type('野钓·免费'/'水库·30元/天'/'溪流·免费'等), fish(鱼种), desc(1-2句), source('抖音'或'小红书'), keyword(搜索关键词)}。
只返回 JSON 数组，不要任何解释文字。`;
  const data = parseJSON(await chatWithSearch(p, '西安 陕西 钓点 野钓 水库 溪流 抖音 小红书'));
  const items = data.map(it => ({
    title: it.title, type: it.type, fish: it.fish, desc: it.desc,
    url: searchUrl(it.source, it.keyword || it.title)
  }));
  return { updatedAt: stamp(), items };
}

// ---------- 写文件 ----------
function writeData(name, obj) {
  const file = path.join(DATA_DIR, name + '.js');
  const content = 'window.KK_DATA = window.KK_DATA || {};\nwindow.KK_DATA.' + name + ' = ' + JSON.stringify(obj, null, 2) + ';\n';
  fs.writeFileSync(file, content, 'utf8');
  console.log('written', name + '.js', 'items=', obj.items ? obj.items.length : 'n/a');
}

async function bumpVersion() {
  const vf = path.join(REPO_DIR, 'version.json');
  let ver = '20260101.0000';
  try { ver = JSON.parse(fs.readFileSync(vf, 'utf8')).ver; } catch (e) {}
  const o = bjParts();
  const today = `${o.year}${o.month}${o.day}`;
  const now = `${o.hour}${o.minute}`;
  let nv;
  if (ver && ver.startsWith(today)) {
    const prev = parseInt(ver.split('.')[1] || '0', 10);
    nv = `${today}.${String(Math.max(parseInt(now, 10), prev + 1)).padStart(4, '0')}`;
  } else {
    nv = `${today}.${now}`;
  }
  fs.writeFileSync(vf, JSON.stringify({ ver: nv }));
  console.log('version ->', nv);
}

// ---------- 主流程 ----------
async function main() {
  const hour = bjHour();
  const wd = weekdayShort();
  const fri = wd === 'Fri';
  const hol = isHoliday();

  let tasks = (process.env.TASKS || '').trim() ? process.env.TASKS.split(',').map(s => s.trim()).filter(Boolean) : [];
  if (tasks.length === 1 && tasks[0] === 'all') tasks = ['food', 'news', 'jobs', 'fitness', 'fishing'];
  if (tasks.length === 0) {
    if (hour === 8) tasks = ['fitness'];
    else if (hour === 9) tasks = ['food', 'news', 'jobs'];
    else if (hour === 17) tasks = (fri || hol) ? ['fishing'] : [];
    else tasks = [];
  }
  console.log('北京时间', stamp(), '周' + wd, 'hour=', hour, 'tasks=', tasks);

  const runners = { food: genFood, news: genNews, jobs: genJobs, fitness: genFitness, fishing: genFishing };
  for (const t of tasks) {
    if (!runners[t]) { console.log('跳过未知任务', t); continue; }
    try {
      const obj = await runners[t]();
      writeData(t, obj);
    } catch (e) {
      console.error('生成', t, '失败:', e.message);
    }
  }
  if (tasks.length > 0) await bumpVersion();
}

main().then(() => { console.log('DONE'); process.exit(0); })
  .catch(e => { console.error('FATAL', e); process.exit(1); });
