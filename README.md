# 加强版世界书

把社区 PR [flizzywine/dsh-tavern#271](https://github.com/flizzywine/dsh-tavern/pull/271) 的完整版世界书面板做成 Tavern 插件。

上游把那个 PR 收窄成了 260 行（只能换书 + 开关条目），砍掉的编辑器、查找替换、条目详情、常用条目、文件夹、设置、手机标签页都在这里。

界面上露出的名字是「加强版世界书」：侧栏开始页「插件」分组里的卡片、右侧栏页标题、顶栏按钮提示都用它。包名仍是 `dsh-tavern-worldbook-panel`（Tavern 按包名生成插件 id，不能带中文）。

这个仓库独立于 `dsh-tavern` 本体，也不参与它的发布清单——本体只负责加载 `plugins/` 下的目录，插件代码不进本体的提交历史。

仓库地址：https://github.com/bigmalove/dsh-tavern-worldbook-panel

## 装

**方式一：Tavern 里一键安装（推荐）**

设置 → DSH Tavern → 插件 → 粘贴 `https://github.com/bigmalove/dsh-tavern-worldbook-panel` → 安装 → 刷新页面。连不上 GitHub 时，在仓库页下载 ZIP，同一处点「上传 ZIP」。

插件没有运行时 npm 依赖：面板用的 React 由 Tavern 的模块加载器提供，`client.js` 已随仓库提交，装的时候不需要 `npm install`，也不需要构建。`package.json` 里因此不写 `dependencies`（Tavern 的一键安装看到非空 `dependencies` 会拒绝）。

**方式二：手动复制**

复制整个文件夹到 Tavern 数据目录的 `plugins/`（目录名必须是英文包名）：

```sh
git clone https://github.com/bigmalove/dsh-tavern-worldbook-panel \
  ~/.dsh-tavern/profile-data/tavern/data/plugins/dsh-tavern-worldbook-panel
```

或者直接拷贝现成的目录：

```sh
cp -r dsh-tavern-worldbook-panel ~/.dsh-tavern/profile-data/tavern/data/plugins/
```

不重启也能生效：宿主侧几秒内加载，浏览器侧刷新一次页面出现。删掉文件夹即卸载。

`client.js` 已随仓库提供，装的时候不需要构建。

## 用法

两个入口，用的是同一套面板：

1. **顶栏「世界书」按钮** —— 点开是浮层面板，贴在按钮下方。
2. **右侧栏开始页 →「插件」分组 →「世界书」** —— 打开一个常驻的侧栏页，面板铺满右栏。不占用对话区，可以一边看正文一边改世界书。

| 区域 | 能做什么 |
|---|---|
| 主面板 | 选书下拉、逐条开关、搜索条目、置顶、删除 |
| 全部世界书 | 分列列出所有书，按文件夹归类，可折叠 |
| 常用条目 | 按开关次数排序，可置顶，跨书汇总 |
| 条目详情 | 只读正文、常驻/关键词两档、排序、扫描消息、二级条件 |
| 大窗编辑 | 全屏编辑、`Ctrl+S` 保存、`Ctrl+F` 查找替换（单个/全部、区分大小写、实时计数）、未保存关闭会确认 |
| 设置 | 开关样式、显示元素、桌面/手机可视行数、手机双窗口、文件夹管理 |
| 「完整」 | 带当前书跳到右侧栏世界书库 |

手机（`<768px`）自动改成「世界书 / 条目 / 常用」三个标签页，详情与设置在面板内替换显示；设置里可以开「双窗口」，左栏固定书列表。

面板位置、置顶、使用次数、文件夹都记在 `localStorage`，不跟存档走。

## 实现说明

**为什么能接管 Tavern 自己的按钮**：Tavern 的顶栏项带 `data-header-item="dsh-tavern:worldbooks"`。插件在捕获阶段拦掉它的点击，改开自己的面板，所以界面里始终只有一个入口，位置和「折叠进 ⋮」的行为都还是 Tavern 自己的。按钮被折叠进「更多快捷入口」时，菜单项没有那个属性，插件按 `role=menuitem` + 文本「世界书」识别，仍然接管。如果哪天 Tavern 删了这个按钮，插件会自己露出一个图标兜底。

**为什么侧栏里能看见**：侧栏开始页的「插件」分组只收 `tavern-plugin:<owner>:<id>` 这种页 id，而它只能由 `tavernUi.registerPanel()` 产生。所以插件注册了一个 `worldbooks` 页（标题「世界书」），页内用 `embed` 形态渲染面板本体 —— `role="region"`、不写 inline 定位、由 CSS 铺满容器。

**和本体不冲突的前提**：Tavern 核心的顶栏面板已收窄成 260 行的最小版（只换书 + 开关条目 + 搜索 + 「完整」）。它仍然存在于核心里，但所有入口都被上面那层接管掉了，所以不会出现两套面板。

**数据怎么来**：走 Tavern 的同源路由 `POST /api/dsh-tavern/<method>`，用的还是 `listWorldBooks` / `getWorldBook` / `updateWorldBook` / `setGlobalWorldBook` / `deleteWorldBook` 这几个方法。这些不是 `docs/plugin-api.md` 承诺的插件接口，属于内部请求——Tavern 升级后若改名，面板会整体失效（报错停在面板里，不影响对局正文）。

**为什么类名是 `dsh-wbp-`**：插件和 Tavern 同时注入样式，Tavern 那份后注入且同样用 `.dsh-tavern-wbsw-*`，`flex-direction` 会被它覆盖成 `column`，三栏就叠成了竖排。换前缀是最省事也最不会互相打架的做法。

**没有「向量化」档**：`worldbook-activation.js` 只读 `constant`，其余条目一律走关键词匹配，`vectorized` 字段能存但没人读。摆出来就是改完不生效的开关。

## 开发

```sh
npm install              # 只装 react / react-dom / jsdom（跑测试用）
npm run build            # src/panel.js + src/panel.css → client.js
npm test                 # jsdom + 真 React 跑面板
```

提交前记得 `npm run build`：`client.js` 是产物，但仓库里要跟着源码一起更新，装的人才不用构建。
