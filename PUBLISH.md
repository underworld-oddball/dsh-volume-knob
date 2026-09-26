# 发布指南 / Publishing sh-volume-shuff

作者名用 **江湖老妖**，仓库名（也是 npm 包名）用 `sh-volume-shuff`；**版本从 0.1.0 起**。
（GitHub 用户名只允许字母、数字和连字符，所以「江湖老妖」写在 `package.json` 的 `author`、`LICENSE` 和 README 抬头——不可能是账号名。）

---

## 1. 建仓库并推送

先在 GitHub 网页上新建一个**空**仓库 `sh-volume-shuff`（不要勾 README/.gitignore），然后：

```sh
cd ~/Desktop/harness/sh-volume-shuff

# 本地已初始化并提交好；只需加远端、推送
git remote add origin https://github.com/underworld-oddball/sh-volume-shuff.git
git branch -M main
git push -u origin main
```

有 `gh` CLI 的话更快：

```sh
gh repo create sh-volume-shuff --public --source=. --remote=origin --push \
  --description "Read the page aloud and control volume from the DSH composer"
```

## 2. 给仓库加 topic

仓库页面右上 **About → ⚙ → Topics**，加 `dsh-plugin`（`dsh`、`deepseek-harness` 也可以顺手加上）。
`dsh-plugin` 是社区列表的收录要求之一。

## 3. 等一天，再提交收录 PR

社区插件库（`dsh-market` 的数据源）是
[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，
它的列表数据在 `data/plugins/`，**一个插件一个 YAML 文件**。

- ⚠️ **仓库必须创建满 1 天**才能通过 CI（自动检查，专门过滤"PR 前几分钟才建好"的仓库）。
  所以今天先建仓库推送，明天再提 PR。
- 提交方式：fork 那个仓库 → 新增文件 `data/plugins/underworld-oddball__sh-volume-shuff.yml`
  → 开 PR。内容就是本仓库根目录的 `catalog/underworld-oddball__sh-volume-shuff.yml`（记得把 `underworld-oddball` 换成你的用户名）：

```yaml
url: https://github.com/underworld-oddball/sh-volume-shuff
name: underworld-oddball/sh-volume-shuff
category: voice
description:
  en: Speaker button beside the composer microphone — one click reads the newest agent reply aloud through dsh-tts (browser voice as fallback), the next click stops, and a press-then-drag-up opens a vertical mixer for in-page media volume and system output volume.
  zh: 输入框话筒旁的扬声器按钮——单击朗读最新一条智能体回复（走 dsh-tts，回退浏览器语音），再单击停止，按住上滑调出竖式混音台，分别控制页内媒体音量与系统输出音量。
```

**不要手工编辑那两个 README**——它们由 `data/plugins/*.yml` 生成，合并后自动重建。

收录前会核对（见仓库的 `contributing.md`）：

| 检查项 | 本仓库状态 |
| --- | --- |
| `package.json` 声明 `dsh.bundle.patch` | ✅ `{"bundle":{"patch":"./cordis.patch.yml"},"client":{"platform":"web"}}` |
| 仓库根有 `cordis.patch.yml` | ✅ |
| 有真实可用的代码（非占位） | ✅ `lib/index.js` + `lib/client.js` |
| 仓库创建满 1 天 | ⏳ 建好后的第二天再提 PR |
| 加了 `dsh-plugin` topic | ⏳ 第 2 步 |
| 描述与实际功能一致、不含营销词 | ✅ 逐条对照过代码 |
| 分类贴合 | `voice`（朗读 + 音量） |

## 5. 发到 npm（要「不带 github:」的安装命令就靠这步）

`dsh plugin --profile web add sh-volume-shuff` 这种短命令是**从 npm 解析**的，所以必须发一次 npm。

**名字已确认可用**：`sh-volume-shuff` 在 registry.npmjs.org 上是 404（未被占用）。

```sh
cd ~/Desktop/harness/sh-volume-shuff

npm login                       # 网页登录或粘贴 token
npm whoami                      # 确认已登录

npm pack --dry-run              # 预演：应只打包 6 个文件
#   LICENSE  README.md  cordis.patch.yml  lib/client.js  lib/index.js  package.json

npm publish --access public
```

发布后立刻可用：

```sh
dsh plugin --profile web add sh-volume-shuff
```

说明：

- 包名没占用，但**先发先得**——想占住就尽早 `npm publish`。
- `private` 字段已从 `package.json` 去掉；`files` 只列了 `lib/`、`cordis.patch.yml`、`README.md`、`LICENSE`（`PUBLISH.md`、`catalog/`、`.gitignore` 不会进 tarball）。
- 后续更新：改 `version`（如 `0.1.1`）→ `git commit` → `npm publish`（会弹一次浏览器确认 + 安全密钥，不需要恢复码）。
- npm 上发了之后，市场条目里的安装命令会自动变成短的 `dsh plugin --profile web add sh-volume-shuff`（第 3 步的收录条目本身不用改，仍只交那一个 YAML）。

## 6. 以后免交互发版：Trusted Publishing（OIDC）

已经提交了 `.github/workflows/publish.yml`：推一个 `vX.Y.Z` tag 就自动发版，**不需要任何 token、也不需要浏览器确认/动态码**。这一步要你在 npm 网页上配一次授权（只能包主自己配）。

### 6.1 在 npmjs.com 配置 Trusted Publisher

打开 <https://www.npmjs.com/package/sh-volume-shuff/access>（包的 Settings → **Trusted Publisher**）→ **Select your publisher** 选 **GitHub Actions**：

| 字段 | 填 |
|---|---|
| Organization or user | `underworld-oddball` |
| Repository | `sh-volume-shuff` |
| Workflow filename | `publish.yml`（只写文件名，必须带 `.yml`；文件要真在 `.github/workflows/` 里） |
| Environment name | 留空（除非你用 GitHub Environments 做发布审批） |
| **Allowed actions** | ⚠️ **还要勾上允许 `npm publish`**。2026-09-03 之后新建的 trusted publisher 默认只允许 `npm stage publish`（暂存后需人工批准）；只勾默认项的话工作流会失败或变成待批准。 |

> 前提：npm CLI ≥ **11.5.1**、Node ≥ **22.14.0**——workflow 里用 `actions/setup-node@v6` + Node 24，满足。

### 6.2 发新版

```sh
# 1. 改 package.json 的 version，比如 0.1.1
git commit -am "sh-volume-shuff 0.1.1"
git tag v0.1.1
git push && git push --tags        # workflow 会跑：校验 tag 与 version 一致 → npm publish --provenance
```

工作流内置了一道保险：**tag 与 `package.json` 的 version 不一致就直接失败**（`v0.1.1` ↔ `0.1.1`）。

配好之后，网页里那个 "Require two-factor authentication for write actions" 勾可以一直留着——OIDC 不走 2FA 那套 CLI 挑战。

## 7. 收录之后

列表合并后，`dsh-market` 会自动同步目录，用户就能在**设置 → 插件市场**里搜到并一键安装：

```sh
dsh plugin --profile web add sh-volume-shuff          # 已发 npm
dsh plugin --profile web add github:underworld-oddball/sh-volume-shuff   # 未发 npm 时的等价写法
```


