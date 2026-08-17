#!/usr/bin/env node

/**
 * 本地只读发布验收器。
 *
 * 只读取项目文件，并使用当前 Node.js 做语法检查；不会加载微信云 SDK、
 * 不会调用微信开发者工具，也不会连接、读取或修改任何真实云环境。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT_CONFIG = path.join(ROOT, 'project.config.json');

const EXPECTED_FUNCTIONS = [
  'addWork',
  'applyJob',
  'changeEnterprisePassword',
  'changePassword',
  'cleanupStages',
  'genWxaCode',
  'getArchive',
  'initDB',
  'issueCertification',
  'listTalents',
  'login',
  'logout',
  'manageJobApplication',
  'postJob',
  'recoverAccount',
  'register',
  'respondInvitation',
  'sendInvitation',
  'submitEvaluation',
  'updateProfile',
];

const EXPECTED_COLLECTIONS = [
  'users',
  'qrcodes',
  'works',
  'certifications',
  'evaluations',
  'stages',
  'attestations',
  'companies',
  'invitations',
  'jobs',
  'sessions',
  'login_attempts',
  'account_bindings',
  'campus_accounts',
  'company_accounts',
  'enterprise_sessions',
  'enterprise_bindings',
  'user_consents',
  'enterprise_identity_index',
  'identity_bindings',
  'job_applications',
];

const checks = [];
const notes = [];

function relative(file) {
  return path.relative(ROOT, file) || '.';
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function check(name, callback) {
  try {
    const detail = callback();
    checks.push({ name, ok: true, detail: detail || '' });
  } catch (error) {
    checks.push({ name, ok: false, detail: error.message || String(error) });
  }
}

function listFiles(start, predicate) {
  if (!fs.existsSync(start)) return [];
  const files = [];
  const queue = [start];
  while (queue.length) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (!predicate || predicate(full)) files.push(full);
    }
  }
  return files.sort();
}

function lineNumber(text, index) {
  return text.slice(0, index).split('\n').length;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseJson(file) {
  try {
    return JSON.parse(read(file));
  } catch (error) {
    throw new Error(`${relative(file)}：${error.message}`);
  }
}

function resolveMiniProgramPath(miniprogramRoot, ownerJson, configuredPath) {
  if (configuredPath.startsWith('plugin://')) return null;
  if (configuredPath.startsWith('/')) {
    return path.join(miniprogramRoot, configuredPath.slice(1));
  }
  return path.resolve(path.dirname(ownerJson), configuredPath);
}

function extractEventBindings(wxmlFile) {
  const source = read(wxmlFile);
  const bindings = [];
  const eventPattern = /(?:bind|catch|capture-bind|capture-catch)(?::)?[A-Za-z0-9_-]+\s*=\s*["']([^"']+)["']/g;
  let match;
  while ((match = eventPattern.exec(source))) {
    const handler = match[1].trim();
    if (!handler || handler.includes('{{')) continue;
    bindings.push({ handler, line: lineNumber(source, match.index) });
  }
  return bindings;
}

function hasHandlerDefinition(source, handler) {
  const name = escapeRegExp(handler);
  const shorthand = new RegExp(`(?:^|\\n|[,{])\\s*(?:async\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`, 'm');
  const property = new RegExp(`(?:^|\\n|[,{])\\s*${name}\\s*:\\s*(?:async\\s*)?(?:function\\s*)?\\([^)]*\\)\\s*(?:=>)?\\s*\\{`, 'm');
  return shorthand.test(source) || property.test(source);
}

function findPolicyConflicts(files) {
  const rules = [
    {
      label: '同一微信允许多个账号',
      pattern: /同(?:一|一个)微信(?:号)?[^。\n]{0,48}(?:多个|多份|不同)[^。\n]{0,20}账号/g,
    },
    {
      label: '同一账号允许多个微信',
      pattern: /同(?:一|一个)账号[^。\n]{0,48}(?:多个|不同)[^。\n]{0,20}微信/g,
    },
    {
      label: '微信只作为会话凭证',
      pattern: /微信[^。\n]{0,20}(?:仅作|仅作为)[^。\n]{0,24}(?:会话|凭证)/g,
    },
    {
      label: '取消一对一绑定',
      pattern: /(?:去掉|移除|解除)[^。\n]{0,36}(?:一对一|只能绑定|绑定限制)/g,
    },
    {
      label: '不再强制唯一绑定',
      pattern: /不再强制[^。\n]{0,28}(?:一对一|双向唯一|绑定)/g,
    },
    {
      label: '找回依赖最近登录记录',
      pattern: /找回[^。\n]{0,48}最近一次登录记录/g,
    },
  ];
  const conflicts = [];
  for (const file of files) {
    const source = read(file);
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(source))) {
        conflicts.push(
          `${relative(file)}:${lineNumber(source, match.index)} [${rule.label}] ${match[0].trim()}`,
        );
      }
    }
  }
  return conflicts;
}

console.log('数字工匠 · 本地只读发布验收');
console.log(`项目目录：${ROOT}`);
console.log('安全边界：仅分析本地文件；不调用云函数、不连接数据库、不执行上传或部署。\n');

let projectConfig;
let miniprogramRoot;
let cloudfunctionRoot;

check('项目配置与目录', () => {
  projectConfig = parseJson(PROJECT_CONFIG);
  assert(projectConfig.compileType === 'miniprogram', 'compileType 必须为 miniprogram');
  assert(/^wx[0-9a-f]{16}$/i.test(projectConfig.appid || ''), 'project.config.json 缺少有效 AppID');
  miniprogramRoot = path.resolve(ROOT, projectConfig.miniprogramRoot || 'miniprogram');
  cloudfunctionRoot = path.resolve(ROOT, projectConfig.cloudfunctionRoot || 'cloudfunctions');
  assert(fs.statSync(miniprogramRoot).isDirectory(), `小程序目录不存在：${relative(miniprogramRoot)}`);
  assert(fs.statSync(cloudfunctionRoot).isDirectory(), `云函数目录不存在：${relative(cloudfunctionRoot)}`);
  return `AppID ${projectConfig.appid}`;
});

if (!miniprogramRoot || !cloudfunctionRoot) {
  console.error('✗ 无法读取项目根配置，后续检查已停止。');
  process.exitCode = 1;
} else {
  check('小程序与云函数 JSON 可解析', () => {
    const jsonFiles = [
      PROJECT_CONFIG,
      path.join(ROOT, 'project.private.config.json'),
      ...listFiles(miniprogramRoot, (file) => file.endsWith('.json')),
      ...listFiles(cloudfunctionRoot, (file) => file.endsWith('.json')),
    ].filter((file, index, all) => fs.existsSync(file) && all.indexOf(file) === index);
    for (const file of jsonFiles) parseJson(file);
    return `${jsonFiles.length} 个 JSON`;
  });

  check('小程序与云函数 JavaScript 语法', () => {
    const jsFiles = [
      ...listFiles(miniprogramRoot, (file) => file.endsWith('.js')),
      ...listFiles(cloudfunctionRoot, (file) => file.endsWith('.js')),
    ];
    const errors = [];
    for (const file of jsFiles) {
      const result = spawnSync(process.execPath, ['--check', file], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      if (result.status !== 0) {
        errors.push(`${relative(file)}：${(result.stderr || result.stdout).trim()}`);
      }
    }
    assert(!errors.length, errors.join('\n'));
    return `${jsFiles.length} 个 JS`;
  });

  check('页面、TabBar 与自定义组件文件完整', () => {
    const appJsonFile = path.join(miniprogramRoot, 'app.json');
    const appJson = parseJson(appJsonFile);
    assert(Array.isArray(appJson.pages) && appJson.pages.length, 'app.json 未声明页面');
    const missing = [];
    for (const page of appJson.pages) {
      for (const extension of ['.js', '.json', '.wxml', '.wxss']) {
        const file = path.join(miniprogramRoot, `${page}${extension}`);
        if (!fs.existsSync(file)) missing.push(relative(file));
      }
    }
    for (const item of (appJson.tabBar && appJson.tabBar.list) || []) {
      if (!appJson.pages.includes(item.pagePath)) {
        missing.push(`TabBar 页面未在 pages 中声明：${item.pagePath}`);
      }
      for (const iconKey of ['iconPath', 'selectedIconPath']) {
        const icon = path.join(miniprogramRoot, item[iconKey] || '');
        if (!item[iconKey] || !fs.existsSync(icon)) missing.push(relative(icon));
      }
    }
    const componentErrors = [];
    for (const jsonFile of listFiles(miniprogramRoot, (file) => file.endsWith('.json'))) {
      const json = parseJson(jsonFile);
      for (const [tag, configuredPath] of Object.entries(json.usingComponents || {})) {
        const base = resolveMiniProgramPath(miniprogramRoot, jsonFile, configuredPath);
        if (!base) continue;
        for (const extension of ['.js', '.json', '.wxml', '.wxss']) {
          if (!fs.existsSync(`${base}${extension}`)) {
            componentErrors.push(`${relative(jsonFile)} 的 ${tag} 缺少 ${relative(`${base}${extension}`)}`);
          }
        }
      }
    }
    assert(!missing.length && !componentErrors.length, [...missing, ...componentErrors].join('\n'));
    return `${appJson.pages.length} 个页面，${((appJson.tabBar && appJson.tabBar.list) || []).length} 个 TabBar 项`;
  });

  check('WXML 页面事件均有对应处理函数', () => {
    const wxmlFiles = listFiles(miniprogramRoot, (file) => file.endsWith('.wxml'));
    const missing = [];
    let bindingCount = 0;
    for (const wxmlFile of wxmlFiles) {
      const bindings = extractEventBindings(wxmlFile);
      if (!bindings.length) continue;
      const jsFile = wxmlFile.replace(/\.wxml$/, '.js');
      if (!fs.existsSync(jsFile)) {
        missing.push(`${relative(wxmlFile)}：缺少同名 JS 文件`);
        continue;
      }
      const jsSource = read(jsFile);
      for (const binding of bindings) {
        bindingCount += 1;
        if (!hasHandlerDefinition(jsSource, binding.handler)) {
          missing.push(`${relative(wxmlFile)}:${binding.line} -> ${binding.handler}`);
        }
      }
    }
    assert(!missing.length, `找不到以下事件处理函数：\n${missing.join('\n')}`);
    return `${bindingCount} 个事件绑定`;
  });

  let functionNames = [];
  check('关键云函数目录与配置完整', () => {
    functionNames = fs.readdirSync(cloudfunctionRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(cloudfunctionRoot, entry.name, 'index.js')))
      .map((entry) => entry.name)
      .sort();
    const missingFunctions = EXPECTED_FUNCTIONS.filter((name) => !functionNames.includes(name));
    const invalid = [];
    for (const name of functionNames) {
      const dir = path.join(cloudfunctionRoot, name);
      const packageFile = path.join(dir, 'package.json');
      const configFile = path.join(dir, 'config.json');
      if (!fs.existsSync(packageFile)) invalid.push(`${name} 缺少 package.json`);
      if (!fs.existsSync(configFile)) invalid.push(`${name} 缺少 config.json`);
      if (!fs.existsSync(packageFile) || !fs.existsSync(configFile)) continue;
      const packageJson = parseJson(packageFile);
      const configJson = parseJson(configFile);
      if (packageJson.main !== 'index.js') invalid.push(`${name}/package.json 的 main 不是 index.js`);
      if (!packageJson.dependencies || !packageJson.dependencies['wx-server-sdk']) {
        invalid.push(`${name}/package.json 缺少 wx-server-sdk`);
      }
      if (!Number.isInteger(configJson.timeout) || configJson.timeout < 1 || configJson.timeout > 60) {
        invalid.push(`${name}/config.json 的 timeout 无效`);
      }
    }
    const genCodeConfig = parseJson(path.join(cloudfunctionRoot, 'genWxaCode', 'config.json'));
    const openapi = genCodeConfig.permissions && genCodeConfig.permissions.openapi;
    if (!Array.isArray(openapi) || !openapi.includes('wxacode.getUnlimited')) {
      invalid.push('genWxaCode 缺少 wxacode.getUnlimited 权限声明');
    }
    assert(!missingFunctions.length && !invalid.length,
      [
        missingFunctions.length ? `缺少关键函数：${missingFunctions.join('、')}` : '',
        ...invalid,
      ].filter(Boolean).join('\n'));
    const extra = functionNames.filter((name) => !EXPECTED_FUNCTIONS.includes(name));
    if (extra.length) notes.push(`额外云函数（请人工确认用途）：${extra.join('、')}`);
    return `${functionNames.length} 个函数：${functionNames.join('、')}`;
  });

  check('前端调用的云函数均存在', () => {
    const missing = [];
    const called = new Set();
    for (const jsFile of listFiles(miniprogramRoot, (file) => file.endsWith('.js'))) {
      const source = read(jsFile);
      const blockPattern = /wx\.cloud\.callFunction\s*\(\s*\{([\s\S]{0,500}?)\}\s*\)/g;
      let block;
      while ((block = blockPattern.exec(source))) {
        const literalName = block[1].match(/\bname\s*:\s*['"]([A-Za-z0-9_-]+)['"]/);
        if (literalName) called.add(literalName[1]);
      }
    }
    for (const name of called) {
      if (!functionNames.includes(name)) missing.push(name);
    }
    assert(!missing.length, `前端调用但本地不存在：${missing.join('、')}`);
    return `${called.size} 个静态调用：${[...called].sort().join('、')}（动态函数名另由关键清单覆盖）`;
  });

  check('initDB 关键集合清单完整', () => {
    const initDbFile = path.join(cloudfunctionRoot, 'initDB', 'index.js');
    const source = read(initDbFile);
    const declaration = source.match(/const\s+COLLECTIONS\s*=\s*\[([\s\S]*?)\]\s*;/);
    assert(declaration, 'initDB/index.js 未找到 COLLECTIONS 数组');
    const declared = [];
    const namePattern = /['"]([A-Za-z0-9_-]+)['"]/g;
    let match;
    while ((match = namePattern.exec(declaration[1]))) declared.push(match[1]);
    const missing = EXPECTED_COLLECTIONS.filter((name) => !declared.includes(name));
    assert(!missing.length, `COLLECTIONS 缺少：${missing.join('、')}`);
    return `${declared.length} 个集合：${declared.join('、')}`;
  });

  check('数据库安全规则覆盖关键集合', () => {
    const rulesFile = path.join(ROOT, '数据库安全规则.md');
    assert(fs.existsSync(rulesFile), '缺少 数据库安全规则.md');
    const source = read(rulesFile);
    const missing = EXPECTED_COLLECTIONS.filter((name) => !source.includes(`\`${name}\``));
    assert(!missing.length, `安全规则文档缺少：${missing.join('、')}`);
    assert(/"read"\s*:\s*false/.test(source) && /"write"\s*:\s*false/.test(source),
      '安全规则文档未明确 read=false、write=false');
    return `${EXPECTED_COLLECTIONS.length} 个关键集合均有不可读写说明`;
  });

  check('注册实现“一微信一账号”双向唯一绑定', () => {
    const source = read(path.join(cloudfunctionRoot, 'register', 'index.js'));
    const requirements = [
      ['全局绑定集合', /identity_bindings/],
      ['微信身份键', /wechat-\$\{openidHash\}/],
      ['学生账号身份键', /principal-student-\$\{sha256\(account\)\}/],
      ['企业账号身份键', /principal-enterprise-\$\{sha256\(account\)\}/],
      ['账号绑定微信哈希', /boundOpenidHash\s*:\s*openidHash/],
      ['微信已有账号冲突码', /WECHAT_HAS_ACCOUNT/],
      ['学生旧绑定迁移校验', /account_bindings[^\n]{0,100}openidBindingId|account_bindings[\s\S]{0,180}openidBindingId/],
      ['企业旧绑定迁移校验', /enterprise_bindings[^\n]{0,100}openidBindingId|enterprise_bindings[\s\S]{0,180}openidBindingId/],
      ['事务保护', /db\.runTransaction/],
    ];
    const missing = requirements.filter(([, pattern]) => !pattern.test(source)).map(([label]) => label);
    assert(!missing.length, `register 缺少：${missing.join('、')}`);
    return '学生与企业注册共用全局微信绑定，并在事务中校验';
  });

  check('登录实现“一微信一账号”双向校验', () => {
    const source = read(path.join(cloudfunctionRoot, 'login', 'index.js'));
    const requirements = [
      ['全局绑定集合', /identity_bindings/],
      ['微信身份键', /wechat-\$\{openidHash\}/],
      ['角色账号身份键', /principal-\$\{role\}-\$\{sha256\(account\)\}/],
      ['账号绑定微信哈希校验', /boundOpenidHash[^\n]{0,100}openidHash/],
      ['微信冲突处理', /WECHAT_BOUND_ELSEWHERE/],
      ['账号冲突处理', /ACCOUNT_BOUND_ELSEWHERE/],
      ['事务保护', /db\.runTransaction/],
    ];
    const missing = requirements.filter(([, pattern]) => !pattern.test(source)).map(([label]) => label);
    assert(!missing.length, `login 缺少：${missing.join('、')}`);
    return '登录同时校验微信侧和账号侧绑定';
  });

  check('找回密码复核全局唯一绑定', () => {
    const source = read(path.join(cloudfunctionRoot, 'recoverAccount', 'index.js'));
    const requirements = [
      ['全局绑定集合', /identity_bindings/],
      ['微信身份键', /wechat-\$\{openidHash\}/],
      ['角色账号身份键', /principal-\$\{role\}-\$\{sha256\(account\)\}/],
      ['账号绑定微信哈希校验', /boundOpenidHash[^\n]{0,100}openidHash/],
      ['事务中的绑定变化保护', /BINDING_CHANGED/],
    ];
    const missing = requirements.filter(([, pattern]) => !pattern.test(source)).map(([label]) => label);
    assert(!missing.length, `recoverAccount 缺少：${missing.join('、')}`);
    return '查询与重置密码均要求当前微信、账号和全局绑定一致';
  });

  check('旧的多账号/多微信覆盖文案已清除', () => {
    const rootMarkdown = fs.readdirSync(ROOT, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => path.join(ROOT, entry.name));
    const policyFiles = [
      ...rootMarkdown,
      ...listFiles(miniprogramRoot, (file) => /\.(?:js|json|wxml)$/.test(file)),
      path.join(cloudfunctionRoot, 'login', 'index.js'),
      path.join(cloudfunctionRoot, 'login', 'package.json'),
      path.join(cloudfunctionRoot, 'register', 'index.js'),
      path.join(cloudfunctionRoot, 'register', 'package.json'),
      path.join(cloudfunctionRoot, 'recoverAccount', 'index.js'),
      path.join(cloudfunctionRoot, 'recoverAccount', 'package.json'),
    ].filter((file, index, all) => fs.existsSync(file) && all.indexOf(file) === index);
    const conflicts = findPolicyConflicts(policyFiles);
    assert(!conflicts.length, `发现与“一微信一账号”冲突的旧表述：\n${conflicts.join('\n')}`);
    return `${policyFiles.length} 个用户文案、认证代码和说明文件`;
  });
}

console.log('');
for (const result of checks) {
  console.log(`${result.ok ? '✓' : '✗'} ${result.name}${result.detail ? `\n  ${result.detail.replace(/\n/g, '\n  ')}` : ''}`);
}
for (const note of notes) console.log(`! ${note}`);

const failed = checks.filter((result) => !result.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 项通过，${failed.length} 项未通过。`);
if (failed.length) {
  console.log('请修复上面的未通过项后重新运行；本脚本没有对项目或云端做任何修改。');
  process.exitCode = 1;
} else {
  console.log('本地静态验收通过；上线前仍需在目标云环境做函数部署与真实设备回归。');
}
