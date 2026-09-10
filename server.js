const http = require("node:http");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 3210);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATABASE_PATH = path.join(DATA_DIR, "bilibili-tags.sqlite");
const TAG_OVERRIDES_PATH = path.join(ROOT, "tag-overrides.json");
const BILI_FAV_API = "https://api.bilibili.com/x/v3/fav/resource/list";
const BILI_TAG_API = "https://api.bilibili.com/x/tag/archive/tags";
const PAGE_SIZE = 20;
const MAX_RETRIES = 3;
const ZONE_MAIN_BY_TID_V2 = new Map([
  [1001, "影视"],
  [1002, "娱乐"],
  [1003, "音乐"],
  [1004, "舞蹈"],
  [1005, "动画"],
  [1006, "绘画"],
  [1007, "鬼畜"],
  [1008, "游戏"],
  [1009, "资讯"],
  [1010, "知识"],
  [1011, "人工智能"],
  [1012, "科技数码"],
  [1013, "汽车"],
  [1014, "时尚美妆"],
  [1015, "家装房产"],
  [1016, "户外潮流"],
  [1017, "健身"],
  [1018, "体育运动"],
  [1019, "手工"],
  [1020, "美食"],
  [1021, "小剧场"],
  [1022, "旅游出行"],
  [1023, "三农"],
  [1024, "动物"],
  [1025, "亲子"],
  [1026, "健康"],
  [1027, "情感"],
  [1028, "神秘学"],
  [1029, "vlog"],
  [1030, "生活兴趣"],
  [1031, "生活经验"]
]);

const ZONE_MAIN_RANGES = [
  [2001, 2008, "影视"],
  [2009, 2015, "娱乐"],
  [2016, 2027, "音乐"],
  [2028, 2036, "舞蹈"],
  [2037, 2054, "动画"],
  [2055, 2058, "绘画"],
  [2059, 2063, "鬼畜"],
  [2064, 2079, "游戏"],
  [2080, 2083, "资讯"],
  [2084, 2095, "知识"],
  [2096, 2098, "人工智能"],
  [2099, 2105, "科技数码"],
  [2106, 2110, "汽车"],
  [2111, 2119, "时尚美妆"],
  [2120, 2123, "家装房产"],
  [2124, 2127, "户外潮流"],
  [2128, 2132, "健身"],
  [2133, 2142, "体育运动"],
  [2143, 2148, "手工"],
  [2149, 2153, "美食"],
  [2154, 2157, "小剧场"],
  [2158, 2161, "旅游出行"],
  [2162, 2166, "三农"],
  [2167, 2171, "动物"],
  [2172, 2178, "亲子"],
  [2179, 2184, "健康"],
  [2185, 2188, "情感"],
  [2189, 2193, "神秘学"],
  [2194, 2197, "vlog"],
  [2198, 2202, "生活兴趣"],
  [2203, 2205, "生活经验"],
  [2206, 2299, "其他"]
];

const BILI_HEADERS = {
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Referer": "https://space.bilibili.com/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
};

const LEGACY_FAV_HEADERS = {
  ...BILI_HEADERS,
  "Origin": "https://www.bilibili.com",
  "Referer": "https://www.bilibili.com/"
};

fsSync.mkdirSync(DATA_DIR, { recursive: true });
const database = new DatabaseSync(DATABASE_PATH);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS scanned_videos (
    folder_id TEXT NOT NULL,
    bvid TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    intro TEXT NOT NULL DEFAULT '',
    duration INTEGER NOT NULL DEFAULT 0,
    upper_name TEXT NOT NULL DEFAULT '',
    upper_mid TEXT NOT NULL DEFAULT '',
    fav_time INTEGER NOT NULL DEFAULT 0,
    pub_time INTEGER NOT NULL DEFAULT 0,
    partition_tid INTEGER,
    partition_tid_v2 INTEGER,
    partition_name TEXT NOT NULL DEFAULT '',
    partition_main TEXT NOT NULL DEFAULT '未知分区',
    tags_json TEXT NOT NULL DEFAULT '[]',
    tag_meta_json TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'page',
    scanned_at INTEGER NOT NULL,
    PRIMARY KEY (folder_id, bvid)
  );

  CREATE INDEX IF NOT EXISTS idx_scanned_videos_folder_time
  ON scanned_videos (folder_id, fav_time DESC);
`);

const upsertVideoStatement = database.prepare(`
  INSERT INTO scanned_videos (
    folder_id, bvid, title, intro, duration, upper_name, upper_mid,
    fav_time, pub_time, partition_tid, partition_tid_v2, partition_name,
    partition_main, tags_json, tag_meta_json, source, scanned_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(folder_id, bvid) DO UPDATE SET
    title = excluded.title,
    intro = excluded.intro,
    duration = excluded.duration,
    upper_name = excluded.upper_name,
    upper_mid = excluded.upper_mid,
    fav_time = excluded.fav_time,
    pub_time = excluded.pub_time,
    partition_tid = excluded.partition_tid,
    partition_tid_v2 = excluded.partition_tid_v2,
    partition_name = excluded.partition_name,
    partition_main = excluded.partition_main,
    tags_json = excluded.tags_json,
    tag_meta_json = excluded.tag_meta_json,
    source = excluded.source,
    scanned_at = excluded.scanned_at
`);
const getCachedVideosStatement = database.prepare(`
  SELECT * FROM scanned_videos
  WHERE folder_id = ?
  ORDER BY fav_time DESC
`);
const countCachedVideosStatement = database.prepare(`
  SELECT COUNT(*) AS count, MAX(scanned_at) AS latest
  FROM scanned_videos
  WHERE folder_id = ?
`);
const clearCachedVideosStatement = database.prepare(`
  DELETE FROM scanned_videos
  WHERE folder_id = ?
`);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendNdjson(res, payload) {
  res.write(`${JSON.stringify(payload)}\n`);
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("请求内容过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error("JSON 格式无效"));
      }
    });
    req.on("error", reject);
  });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("ABORTED"));
      return;
    }

    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("ABORTED"));
      },
      { once: true }
    );
  });
}

async function fetchJson(url, signal, headers = BILI_HEADERS) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers,
        signal
      });
      const text = await response.text();
      let data;

      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`接口返回了非 JSON 内容（HTTP ${response.status}）`);
      }

      if (!response.ok) {
        const error = new Error(
          `HTTP ${response.status}: ${data.message || "请求失败"}`
        );
        error.status = response.status;
        throw error;
      }

      if (data.code !== 0) {
        const error = new Error(data.message || `B站接口错误 ${data.code}`);
        error.code = data.code;
        throw error;
      }

      return data.data;
    } catch (error) {
      if (signal?.aborted || error.name === "AbortError") {
        throw new Error("ABORTED");
      }

      lastError = error;
      if (error.status === 412) break;
      if (attempt >= MAX_RETRIES) break;
      await sleep(700 * 2 ** (attempt - 1), signal);
    }
  }

  throw lastError || new Error("请求失败");
}

async function fetchFavPage(mediaId, page, signal, apiState) {
  if (apiState.folderApi !== "legacy") {
    const params = new URLSearchParams({
      media_id: String(mediaId),
      pn: String(page),
      ps: String(PAGE_SIZE),
      keyword: "",
      order: "mtime",
      type: "0",
      tid: "0",
      platform: "web"
    });

    try {
      const data = await fetchJson(`${BILI_FAV_API}?${params}`, signal);
      apiState.folderApi = "v3";
      const mediaCount = Number(data.info?.media_count || 0);
      return {
        data,
        hasMore:
          Boolean(data.has_more) ||
          (mediaCount > 0 && page * PAGE_SIZE < mediaCount)
      };
    } catch (error) {
      if (error.message === "ABORTED") throw error;
      apiState.folderApi = "legacy";
    }
  }

  const legacyParams = new URLSearchParams({
    media_id: String(mediaId),
    pn: String(page),
    ps: String(PAGE_SIZE)
  });
  const data = await fetchJson(
    `https://api.bilibili.com/medialist/gateway/base/detail?${legacyParams}`,
    signal,
    {
      ...LEGACY_FAV_HEADERS,
      "Referer": `https://www.bilibili.com/medialist/detail/ml${mediaId}?type=2`
    }
  );
  const medias = Array.isArray(data.medias) ? data.medias : [];
  const mediaCount = Number(data.info?.media_count || 0);
  return {
    data,
    hasMore:
      medias.length > 0 &&
      (mediaCount > 0
        ? page * PAGE_SIZE < mediaCount
        : medias.length >= PAGE_SIZE)
  };
}

async function fetchVideos(
  mediaId,
  limit,
  signal,
  skipBvids = new Set(),
  apiState = { folderApi: "v3" }
) {
  const videos = [];
  const seen = new Set();
  let folder = null;
  let page = 1;
  let hasMore = true;
  let totalScanned = 0;

  while (videos.length < limit && hasMore) {
    const pageResult = await fetchFavPage(mediaId, page, signal, apiState);
    const { data } = pageResult;
    const medias = Array.isArray(data.medias) ? data.medias : [];
    if (!folder) folder = data.info;
    totalScanned += medias.length;

    for (const media of medias) {
      if (media.type !== 2 || !media.bvid || seen.has(media.bvid)) continue;
      seen.add(media.bvid);
      if (skipBvids.has(media.bvid)) continue;
      videos.push({
        id: media.id,
        bvid: media.bvid,
        title: media.title || "",
        intro: media.intro || "",
        duration: media.duration || 0,
        upper: media.upper?.name || "未知UP主",
        upperMid: media.upper?.mid || 0,
        favTime: media.fav_time || 0,
        pubTime: media.pubtime || 0
      });
      if (videos.length >= limit) break;
    }

    hasMore = pageResult.hasMore && medias.length > 0;
    page += 1;
  }

  return {
    videos,
    totalScanned,
    folder,
    folderApi: apiState.folderApi
  };
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToCachedVideo(row) {
  return {
    type: "video",
    cached: true,
    video: {
      id: null,
      bvid: row.bvid,
      title: row.title,
      intro: row.intro,
      duration: row.duration,
      upper: row.upper_name,
      upperMid: row.upper_mid,
      favTime: row.fav_time,
      pubTime: row.pub_time
    },
    tags: safeJsonParse(row.tags_json, []),
    tagMeta: safeJsonParse(row.tag_meta_json, []),
    partition: {
      tid: row.partition_tid,
      tidV2: row.partition_tid_v2,
      name: row.partition_name,
      mainName: row.partition_main || "未知分区"
    },
    source: row.source
  };
}

function getCachedVideos(folderId) {
  return getCachedVideosStatement
    .all(String(folderId))
    .map(rowToCachedVideo);
}

function saveVideoRecord(folderId, payload) {
  const { video, tags, tagMeta, partition, source } = payload;
  upsertVideoStatement.run(
    String(folderId),
    video.bvid,
    video.title || "",
    video.intro || "",
    Number(video.duration) || 0,
    video.upper || "",
    String(video.upperMid || ""),
    Number(video.favTime) || 0,
    Number(video.pubTime) || 0,
    partition?.tid ?? null,
    partition?.tidV2 ?? null,
    partition?.name || "",
    partition?.mainName || "未知分区",
    JSON.stringify(tags || []),
    JSON.stringify(tagMeta || []),
    source || "page",
    Date.now()
  );
}

async function fetchVideoTags(bvid, signal) {
  const params = new URLSearchParams({
    bvid,
    web_location: "333.1387"
  });
  const data = await fetchJson(`${BILI_TAG_API}?${params}`, signal);
  return (Array.isArray(data) ? data : [])
    .map((item) => ({
      name: String(item.tag_name || "").trim(),
      type: String(item.type ?? "")
    }))
    .filter((item) => item.name);
}

function parseTagsFromVideoPage(html) {
  const marker = '"tags":[';
  let searchFrom = 0;
  let foundEmpty = false;

  while (searchFrom < html.length) {
    const markerIndex = html.indexOf(marker, searchFrom);
    if (markerIndex === -1) break;
    const arrayStart = markerIndex + marker.length - 1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let arrayEnd = -1;

    for (let index = arrayStart; index < html.length; index += 1) {
      const char = html[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === "[" || char === "{") {
        depth += 1;
      } else if (char === "]" || char === "}") {
        depth -= 1;
        if (depth === 0) {
          arrayEnd = index + 1;
          break;
        }
      }
    }

    if (arrayEnd !== -1) {
      try {
        const parsed = JSON.parse(html.slice(arrayStart, arrayEnd));
        if (Array.isArray(parsed)) {
          if (parsed.length === 0) {
            foundEmpty = true;
          }
          if (parsed.some((item) => item.tag_name)) {
            return parsed
              .filter((item) => item.tag_type !== "bgm")
              .map((item) => ({
                name: String(item.tag_name || "").trim(),
                type: String(item.tag_type || "")
              }))
              .filter((item) => item.name);
          }
        }
      } catch {
        // Try the next tags array in the page.
      }
    }

    searchFrom = markerIndex + marker.length;
  }

  if (foundEmpty) return [];
  throw new Error("视频页面中未找到标签数据");
}

function getMainZone(tidV2) {
  const tid = Number(tidV2);
  if (!Number.isFinite(tid)) return "";
  if (ZONE_MAIN_BY_TID_V2.has(tid)) return ZONE_MAIN_BY_TID_V2.get(tid);
  const range = ZONE_MAIN_RANGES.find(([min, max]) => tid >= min && tid <= max);
  return range?.[2] || "";
}

function decodeJsonString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value || "";
  }
}

function parsePartitionFromVideoPage(html, bvid) {
  const bvidIndex = html.indexOf(`"bvid":"${bvid}"`);
  const videoDataIndex = html.indexOf('"videoData":{', Math.max(0, bvidIndex));
  const start = videoDataIndex === -1 ? Math.max(0, bvidIndex) : videoDataIndex;
  const segment = html.slice(start, start + 3000);
  const tidMatch = segment.match(/"tid":(\d+)/);
  const tidV2Match = segment.match(/"tid_v2":(\d+)/);
  const tnameMatch = segment.match(/"tname":"([^"]*)"/);
  const tnameV2Match = segment.match(/"tname_v2":"([^"]*)"/);
  const tid = tidMatch ? Number(tidMatch[1]) : null;
  const tidV2 = tidV2Match ? Number(tidV2Match[1]) : null;
  const subName = decodeJsonString(tnameV2Match?.[1] || "");
  const oldName = decodeJsonString(tnameMatch?.[1] || "");
  return {
    tid,
    tidV2,
    name: subName || oldName || "",
    mainName: getMainZone(tidV2 || tid) || subName || oldName || "未知分区"
  };
}

async function fetchVideoPageData(bvid, signal) {
  const response = await fetch(`https://www.bilibili.com/video/${bvid}/`, {
    headers: {
      ...BILI_HEADERS,
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Referer": `https://www.bilibili.com/video/${bvid}/`
    },
    signal
  });

  if (!response.ok) {
    const error = new Error(`视频页面 HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const html = await response.text();
  return {
    tags: parseTagsFromVideoPage(html),
    partition: parsePartitionFromVideoPage(html, bvid)
  };
}

async function runPool(items, worker, concurrency, signal) {
  let nextIndex = 0;

  async function runner() {
    while (!signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }

  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runner()
  );
  await Promise.all(runners);
}

async function handleScan(req, res, url) {
  const mediaId = url.searchParams.get("mediaId") || "307741200";
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit")) || 200, 1),
    5000
  );
  const concurrency = Math.min(
    Math.max(Number(url.searchParams.get("concurrency")) || 3, 1),
    6
  );
  const interval = Math.min(
    Math.max(Number(url.searchParams.get("interval")) || 350, 150),
    3000
  );
  const requestedCacheMode = url.searchParams.get("cacheMode") || "resume";
  const cacheMode = ["resume", "refresh", "off"].includes(requestedCacheMode)
    ? requestedCacheMode
    : "resume";
  const controller = new AbortController();
  req.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive"
  });

  try {
    sendNdjson(res, {
      type: "status",
      stage: "folder",
      message: "正在读取收藏夹信息"
    });

    const cachedVideos = cacheMode === "resume" ? getCachedVideos(mediaId) : [];
    const cachedBvids = new Set(
      cachedVideos.map((record) => record.video.bvid)
    );
    const folderVideos = await fetchVideos(
      mediaId,
      limit,
      controller.signal,
      cachedBvids,
      { folderApi: "v3" }
    );
    const { videos, totalScanned, folder, folderApi } = folderVideos;
    let success = 0;
    let empty = 0;
    let failed = 0;
    let cachedCount = 0;
    let pageCount = 0;
    let apiFallbacks = 0;
    const totalCount = cachedVideos.length + videos.length;

    sendNdjson(res, {
      type: "meta",
      folder: {
        id: folder.id,
        title: folder.title,
        owner: folder.upper?.name || "",
        ownerMid: folder.upper?.mid || 0,
        mediaCount: folder.media_count || 0
      },
      requested: limit,
      cached: cachedVideos.length,
      newCount: videos.length,
      cacheMode,
      folderApi,
      total: totalCount,
      totalScanned
    });

    for (const cachedVideo of cachedVideos) {
      cachedCount += 1;
      if (cachedVideo.tags.length === 0) empty += 1;
      else success += 1;
      sendNdjson(res, {
        ...cachedVideo,
        index: cachedCount
      });
    }

    await runPool(
      videos,
      async (video, index) => {
        try {
          let tagItems;
          let partition = {
            tid: null,
            tidV2: null,
            name: "",
            mainName: "未知分区"
          };
          let source = "page";

          try {
            const pageData = await fetchVideoPageData(
              video.bvid,
              controller.signal
            );
            tagItems = pageData.tags;
            partition = pageData.partition;
            pageCount += 1;
          } catch (error) {
            if (error.message === "ABORTED") throw error;
            tagItems = await fetchVideoTags(video.bvid, controller.signal);
            source = "api";
            apiFallbacks += 1;
          }

          const tags = tagItems.map((item) => item.name).filter(Boolean);
          const tagMeta = tagItems.filter((item) => item.name);

          if (tags.length === 0) empty += 1;
          else success += 1;
          const payload = {
            type: "video",
            index: cachedVideos.length + index + 1,
            video,
            tags,
            tagMeta,
            partition,
            source,
            cached: false
          };
          if (cacheMode !== "off") {
            saveVideoRecord(mediaId, payload);
          }
          sendNdjson(res, payload);
        } catch (error) {
          if (error.message === "ABORTED") return;
          failed += 1;
          sendNdjson(res, {
            type: "videoError",
            index: cachedVideos.length + index + 1,
            video,
            error: error.message || "获取失败"
          });
        }
        await sleep(interval, controller.signal);
      },
      concurrency,
      controller.signal
    );

    if (!controller.signal.aborted) {
      sendNdjson(res, {
        type: "done",
        success,
        empty,
        failed,
        cached: cachedCount,
        pageCount,
        apiFallbacks,
        total: totalCount
      });
      res.end();
    }
  } catch (error) {
    if (error.message !== "ABORTED" && !res.writableEnded) {
      sendNdjson(res, {
        type: "fatal",
        error: error.message || "扫描失败"
      });
      res.end();
    }
  }
}

function handleCacheStatus(res, url) {
  const mediaId = url.searchParams.get("mediaId") || "";
  if (!/^\d+$/.test(mediaId)) {
    sendJson(res, 400, { error: "mediaId 无效" });
    return;
  }

  const row = countCachedVideosStatement.get(mediaId);
  sendJson(res, 200, {
    folderId: mediaId,
    count: Number(row?.count || 0),
    latestScannedAt: Number(row?.latest || 0) || null
  });
}

function handleClearCache(res, url) {
  const mediaId = url.searchParams.get("mediaId") || "";
  if (!/^\d+$/.test(mediaId)) {
    sendJson(res, 400, { error: "mediaId 无效" });
    return;
  }

  const result = clearCachedVideosStatement.run(mediaId);
  sendJson(res, 200, {
    folderId: mediaId,
    deleted: Number(result.changes || 0)
  });
}

async function readTagOverrides() {
  try {
    const payload = JSON.parse(await fs.readFile(TAG_OVERRIDES_PATH, "utf8"));
    return {
      version: 1,
      aliases: payload.aliases && typeof payload.aliases === "object"
        ? payload.aliases
        : {}
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { version: 1, aliases: {} };
    }
    throw error;
  }
}

async function handleTagOverrides(req, res) {
  try {
    if (req.method === "GET") {
      sendJson(res, 200, await readTagOverrides());
      return;
    }

    const payload = await readJsonBody(req);
    const aliases = {};
    for (const [source, target] of Object.entries(payload.aliases || {})) {
      const cleanSource = String(source || "").trim();
      const cleanTarget = String(target || "").trim();
      if (
        cleanSource &&
        cleanTarget &&
        cleanSource !== cleanTarget
      ) {
        aliases[cleanSource] = cleanTarget;
      }
    }

    const normalized = { version: 1, aliases };
    await fs.writeFile(
      TAG_OVERRIDES_PATH,
      `${JSON.stringify(normalized, null, 2)}\n`,
      "utf8"
    );
    sendJson(res, 200, normalized);
  } catch (error) {
    sendJson(res, 400, { error: error.message || "标签合并规则处理失败" });
  }
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.resolve(ROOT, `.${pathname}`);

  if (!filePath.startsWith(ROOT + path.sep)) {
    sendJson(res, 403, { error: "禁止访问" });
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon"
    };
    res.writeHead(200, {
      "Content-Type": contentTypes[extension] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(res, 404, { error: "文件不存在" });
      return;
    }
    sendJson(res, 500, { error: "读取文件失败" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === "GET" && url.pathname === "/api/scan") {
    await handleScan(req, res, url);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cache/status") {
    handleCacheStatus(res, url);
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/api/cache") {
    handleClearCache(res, url);
    return;
  }

  if (
    (req.method === "GET" || req.method === "POST") &&
    url.pathname === "/api/tag-overrides"
  ) {
    await handleTagOverrides(req, res);
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "仅支持 GET 请求" });
    return;
  }

  await serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`B站收藏夹标签统计已启动: http://${HOST}:${PORT}`);
});
