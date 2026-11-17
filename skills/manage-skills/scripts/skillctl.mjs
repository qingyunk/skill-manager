#!/usr/bin/env node
/**
 * skillctl.mjs — 本地管理 Kimi Code Agent Skills（零依赖，Node 18+）
 *
 *   list      [--scope all|user|project|extra] [--json]
 *   show      <name> [--json]
 *   validate  [--json]
 *   new       <name> [--dir <父目录>] [--force]
 *   install   <目录或 .md 文件> [--force]
 *   disable   <name> [--scope user|project]
 *   enable    <name> [--scope user|project]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const KIMI_HOME = process.env.KIMI_CODE_HOME || path.join(HOME, '.kimi-code');
const VALID_TYPES = new Set(['prompt', 'inline', 'flow']);

const KNOWN_FIELDS = new Set([
  'name', 'description', 'type', 'arguments',
  'whenToUse', 'when-to-use', 'when_to_used',
  'disableModelInvocation', 'disable-model-invocation', 'disable_model_invocation',
  'metadata', 'license', 'allowed-tools', 'allowed_tools',
]);

function fail(message) {
  console.error(`错误: ${message}`);
  process.exit(2);
}

function print(...args) {
  console.log(...args);
}

/* ---------------- 作用域目录 ---------------- */

function userBases() {
  return [
    { scope: 'user', label: 'Kimi 用户技能', dir: path.join(KIMI_HOME, 'skills') },
    { scope: 'user', label: '通用用户技能', dir: path.join(HOME, '.agents', 'skills') },
  ];
}

function findProjectRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function projectBases() {
  const root = findProjectRoot(process.cwd());
  if (!root) return [];
  return [
    { scope: 'project', label: '项目技能', dir: path.join(root, '.kimi-code', 'skills') },
    { scope: 'project', label: '项目通用技能', dir: path.join(root, '.agents', 'skills') },
  ];
}

function expandHome(value) {
  return value.replace(/^~(?=$|[\\/])/, HOME);
}

function parseExtraSkillDirs() {
  const config = path.join(KIMI_HOME, 'config.toml');
  if (!fs.existsSync(config)) return [];
  let text;
  try {
    text = fs.readFileSync(config, 'utf8');
  } catch {
    return [];
  }
  const match = text.match(/^\s*extra_skill_dirs\s*=\s*(\[[\s\S]*?\]|"[^"]*"|'[^']*')/m);
  if (!match) return [];
  const raw = match[1];
  const values = [];
  if (raw.startsWith('[')) {
    const re = /"([^"]*)"|'([^']*)'/g;
    let item;
    while ((item = re.exec(raw))) values.push(item[1] ?? item[2]);
  } else {
    const quoted = raw.match(/^["']([^"']*)["']$/);
    if (quoted) values.push(quoted[1]);
  }
  return values.map((value) => ({
    scope: 'extra',
    label: '额外技能目录',
    dir: path.resolve(process.cwd(), expandHome(value)),
  }));
}

function pluginBases() {
  const bases = [];
  const seen = new Set();

  const addRoot = (root) => {
    try {
      if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return;
    } catch {
      return;
    }
    const manifestPath = path.join(root, 'kimi.plugin.json');
    let skillPaths = ['./skills/'];
    let pluginId = path.basename(root);
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (typeof manifest.name === 'string' && manifest.name.trim()) pluginId = manifest.name.trim();
        if (typeof manifest.skills === 'string') skillPaths = [manifest.skills];
        else if (Array.isArray(manifest.skills)) skillPaths = manifest.skills;
      } catch {
        /* 清单损坏时按默认 skills 目录扫描 */
      }
    }
    for (const rel of skillPaths) {
      if (typeof rel !== 'string' || !rel.startsWith('./')) continue;
      const dir = path.resolve(root, rel);
      const key = dir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      bases.push({ scope: 'plugin', label: `插件技能 (${pluginId})`, dir, pluginId });
    }
  };

  const installedFile = path.join(KIMI_HOME, 'plugins', 'installed.json');
  if (fs.existsSync(installedFile)) {
    try {
      const installed = JSON.parse(fs.readFileSync(installedFile, 'utf8'));
      for (const entry of installed.plugins || []) {
        if (entry && entry.enabled && entry.root) addRoot(entry.root);
      }
    } catch {
      /* 忽略损坏的 installed.json */
    }
  }

  const managedDir = path.join(KIMI_HOME, 'plugins', 'managed');
  if (fs.existsSync(managedDir)) {
    let names = [];
    try {
      names = fs.readdirSync(managedDir);
    } catch {
      names = [];
    }
    for (const name of names) addRoot(path.join(managedDir, name));
  }

  return bases;
}

function allBases() {
  return [...projectBases(), ...userBases(), ...parseExtraSkillDirs(), ...pluginBases()];
}

function filteredBases(scope) {
  if (!scope || scope === 'all') return allBases();
  return allBases().filter((base) => base.scope === scope);
}

function disabledDirFor(base) {
  return path.join(path.dirname(base.dir), `${path.basename(base.dir)}-disabled`);
}

/* ---------------- frontmatter 解析 ---------------- */

function unquote(value) {
  const text = value.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function splitFrontmatter(text) {
  const clean = text.replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start += 1;
  if (lines[start] !== '---') return { fields: {}, bodyLines: lines, problems: [] };
  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^---\s*$/.test(lines[i]) || /^\.\.\.\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { fields: {}, bodyLines: lines, problems: ['frontmatter 缺少结束的 ---'] };
  }
  const parsed = parseFrontmatter(lines.slice(start + 1, end));
  return { fields: parsed.fields, bodyLines: lines.slice(end + 1), problems: parsed.problems };
}

function parseFrontmatter(sourceLines) {
  const fields = {};
  const problems = [];
  for (let i = 0; i < sourceLines.length; i += 1) {
    const raw = sourceLines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const match = raw.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!match) {
      problems.push(`无法解析的 frontmatter 行: ${raw.trim()}`);
      continue;
    }
    const key = match[1];
    const value = match[2].trim();

    if (!value || value === '|' || value === '>') {
      const block = [];
      let j = i + 1;
      for (; j < sourceLines.length; j += 1) {
        const line = sourceLines[j];
        if (!line.trim()) {
          block.push('');
          continue;
        }
        if (!/^\s/.test(line)) break;
        block.push(line.replace(/^\s+/, ''));
      }
      while (block.length && !block[block.length - 1]) block.pop();
      if (value === '|' || value === '>') {
        fields[key] = value === '>' ? block.filter(Boolean).join(' ') : block.join('\n');
      } else if (block.length) {
        const items = block.map((line) => line.trim()).filter(Boolean);
        if (items.every((line) => line.startsWith('- '))) {
          fields[key] = items.map((line) => unquote(line.slice(2).trim()));
        } else {
          fields[key] = block.join('\n').trim();
        }
      } else {
        fields[key] = '';
      }
      i = j - 1;
      continue;
    }

    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1);
      const items = [];
      const re = /"([^"]*)"|'([^']*)'|([^,]+)/g;
      let item;
      while ((item = re.exec(inner))) {
        const text = (item[1] ?? item[2] ?? item[3] ?? '').trim();
        if (text) items.push(text);
      }
      fields[key] = items;
    } else if (value === 'true' || value === 'false') {
      fields[key] = value === 'true';
    } else {
      fields[key] = unquote(value);
    }
  }
  return { fields, problems };
}

/* ---------------- 技能读取 ---------------- */

function firstBodyLine(bodyLines) {
  for (const line of bodyLines) {
    const text = line.trim();
    if (text) return text.slice(0, 240);
  }
  return '';
}

function loadSkillAt(skillFile, { kind, scope, baseDir, skillDir }) {
  const skill = {
    name: '',
    description: '',
    type: 'prompt',
    whenToUse: '',
    arguments: [],
    disableModelInvocation: false,
    scope,
    kind,
    path: skillDir || skillFile,
    baseDir,
    problems: [],
    fields: {},
    bodyLines: [],
  };
  const addProblem = (level, message) => skill.problems.push({ level, message });

  let text;
  try {
    text = fs.readFileSync(skillFile, 'utf8');
  } catch (error) {
    addProblem('error', `读取失败: ${error.message}`);
    return skill;
  }

  const split = splitFrontmatter(text);
  for (const problem of split.problems) addProblem('warn', problem);
  const fields = split.fields;
  skill.fields = fields;
  skill.bodyLines = split.bodyLines;

  const declaredName = typeof fields.name === 'string' ? fields.name.trim() : '';
  const declaredDescription = typeof fields.description === 'string' ? fields.description.trim() : '';

  if (kind === 'dir') {
    skill.name = declaredName;
    skill.description = declaredDescription;
    if (!declaredName) addProblem('error', '目录形式技能缺少必填的 name 字段（会导致解析失败）');
    if (!declaredDescription) addProblem('error', '目录形式技能缺少必填的 description 字段（会导致解析失败）');
    const dirName = path.basename(skillDir);
    if (declaredName && declaredName !== dirName) {
      addProblem('warn', `name 与目录名不一致：name=${declaredName}，目录名=${dirName}`);
    }
  } else {
    skill.name = declaredName || path.basename(skillFile, path.extname(skillFile));
    skill.description = declaredDescription || firstBodyLine(split.bodyLines);
    if (!declaredName) addProblem('warn', `扁平技能未声明 name，按文件名注册为 ${skill.name}`);
    if (!declaredDescription) addProblem('warn', '扁平技能未声明 description，改用正文第一行');
    if (path.basename(skillFile).toLowerCase() === 'skill.md') {
      addProblem('warn', '技能目录顶层出现了 SKILL.md 文件，它会被当作名为 SKILL 的扁平技能');
    }
  }

  if (typeof fields.type === 'string' && fields.type.trim()) {
    skill.type = fields.type.trim();
    if (!VALID_TYPES.has(skill.type)) {
      addProblem('error', `type=${skill.type} 无效（只支持 prompt / inline / flow），该技能会被跳过`);
    }
  }

  const whenKey = ['whenToUse', 'when-to-use', 'when_to_used'].find((key) => typeof fields[key] === 'string');
  if (whenKey) skill.whenToUse = fields[whenKey];

  const disableKey = ['disableModelInvocation', 'disable-model-invocation', 'disable_model_invocation']
    .find((key) => typeof fields[key] === 'boolean');
  if (disableKey) skill.disableModelInvocation = fields[disableKey];

  if (Array.isArray(fields.arguments)) {
    skill.arguments = fields.arguments.map(String);
  } else if (typeof fields.arguments === 'string' && fields.arguments.trim()) {
    skill.arguments = fields.arguments.trim().split(/\s+/);
  }

  for (const key of Object.keys(fields)) {
    if (!KNOWN_FIELDS.has(key)) addProblem('warn', `未识别的 frontmatter 字段: ${key}`);
  }

  if (skill.name && !/^[A-Za-z0-9._-]+$/.test(skill.name)) {
    addProblem('warn', `技能名含特殊字符，/skill:${skill.name} 可能无法调用`);
  }

  return skill;
}

function scanBases(bases) {
  const skills = [];
  const missing = [];
  for (const base of bases) {
    if (!fs.existsSync(base.dir)) {
      missing.push(base);
      continue;
    }
    let entries;
    try {
      entries = fs.readdirSync(base.dir, { withFileTypes: true });
    } catch {
      missing.push(base);
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(base.dir, entry.name);
      let skill = null;
      if (entry.isDirectory()) {
        const skillFile = path.join(full, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          skill = loadSkillAt(skillFile, {
            kind: 'dir',
            scope: base.scope,
            baseDir: base.dir,
            skillDir: full,
          });
        }
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        skill = loadSkillAt(full, { kind: 'flat', scope: base.scope, baseDir: base.dir });
      }
      if (skill) {
        if (base.pluginId) skill.qualifiedName = `${base.pluginId}:${skill.name}`;
        skills.push(skill);
      }
    }
  }

  const seen = new Map();
  for (const skill of skills) {
    if (!skill.name) continue;
    const key = (skill.qualifiedName || skill.name).toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, skill);
      continue;
    }
    const winner = seen.get(key);
    skill.shadowedBy = winner.path;
    winner.problems.push({
      level: 'warn',
      message: `同名技能被更低优先级的同名技能覆盖: ${skill.path}`,
    });
  }

  return { skills, missing };
}

/* ---------------- 输出辅助 ---------------- */

function scopeRank(scope) {
  if (scope === 'project') return 0;
  if (scope === 'user') return 1;
  if (scope === 'extra') return 2;
  return 3;
}

function statusOf(skill) {
  const errors = skill.problems.filter((problem) => problem.level === 'error').length;
  const warns = skill.problems.filter((problem) => problem.level === 'warn').length;
  if (errors) return `${errors} 个错误`;
  if (warns) return `${warns} 个提示`;
  return '正常';
}

function toJsonSkill(skill) {
  return {
    name: skill.name,
    qualifiedName: skill.qualifiedName,
    description: skill.description,
    type: skill.type,
    scope: skill.scope,
    kind: skill.kind,
    path: skill.path,
    whenToUse: skill.whenToUse || undefined,
    disableModelInvocation: skill.disableModelInvocation || undefined,
    arguments: skill.arguments.length ? skill.arguments : undefined,
    shadowedBy: skill.shadowedBy,
    problems: skill.problems,
  };
}

function listFiles(root) {
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else out.push(rel);
      if (out.length > 200) return;
    }
  };
  walk(root, '');
  return out.sort();
}

/* ---------------- 子命令 ---------------- */

function cmdList(opts) {
  const { skills, missing } = scanBases(filteredBases(opts.flags.scope));
  const rows = [...skills].sort(
    (a, b) => scopeRank(a.scope) - scopeRank(b.scope) || a.name.localeCompare(b.name),
  );

  if (opts.flags.json) {
    print(JSON.stringify({
      skills: rows.map(toJsonSkill),
      missingDirs: missing.map((base) => base.dir),
    }, null, 2));
    return;
  }

  print(`共发现 ${rows.length} 个技能${opts.flags.scope ? `（作用域: ${opts.flags.scope}）` : ''}。`);
  rows.forEach((skill, index) => {
    print('');
    const displayName = skill.qualifiedName || skill.name;
    print(`${index + 1}. ${displayName}  [${skill.scope} · ${skill.kind === 'dir' ? '目录' : '扁平'}]  ${statusOf(skill)}`);
    print(`   路径: ${skill.path}`);
    if (skill.description) print(`   说明: ${skill.description.slice(0, 120)}`);
    for (const problem of skill.problems) {
      print(`   [${problem.level === 'error' ? 'ERROR' : 'WARN'}] ${problem.message}`);
    }
  });

  if (missing.length) {
    print('');
    print('未找到的技能目录（已跳过）:');
    for (const base of missing) print(`  - ${base.label}: ${base.dir}`);
  }
}

function cmdShow(name, opts) {
  if (!name) fail('show 需要技能名，例如: show kimi-webbridge');
  const { skills } = scanBases(allBases());
  const target = name.toLowerCase();
  const matches = skills.filter(
    (skill) => skill.name.toLowerCase() === target
      || (skill.qualifiedName || '').toLowerCase() === target,
  );
  if (!matches.length) fail(`没有找到名为 ${name} 的技能，先运行 list 看看有哪些技能`);

  const skill = [...matches].sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope))[0];

  if (opts.flags.json) {
    print(JSON.stringify({
      skill: toJsonSkill(skill),
      files: skill.kind === 'dir' ? listFiles(skill.path) : [path.basename(skill.path)],
      bodyPreview: skill.bodyLines.slice(0, 15),
      shadowed: matches.filter((item) => item.shadowedBy === skill.path).map((item) => item.path),
    }, null, 2));
    return;
  }

  print(`名称:        ${skill.qualifiedName || skill.name}`);
  print(`作用域:      ${skill.scope}`);
  print(`形式:        ${skill.kind === 'dir' ? '目录 (SKILL.md)' : '扁平 (.md 文件)'}`);
  print(`路径:        ${skill.path}`);
  print(`type:        ${skill.type}`);
  print(`description: ${skill.description || '（未声明）'}`);
  if (skill.whenToUse) print(`whenToUse:   ${skill.whenToUse}`);
  if (skill.arguments.length) print(`arguments:   ${skill.arguments.join(', ')}`);
  if (skill.disableModelInvocation) print('disableModelInvocation: true（禁止模型自动调用）');

  if (skill.kind === 'dir') {
    print('');
    print('目录内文件:');
    for (const file of listFiles(skill.path).slice(0, 50)) print(`  - ${file}`);
  }

  print('');
  print('正文预览:');
  const preview = [];
  for (const line of skill.bodyLines) {
    if (!line.trim() && preview.length === 0) continue;
    preview.push(line);
    if (preview.length >= 15) break;
  }
  for (const line of preview) print(`  ${line}`);

  if (skill.problems.length) {
    print('');
    print('问题:');
    for (const problem of skill.problems) {
      print(`  [${problem.level === 'error' ? 'ERROR' : 'WARN'}] ${problem.message}`);
    }
  }

  const shadowed = matches.filter((item) => item.shadowedBy === skill.path);
  if (shadowed.length) {
    print('');
    print('被覆盖的同名技能:');
    for (const item of shadowed) print(`  - ${item.path}`);
  }
}

function cmdValidate(opts) {
  const { skills } = scanBases(allBases());
  const rows = [...skills].sort(
    (a, b) => scopeRank(a.scope) - scopeRank(b.scope) || a.name.localeCompare(b.name),
  );

  let errors = 0;
  let warns = 0;
  for (const skill of rows) {
    for (const problem of skill.problems) {
      if (problem.level === 'error') errors += 1;
      else warns += 1;
    }
  }

  if (opts.flags.json) {
    print(JSON.stringify({ skills: rows.map(toJsonSkill), errors, warnings: warns }, null, 2));
    if (errors) process.exit(1);
    return;
  }

  for (const skill of rows) {
    const hasError = skill.problems.some((problem) => problem.level === 'error');
    print(`${hasError ? 'FAIL' : skill.problems.length ? 'WARN' : 'OK  '}  ${skill.scope}/${skill.kind} ${skill.name}`);
    for (const problem of skill.problems) {
      print(`      [${problem.level === 'error' ? 'ERROR' : 'WARN'}] ${problem.message}`);
    }
  }
  print('');
  print(`共 ${rows.length} 个技能：${errors} 个错误，${warns} 个提示。`);
  if (errors) process.exit(1);
}

function skillTemplate(name) {
  return `---
name: ${name}
description: 一句话说明这个技能做什么、什么时候用
type: prompt
whenToUse: When the user needs ${name}
---

# ${name}

在这里写技能正文：职责、工作流程、检查清单和示例。

- 需要脚本或参考资料时放在本目录下，正文里用 \${KIMI_SKILL_DIR}/文件名 引用。
- 调用方式：/skill:${name}
`;
}

function cmdNew(name, opts) {
  if (!name) fail('new 需要技能名，例如: new release-checklist');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) fail('技能名只能包含字母、数字、点、下划线和短横线');

  const targetDir = opts.flags.dir
    ? path.resolve(process.cwd(), opts.flags.dir, name)
    : path.join(KIMI_HOME, 'skills', name);

  const existing = scanBases(allBases()).skills.find(
    (skill) => skill.scope !== 'plugin' && skill.name.toLowerCase() === name.toLowerCase(),
  );
  if (existing && !opts.flags.force) {
    fail(`同名技能已存在: ${existing.path}（确实要再建一个不同位置的同名技能请加 --force）`);
  }
  if (fs.existsSync(targetDir) && !opts.flags.force) {
    fail(`目录已存在: ${targetDir}（覆盖请加 --force）`);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  const skillFile = path.join(targetDir, 'SKILL.md');
  fs.writeFileSync(skillFile, skillTemplate(name), 'utf8');
  print(`已创建技能骨架: ${skillFile}`);
  print('下一步: 编辑 description / whenToUse 和正文；执行 /reload 或开新会话后生效。');
}

function cmdInstall(source, opts) {
  if (!source) fail('install 需要安装源路径（含 SKILL.md 的目录，或单个 .md 文件）');
  const src = path.resolve(process.cwd(), source);
  if (!fs.existsSync(src)) fail(`安装源不存在: ${src}`);

  const stat = fs.statSync(src);
  let kind;
  let skillFile;
  if (stat.isDirectory()) {
    kind = 'dir';
    skillFile = path.join(src, 'SKILL.md');
    if (!fs.existsSync(skillFile)) fail('该目录根下没有 SKILL.md，不是目录形式的技能');
  } else if (stat.isFile() && /\.md$/i.test(src)) {
    kind = 'flat';
    skillFile = src;
  } else {
    fail('安装源必须是含 SKILL.md 的目录，或单个 .md 文件');
  }

  const skill = loadSkillAt(skillFile, {
    kind,
    scope: 'user',
    baseDir: path.join(KIMI_HOME, 'skills'),
    skillDir: kind === 'dir' ? src : undefined,
  });

  const errors = skill.problems.filter((problem) => problem.level === 'error');
  if (errors.length) {
    fail(`技能未通过校验:\n- ${errors.map((problem) => problem.message).join('\n- ')}`);
  }
  if (!skill.name) fail('无法确定技能名称');
  if (!/^[A-Za-z0-9._-]+$/.test(skill.name)) fail(`技能名含非法字符: ${skill.name}`);

  const userDir = path.join(KIMI_HOME, 'skills');
  fs.mkdirSync(userDir, { recursive: true });
  const target = kind === 'dir'
    ? path.join(userDir, skill.name)
    : path.join(userDir, `${skill.name}.md`);

  if (fs.existsSync(target)) {
    if (!opts.flags.force) fail(`目标已存在: ${target}（覆盖请加 --force）`);
    fs.rmSync(target, { recursive: true, force: true });
  }

  if (kind === 'dir') fs.cpSync(src, target, { recursive: true });
  else fs.copyFileSync(src, target);

  print(`已安装技能 ${skill.name} -> ${target}`);
  print(`提示: 执行 /reload 或开新会话后可用 /skill:${skill.name} 调用。`);
}

function cmdDisable(name, opts) {
  if (!name) fail('disable 需要技能名');
  const scope = opts.flags.scope;
  const bases = [...projectBases(), ...userBases()].filter((base) => !scope || base.scope === scope);
  const { skills } = scanBases(bases);
  const matches = skills.filter((skill) => skill.name.toLowerCase() === name.toLowerCase());

  if (!matches.length) fail(`在 user/project 作用域里没有找到技能 ${name}`);
  if (matches.length > 1) {
    print('存在多个同名技能，请用 --scope 指定要停用哪一个:');
    for (const skill of matches) print(`  - ${skill.scope}: ${skill.path}`);
    process.exit(2);
  }

  const skill = matches[0];
  if (skill.path.includes(`${path.sep}plugins${path.sep}`)) {
    fail('该技能来自已安装的插件，请用 /plugins 管理，不要手动移动');
  }

  const base = bases.find((item) => item.dir === skill.baseDir);
  const destDir = disabledDirFor(base);
  const dest = path.join(destDir, path.basename(skill.path));
  print(`将停用: ${skill.path}`);
  print(`移动到: ${dest}`);

  if (fs.existsSync(dest)) fail('停用目录里已有同名条目，请先处理它');
  fs.mkdirSync(destDir, { recursive: true });
  fs.renameSync(skill.path, dest);
  print(`已停用 ${skill.name}。执行 /reload 或开新会话后生效。`);
}

function cmdEnable(name, opts) {
  if (!name) fail('enable 需要技能名');
  const scope = opts.flags.scope;
  const bases = [...projectBases(), ...userBases()].filter((base) => !scope || base.scope === scope);
  let restored = 0;

  for (const base of bases) {
    const dir = disabledDirFor(base);
    if (!fs.existsSync(dir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      let skillName = '';
      if (entry.isDirectory()) {
        const skillFile = path.join(full, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;
        skillName = loadSkillAt(skillFile, {
          kind: 'dir',
          scope: base.scope,
          baseDir: dir,
          skillDir: full,
        }).name;
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        skillName = loadSkillAt(full, { kind: 'flat', scope: base.scope, baseDir: dir }).name;
      }
      if (!skillName || skillName.toLowerCase() !== name.toLowerCase()) continue;

      const dest = path.join(base.dir, entry.name);
      if (fs.existsSync(dest)) fail(`目标位置已存在同名条目: ${dest}`);
      fs.mkdirSync(base.dir, { recursive: true });
      fs.renameSync(full, dest);
      print(`已恢复 ${skillName} -> ${dest}`);
      restored += 1;
    }
  }

  if (!restored) fail(`在停用目录里没有找到技能 ${name}`);
  print('执行 /reload 或开新会话后生效。');
}

function printUsage() {
  print('skillctl — 管理 Kimi Code Agent Skills');
  print('');
  print('用法: node skillctl.mjs <子命令> [参数]');
  print('');
  print('  list      [--scope all|user|project|extra] [--json]  列出技能');
  print('  show      <name> [--json]                           查看单个技能');
  print('  validate  [--json]                                  校验所有 SKILL.md');
  print('  new       <name> [--dir <父目录>] [--force]          生成新技能骨架');
  print('  install   <目录或 .md 文件> [--force]                安装技能到用户技能目录');
  print('  disable   <name> [--scope user|project]             停用技能');
  print('  enable    <name> [--scope user|project]             恢复技能');
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { positional: [], flags: {} };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--json') opts.flags.json = true;
    else if (arg === '--force') opts.flags.force = true;
    else if (arg === '--scope' || arg === '--dir') {
      const value = rest[i + 1];
      if (value === undefined) fail(`${arg} 缺少参数值`);
      opts.flags[arg.slice(2)] = value;
      i += 1;
    } else opts.positional.push(arg);
  }
  return { command, opts };
}

function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'list':
      cmdList(opts);
      break;
    case 'show':
      cmdShow(opts.positional[0], opts);
      break;
    case 'validate':
      cmdValidate(opts);
      break;
    case 'new':
      cmdNew(opts.positional[0], opts);
      break;
    case 'install':
      cmdInstall(opts.positional[0], opts);
      break;
    case 'disable':
      cmdDisable(opts.positional[0], opts);
      break;
    case 'enable':
      cmdEnable(opts.positional[0], opts);
      break;
    case undefined:
    case 'help':
    case '--help':
      printUsage();
      break;
    default:
      fail(`未知子命令: ${command}（可用: list / show / validate / new / install / disable / enable）`);
  }
}

main();