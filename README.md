# B站收藏夹标签统计

这是一个零依赖的本地工具。它读取指定公开收藏夹的视频，提取每个视频的标签、`tid_v2` 分区和标签类型，然后在本地统计标签数量、主要分区和语义分类。

## 使用方法

1. 安装 Node.js 22.5 或更高版本。本工具使用 Node.js 内置 SQLite，不需要安装第三方依赖。
2. 双击 `start.ps1`，或在 PowerShell 中运行：

   ```powershell
   .\start.ps1
   ```

3. 浏览器会打开 `http://127.0.0.1:3210`。
4. 默认收藏夹 `media_id` 为 `307741200`，默认扫描最近 200 个视频。
5. 点击“开始统计”，等待进度完成后导出 CSV 或 JSON。

也可以直接运行：

```powershell
node server.js
```

## 统计口径

- 只统计收藏夹中 `type=2` 的视频条目。
- 同一视频内重复标签只计一次。
- “标签覆盖率”以成功取到标签的视频数为分母。
- 无标签视频计入“无标签”，接口失败计入“获取失败”。
- 默认优先读取视频页面内嵌的公开标签与 `tid_v2`，标签 API 只作为备用来源。
- `tid_v2` 按 `video_zone_v2` 主分区规则归并，视频页没有分区数据时显示为“未知分区”。
- 标签语义分类规则集中在 `tag-taxonomy.js`，当前包含 `IP/作品`、`游戏`、`活动/激励`、`动画/影视`、`科技/AI`、`音乐/舞蹈`、`知识/科普`、`生活/娱乐`、`情感/人物`、`其他`。
- 一个标签可以同时属于多个语义分类，例如“原神”可同时归入 `IP/作品` 和 `游戏`。

## 本地记录与断点续扫

- 扫描记录保存在 `data/bilibili-tags.sqlite`，数据库不提交到 Git。
- 每条记录以“收藏夹 ID + BV号”为唯一键，同一视频不会重复请求。
- `断点续扫` 模式会先加载本地记录，再从收藏夹顶部向后查找未记录视频，最多新增输入框指定的数量。
- 已成功获取标签或确认无标签的视频会写入数据库；失败项不写入，下次扫描会自动重试。
- `重新抓取并更新记录` 会忽略已有结果，抓取指定数量并覆盖对应记录。
- `本次不读取也不保存` 不读取缓存，也不写入缓存。
- 页面支持多选分类：同一分类按钮点击顺序为“包含、排除、清除”，包含条件之间取并集，排除条件最后生效。
- 分类筛选会按收藏夹 ID 保存到浏览器本地，刷新页面后自动恢复；“重置筛选”可一键清除。
- 标签表默认每页显示 100 条，渲染使用节流批处理，避免大批量收藏导致页面卡死。

## 读取本地数据库

可以直接双击数据库文件使用 DB Browser for SQLite，也可以使用内置读取脚本：

```powershell
# 查看每个收藏夹的记录数量
node read-data.js

# 查看最近 20 条视频
node read-data.js list --folder 307741200 --limit 20

# 导出该收藏夹全部视频和标签
node read-data.js export-json --folder 307741200
node read-data.js export-csv --folder 307741200
```

默认导出到 `data/videos-<收藏夹ID>.json` 或 `.csv`，也可以通过 `--output` 指定路径。

`data/bilibili-tags.sqlite-shm` 和 `data/bilibili-tags.sqlite-wal` 是 SQLite 的运行时辅助文件，不要单独修改或删除。正确读取入口是 `data/bilibili-tags.sqlite`。

## 手动合并标签

- 点击“合并标签”进入合并模式，勾选一个或多个标签。
- 输入合并后的名称，点击“确认合并”。
- 合并规则写入项目根目录的 `tag-overrides.json`。
- 合并会在现有数据上立即重新统计，无需重新扫描。
- 导出的 JSON 会同时包含合并规则。

## 参考实现

- [jqwgt/bilibili-favlist-classifier](https://github.com/jqwgt/bilibili-favlist-classifier)：按 `tid_v2` 进行收藏夹分区分类，映射来源为 `bilibili-API-collect` 的视频分区 V2 文档。
- [PractiseForTwoAndHalfYear/biliFav](https://github.com/PractiseForTwoAndHalfYear/biliFav)：按标题关键词归类内容主题，可用于扩展标签语义规则。
- [nICEnnnnnnnLee/BilibiliDown](https://github.com/nICEnnnnnnnLee/BilibiliDown)：收藏夹列表每页读取 20 条，速度主要来自后续 3 个下载任务并发和多线程传输，并不抓取视频标签。

## 注意

- 本工具不下载视频，不读取浏览器 Cookie，也不会上传收藏数据。
- B 站公开接口可能调整或限流。如果大量请求失败，请降低并发、提高请求间隔后重试。
- 收藏夹显示约 50,000 条，但全量标签抓取需要约 50,000 次请求。当前默认只扫描最近 200 条，避免长时间占用网络或触发限流。
