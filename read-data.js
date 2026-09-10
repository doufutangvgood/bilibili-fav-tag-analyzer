const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const DATABASE_PATH = path.join(ROOT, "data", "bilibili-tags.sqlite");
const args = process.argv.slice(2);
const command = args[0] || "summary";

function getArg(name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function parseTags(value) {
  try {
    return JSON.parse(value || "[]");
  } catch {
    return [];
  }
}

function formatTime(seconds) {
  if (!seconds) return "";
  return new Date(Number(seconds) * 1000).toLocaleString("zh-CN", {
    hour12: false
  });
}

function csvEscape(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

if (!fs.existsSync(DATABASE_PATH)) {
  console.error(`数据库不存在：${DATABASE_PATH}`);
  process.exit(1);
}

const database = new DatabaseSync(DATABASE_PATH, { readOnly: true });
const folderId = getArg("--folder");
const limit = Math.max(1, Number(getArg("--limit", "20")) || 20);

function showSummary() {
  const rows = database.prepare(`
    SELECT
      folder_id,
      COUNT(*) AS video_count,
      SUM(CASE WHEN tags_json = '[]' THEN 1 ELSE 0 END) AS empty_count,
      MAX(scanned_at) AS latest
    FROM scanned_videos
    GROUP BY folder_id
    ORDER BY latest DESC
  `).all();

  if (rows.length === 0) {
    console.log("数据库里还没有扫描记录。");
    return;
  }

  console.table(rows.map((row) => ({
    收藏夹ID: row.folder_id,
    视频数: row.video_count,
    无标签: row.empty_count,
    最近扫描: new Date(row.latest).toLocaleString("zh-CN", { hour12: false })
  })));
}

function getVideos() {
  if (!folderId) {
    throw new Error("请用 --folder 指定收藏夹 ID。");
  }
  return database.prepare(`
    SELECT *
    FROM scanned_videos
    WHERE folder_id = ?
    ORDER BY fav_time DESC
  `).all(folderId);
}

function showList() {
  const videos = getVideos().slice(0, limit);
  console.table(videos.map((video, index) => ({
    序号: index + 1,
    BV号: video.bvid,
    标题: video.title,
    UP主: video.upper_name,
    分区: video.partition_main,
    标签: parseTags(video.tags_json).join(" / "),
    收藏时间: formatTime(video.fav_time)
  })));
}

function exportJson() {
  const videos = getVideos().map((video) => ({
    folderId: video.folder_id,
    bvid: video.bvid,
    title: video.title,
    intro: video.intro,
    duration: video.duration,
    upper: {
      mid: video.upper_mid,
      name: video.upper_name
    },
    favTime: video.fav_time,
    pubTime: video.pub_time,
    partition: {
      tid: video.partition_tid,
      tidV2: video.partition_tid_v2,
      name: video.partition_name,
      mainName: video.partition_main
    },
    tags: parseTags(video.tags_json),
    scannedAt: video.scanned_at
  }));
  const output = getArg(
    "--output",
    path.join(ROOT, "data", `videos-${folderId}.json`)
  );
  fs.writeFileSync(output, `${JSON.stringify(videos, null, 2)}\n`, "utf8");
  console.log(`已导出 ${videos.length} 条记录：${output}`);
}

function exportCsv() {
  const videos = getVideos();
  const header = [
    "folder_id",
    "bvid",
    "title",
    "upper_name",
    "main_partition",
    "fav_time",
    "tags"
  ];
  const lines = [
    header.map(csvEscape).join(","),
    ...videos.map((video) => [
      video.folder_id,
      video.bvid,
      video.title,
      video.upper_name,
      video.partition_main,
      formatTime(video.fav_time),
      parseTags(video.tags_json).join("|")
    ].map(csvEscape).join(","))
  ];
  const output = getArg(
    "--output",
    path.join(ROOT, "data", `videos-${folderId}.csv`)
  );
  fs.writeFileSync(output, `\uFEFF${lines.join("\r\n")}`, "utf8");
  console.log(`已导出 ${videos.length} 条记录：${output}`);
}

try {
  if (command === "summary") showSummary();
  else if (command === "list") showList();
  else if (command === "export-json") exportJson();
  else if (command === "export-csv") exportCsv();
  else {
    console.log([
      "用法：",
      "  node read-data.js",
      "  node read-data.js list --folder 307741200 --limit 20",
      "  node read-data.js export-json --folder 307741200",
      "  node read-data.js export-csv --folder 307741200"
    ].join("\n"));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  database.close();
}
