---
name: manage-skills
description: List, inspect, validate, create, install, disable or re-enable Kimi Code Agent Skills on this machine
type: prompt
whenToUse: When the user asks to see their skills, check or fix a SKILL.md, create a new skill, install a skill from a local folder, or turn a skill on or off
---

使用本机技能管理器 `skillctl` 完成与 Agent Skills 相关的操作。

固定调用方式（脚本随本技能一起安装）：

```bash
node "${KIMI_SKILL_DIR}/scripts/skillctl.mjs" <子命令> [参数]
```

## 子命令

| 子命令 | 作用 | 修改磁盘 |
| --- | --- | --- |
| `list [--scope all\|user\|project\|extra] [--json]` | 列出技能：作用域、形式、状态、路径、说明 | 否 |
| `show <name> [--json]` | 查看单个技能的元数据、目录文件、正文预览 | 否 |
| `validate [--json]` | 校验所有 SKILL.md：必填字段、type 合法性、同名覆盖等 | 否 |
| `new <name> [--dir <父目录>]` | 在用户技能目录生成目录形式的技能骨架 | 是 |
| `install <path> [--force]` | 从本地目录（根下有 SKILL.md）或单个 .md 文件安装技能 | 是 |
| `disable <name> [--scope user\|project]` | 停用技能（移动到同级 skills-disabled 目录） | 是 |
| `enable <name> [--scope user\|project]` | 恢复被停用的技能 | 是 |

## 工作流程

1. 不确定有哪些技能时先跑 `list`；需要机器可读结果时加 `--json`。
2. 只读操作（list / show / validate）直接执行，然后把关键信息整理成简洁的表格或条目回复用户，不要整段粘贴原始输出。
3. 写操作（new / install / disable / enable）执行前先向用户说明将要修改的路径和影响，得到确认后再运行。
4. 完成后告诉用户结果路径与生效方式：执行 `/reload` 或开新会话后才会重新加载技能目录。
5. 命令失败时原样展示错误信息，并给出下一步建议；不要自行编造技能内容，也不要绕开命令手动编辑技能文件。

## 约定

- 用户级技能默认位于 `$KIMI_CODE_HOME/skills/`（未设置时为 `~/.kimi-code/skills/`），通用的 `~/.agents/skills/` 也会被扫描。
- 项目级技能位于项目根目录（含 `.git` 的最近上级目录）下的 `.kimi-code/skills/`。
- `config.toml` 里的 `extra_skill_dirs` 目录会以 `extra` 作用域参与列出与校验。
- 插件自带技能（位于 `plugins/managed` 下）不能用 `disable` 移动，应通过 `/plugins` 管理。
- 新建技能后，务必把 `description` 和 `whenToUse` 写清楚，否则模型难以自动调用。