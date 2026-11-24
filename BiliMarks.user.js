// ==UserScript==
// @name         BiliMarks - B站学习打点
// @name:zh-CN   BiliMarks - B站学习打点
// @namespace    https://github.com/zhuoning560Johnny/BiliMarks
// @version      8.0.0
// @downloadURL  https://raw.githubusercontent.com/zhuoning560Johnny/BiliMarks/main/BiliMarks.user.js
// @updateURL    https://raw.githubusercontent.com/zhuoning560Johnny/BiliMarks/main/BiliMarks.user.js
// @description  看B站录播按鼠标中键（或 Ctrl+Shift+X）记下这一刻，不暂停、不弹窗；每个点自动生成可点击的跳转链接，点一下回到那一秒；打点自动按天建文件夹、每节课一个 Markdown，悬停图标还能当场看本课全部时间点。零依赖、不联网、数据只存本机。
// @author       Xu Zhuoning
// @license      MIT
// @match        *://www.bilibili.com/video/*
// @match        *://bilibili.com/video/*
// @match        *://www.bilibili.com/list/*
// @match        *://www.bilibili.com/bangumi/play/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * BiliMarks - B站学习打点
 * 给"边看录播边记重点"的人用的一条最小链路：
 *   打点 → 本地保存 → 悬停跳回 → 按天导出
 *
 * 快捷键 / 手势
 *   打点   画面空白处按鼠标中键 | Ctrl+Shift+X | 单击小图标
 *   撤销   Shift+中键 | Ctrl+Shift+Z | Shift+单击小图标
 *   导出   Ctrl+Shift+E | Ctrl+单击小图标（写入文件夹并复制到剪贴板）
 *
 * 复习
 *   回到同一节课，鼠标悬停小图标 → 列出本课全部时间点 → 点一条直接跳转
 *
 * 文件
 *   你选的文件夹\YYYY-MM-DD\标题_P2_BV号.md
 *   导出时 2 秒内的相邻点合并为一行；另给一行「重点集中在 起点–终点」
 *   文件里其它文字（你手写的笔记）不会被覆盖
 *
 * 数据
 *   原始点只存浏览器 localStorage（键前缀 bn4_），不上传、不联网。
 *   需要浏览器支持 File System Access API（Chrome / Edge 等 Chromium 内核）。
 *   @grant none 是必须的：文件系统能力在油猴沙盒里无法调用。
 */
(function () {
    'use strict';

    var VERSION = '8.0.0';
    if (window.__bnDotV8) return;                 // 本脚本已经在这个页面运行
    if (window.__bnDotV6Loaded) {                 // 旧版（v6/v7）正在运行：明确提示，不重复启动
        try {
            var warn = document.createElement('div');
            warn.textContent = '⚠ 旧版打点脚本正在运行：请在油猴里只保留一个打点脚本，然后刷新页面';
            warn.style.cssText = 'position:fixed;left:8px;top:8px;z-index:2147483000;background:#b43c28;color:#fff;font:12px/1.4 sans-serif;padding:6px 10px;border-radius:6px';
            (document.body || document.documentElement).appendChild(warn);
            setTimeout(function () { try { warn.remove(); } catch (e) {} }, 8000);
        } catch (e) {}
        return;
    }
    window.__bnDotV8 = true;
    window.__bnDotV6Loaded = true;               // 占住旧标记，防止旧版稍后启动
    try { console.log('[B站打点 v' + VERSION + '] 已注入 ' + location.href); } catch (e) {}

    // 最外层保护：任何异常只打日志，不影响页面和播放器
    try { main(); } catch (err) {
        try { console.error('[B站打点] 启动失败（视频不受影响）', err); } catch (e) {}
    }

    function main() {
        var NS = 'bn4_';
        var POS_KEY = NS + 'iconPos';
        var DEFAULT_POS = { rx: 0.012, ry: 0.42 };
        var COLOR_IDLE = 'rgba(20,20,20,0.72)';
        var COLOR_OK   = 'rgba(22,140,80,0.92)';
        var COLOR_WARN = 'rgba(180,60,40,0.92)';
        var COLOR_INFO = 'rgba(40,90,170,0.92)';
        var ROOT_ID = 'bn5-dot-root';

        // ══════════════════════════════════════════════════════════
        // 纯函数区（不依赖页面、不依赖外部变量；测试时单独取出运行）
        // ══════════════════════════════════════════════════════════
        // <<CORE
        function pad(n) { return (n < 10 ? '0' : '') + n; }
        function fmt(t) {
            t = Math.max(0, Math.floor(t));
            var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
            return h > 0 ? (pad(h) + ':' + pad(m) + ':' + pad(s)) : (pad(m) + ':' + pad(s));
        }
        function dayOf(ms) {
            var d = new Date(ms);
            if (isNaN(d.getTime())) return '';
            return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
        }
        function validAt(at) { return typeof at === 'number' && isFinite(at) && at > 0 && dayOf(at) !== ''; }
        function isEp(id) { return /^ep/i.test(id); }
        function videoUrl(bvid, p) {
            return isEp(bvid) ? 'https://www.bilibili.com/bangumi/play/' + bvid
                              : 'https://www.bilibili.com/video/' + bvid + '/?p=' + p;
        }
        function jumpUrl(bvid, p, t) {
            t = Math.floor(t);
            return isEp(bvid) ? 'https://www.bilibili.com/bangumi/play/' + bvid + '?t=' + t
                              : 'https://www.bilibili.com/video/' + bvid + '/?p=' + p + '&t=' + t;
        }
        function safeName(s) {
            return String(s).replace(/[\\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 40).replace(/[. ]+$/, '') || 'video';
        }
        function pointLine(bvid, p, t) { return '- ' + fmt(t) + '  ' + jumpUrl(bvid, p, t); }

        // 导出时合并：按视频时间升序，距上一个保留点 ≥2 秒才保留；原始点不动
        function mergePoints(pts) {
            var a = pts.map(function (p, i) { return { t: p.t, at: (typeof p.at === 'number' && isFinite(p.at)) ? p.at : 8.64e15, i: i, src: p }; });
            a.sort(function (x, y) { return (x.t - y.t) || (x.at - y.at) || (x.i - y.i); });
            var kept = [], last = null;
            for (var k = 0; k < a.length; k++) {
                if (last === null || a[k].t - last >= 2) { kept.push(a[k].src); last = a[k].t; }
            }
            return kept;
        }
        // 重点段：8 分钟窗口内保留点最多的一段；并列取最早；显示窗口里真正有点的首末时刻
        function focusLine(kept) {
            if (!kept.length) return '';
            var best = 0, bi = 0, bj = 0, j = 0;
            for (var i = 0; i < kept.length; i++) {
                if (j < i) j = i;
                while (j + 1 < kept.length && kept[j + 1].t < kept[i].t + 480) j++;
                if (j - i + 1 > best) { best = j - i + 1; bi = i; bj = j; }
            }
            return '重点集中在 ' + fmt(kept[bi].t) + '–' + fmt(kept[bj].t);
        }

        function isGenMeta(line) {
            return /^日期：\d{4}-\d{2}-\d{2}\s*$/.test(line) || /^视频：https?:\/\/\S+\s*$/.test(line) || /^重点集中在 \S+\s*$/.test(line);
        }
        // 本脚本生成的标准点行，且属于这一节课 → 返回秒数；否则 -1（当作用户手写的字保留）
        function parsePointLine(line, bvid, p) {
            var m = /^- (?:\d{1,3}:)?\d{2}:\d{2}  (https:\/\/www\.bilibili\.com\/\S+?)\s*$/.exec(line);
            if (!m) return -1;
            var u = m[1], x;
            if (isEp(bvid)) {
                x = /\/bangumi\/play\/(ep\d+)\?t=(\d+)$/.exec(u);
                return (x && x[1] === bvid) ? +x[2] : -1;
            }
            x = /\/video\/([^\/?#]+)\/\?p=(\d+)&t=(\d+)$/.exec(u);
            return (x && x[1] === bvid && x[2] === String(p)) ? +x[3] : -1;
        }
        function renderBlock(bvid, p, day, kept) {
            var lines = [];
            if (!kept.length) return lines;
            if (day) lines.push('日期：' + day);
            lines.push('视频：' + videoUrl(bvid, p));
            lines.push(focusLine(kept));
            lines.push('');
            for (var i = 0; i < kept.length; i++) lines.push(pointLine(bvid, p, kept[i].t));
            return lines;
        }

        // 把"当天本课的点"写进已有文件文本（或新建）。只替换脚本生成的行，其余文字原样保留。
        // ctx: { title, bvid, p, day, pts:[{t,at}], tomb:[秒] }
        function mergeFileText(oldText, ctx) {
            var eol = '\n', lines = [];
            if (oldText) {
                eol = oldText.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
                lines = oldText.split(/\r?\n/);
                if (lines.length && lines[lines.length - 1] === '') lines.pop();
            }
            var n = lines.length, isGen = [], rem = [], foreign = [], firstGen = -1, i;
            for (i = 0; i < n; i++) {
                var g = 0;
                if (isGenMeta(lines[i])) g = 1;
                else { var s = parsePointLine(lines[i], ctx.bvid, ctx.p); if (s >= 0) { g = 1; foreign.push(s); } }
                isGen.push(g);
                if (g && firstGen < 0) firstGen = i;
            }
            for (i = 0; i < n; i++) {
                rem.push(isGen[i] || (lines[i].trim() === '' && ((i > 0 && isGen[i - 1]) || (i + 1 < n && isGen[i + 1]))) ? 1 : 0);
            }
            var kept = [], idx = -1;
            for (i = 0; i < n; i++) {
                if (i === firstGen) idx = kept.length;
                if (!rem[i]) kept.push(lines[i]);
            }
            var hk = -1;
            for (i = 0; i < kept.length; i++) { if (/^# /.test(kept[i])) { hk = i; break; } }
            if (idx < 0) idx = hk >= 0 ? hk + 1 : 0;

            // 合并本机原始点 + 文件里已有、但本机没有（也没被撤销）的点
            var localFloor = {}, tomb = {}, combined = ctx.pts.slice();
            ctx.pts.forEach(function (q) { localFloor[Math.floor(q.t)] = 1; });
            (ctx.tomb || []).forEach(function (sec) { tomb[sec] = 1; });
            foreign.forEach(function (sec) { if (!localFloor[sec] && !tomb[sec]) combined.push({ t: sec }); });
            var block = renderBlock(ctx.bvid, ctx.p, ctx.day, mergePoints(combined));

            var out = [];
            if (hk < 0) { out.push('# ' + ctx.title + '（P' + ctx.p + '）'); out.push(''); }
            var before = kept.slice(0, idx), after = kept.slice(idx);
            Array.prototype.push.apply(out, before);
            if (block.length) {
                if (out.length && out[out.length - 1] !== '') out.push('');
                Array.prototype.push.apply(out, block);
                if (after.length && after[0] !== '') out.push('');
            } else if (firstGen >= 0 && out.length && after.length && out[out.length - 1] !== '' && after[0] !== '') {
                out.push('');
            }
            Array.prototype.push.apply(out, after);
            while (out.length && out[out.length - 1] === '') out.pop();
            return out.join(eol) + eol;
        }

        // 剪贴板/下载用：本课全部点，按日期分段；日期未知的单列
        function buildMulti(title, bvid, p, arr) {
            var groups = {}, unknown = [];
            arr.forEach(function (q) {
                if (validAt(q.at)) { var d = dayOf(q.at); (groups[d] = groups[d] || []).push(q); } else unknown.push(q);
            });
            var lines = ['# ' + title + '（P' + p + '）', '', '视频：' + videoUrl(bvid, p), ''];
            Object.keys(groups).sort().forEach(function (d) {
                var k = mergePoints(groups[d]);
                lines.push('## ' + d, focusLine(k), '');
                k.forEach(function (q) { lines.push(pointLine(bvid, p, q.t)); });
                lines.push('');
            });
            if (unknown.length) {
                var u = mergePoints(unknown);
                lines.push('## 日期未知', '');
                u.forEach(function (q) { lines.push(pointLine(bvid, p, q.t)); });
                lines.push('');
            }
            return lines.join('\n');
        }
        // CORE>>

        // ══════════ 页面 / 视频识别 ══════════
        function getBvid() {
            var m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+|av[0-9]+)/i);
            if (m) return m[1];
            var q = new URLSearchParams(location.search).get('bvid');   // /list/ 连播页
            if (q && /^(BV[0-9A-Za-z]+|av[0-9]+)$/i.test(q)) return q;
            var b = location.pathname.match(/\/bangumi\/play\/(ep[0-9]+)/i);   // 番剧/课程单集页
            if (b) return b[1];
            return '';
        }
        function onVideoPage() { return getBvid() !== ''; }
        function curPage() {
            var p = new URLSearchParams(location.search).get('p');
            return (p && /^\d+$/.test(p)) ? p : '1';
        }
        function dataKey(bvid, p) { return NS + (bvid || getBvid()) + '_p' + (p || curPage()); }
        function lessonCtx() { var b = getBvid(), p = curPage(); return { bvid: b, p: p, key: dataKey(b, p) }; }

        // 只读 currentTime，不对 <video> 做任何操作（唯一例外：用户点悬停列表时 seek）
        function mainVideo() {
            var box = document.querySelector('.bpx-player-video-wrap') || document.querySelector('.bpx-player-container') || document;
            var list = Array.prototype.slice.call(box.querySelectorAll('video'));
            if (!list.length && box !== document) list = Array.prototype.slice.call(document.querySelectorAll('video'));
            var ok = list.filter(function (v) { return v.offsetWidth > 0 && v.readyState >= 1; });
            if (!ok.length) return null;
            for (var i = 0; i < ok.length; i++) { if (!ok[i].paused) return ok[i]; }
            return ok[0];
        }

        // ══════════ 切课 / 视频身份 ══════════
        // B站站内切 P 时，地址先变、<video> 还在播上一 P（或先换源后换地址）。
        // 办法：地址一变就进入"切换中"，等新视频的 loadedmetadata 到达（或 3 秒兜底）才认为新画面就绪。
        // 若 B站是"先换源、后改地址"，新视频的 loadedmetadata 会比地址变化早一点点，所以回看 0.6 秒内的也算。
        var routeKey = '', switchAt = 0, lastMetaAt = 0;
        document.addEventListener('loadedmetadata', function (e) {
            try {
                var t = e.target;
                if (!t || t.tagName !== 'VIDEO') return;
                var box = document.querySelector('.bpx-player-container');
                if (box && !box.contains(t)) return;        // 推荐位/预览小视频不算
                lastMetaAt = Date.now();
            } catch (x) {}
        }, true);
        function switchingNow() {
            if (!switchAt) return false;
            if (Date.now() - switchAt >= 3000 || lastMetaAt >= switchAt - 600) { switchAt = 0; return false; }
            return true;
        }
        function checkRoute() {
            var k = onVideoPage() ? dataKey() : '';
            if (k === routeKey) return;
            var hadPrev = routeKey !== '';
            routeKey = k;
            gesture = null;
            hideList();
            if (hadPrev && k) switchAt = Date.now(); else switchAt = 0;
            refreshCount();
        }

        // ══════════ 本地存储（localStorage）══════════
        function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
        function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
        function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

        // 读点表：区分"键不存在（0 个点）"和"读失败/数据损坏"。损坏时绝不覆盖。
        function readPoints(key) {
            var raw;
            try { raw = localStorage.getItem(key); } catch (e) { return { ok: false, why: 'unavail' }; }
            if (raw === null) return { ok: true, arr: [] };
            var arr;
            try { arr = JSON.parse(raw); } catch (e) { return { ok: false, why: 'corrupt' }; }
            if (!Array.isArray(arr)) return { ok: false, why: 'corrupt' };
            for (var i = 0; i < arr.length; i++) {
                var q = arr[i];
                if (!q || typeof q !== 'object' || typeof q.t !== 'number' || !isFinite(q.t) || q.t < 0) return { ok: false, why: 'corrupt' };
            }
            return { ok: true, arr: arr };
        }
        function writePoints(key, arr) {
            try { localStorage.setItem(key, JSON.stringify(arr)); return true; } catch (e) { console.warn('[B站打点] localStorage 写入失败', e); return false; }
        }

        // 撤销记录（墓碑）：撤销一个点后，文件里对应那一行也要去掉，但"文件里本机没有的点"要保留
        function readTomb(key) {
            try {
                var a = JSON.parse(lsGet(NS + 'tomb_' + key) || '[]');
                return Array.isArray(a) ? a.filter(function (x) { return x && typeof x.day === 'string' && typeof x.s === 'number'; }) : [];
            } catch (e) { return []; }
        }
        function writeTomb(key, a) { if (a.length) lsSet(NS + 'tomb_' + key, JSON.stringify(a)); else lsDel(NS + 'tomb_' + key); }

        // 课程标题：只缓存"像样的"标题
        function cleanTitle(t) {
            return String(t || '').replace(/\s+/g, ' ').replace(/[_\-\s]*(bilibili[_\-\s]*)?哔哩哔哩.*$/i, '').trim();
        }
        function goodTitle(t) { return !!t && t.length >= 2 && t.indexOf('哔哩哔哩') < 0; }
        // 只返回"属于 bvid 这个视频"的标题；拿不准返回空
        function liveTitle(bvid) {
            try {
                var vd = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.videoData;
                if (vd && (vd.bvid || vd.aid)) {
                    var same = /^av/i.test(bvid) ? ('av' + vd.aid) === bvid.toLowerCase() : String(vd.bvid) === bvid;
                    return same ? cleanTitle(vd.title) : '';
                }
            } catch (e) {}
            if (bvid !== getBvid() || switchingNow()) return '';
            var h = document.querySelector('h1.video-title, .video-title, [class*="mediainfo_mediaTitle"]');
            return cleanTitle((h && h.textContent) || document.title);
        }
        function titleOf(bvid) {
            var k = NS + 'title_' + bvid;
            var cached = lsGet(k), live = liveTitle(bvid);
            if (goodTitle(live)) { if (live !== cached) lsSet(k, live); return live; }
            return goodTitle(cached) ? cached : bvid;
        }
        function fileName(bvid, p) { return safeName(titleOf(bvid)) + '_P' + p + '_' + bvid + '.md'; }

        function splitDays(arr) {
            var groups = {}, unknown = [];
            arr.forEach(function (q) {
                if (validAt(q.at)) { var d = dayOf(q.at); (groups[d] = groups[d] || []).push(q); } else unknown.push(q);
            });
            return { groups: groups, unknown: unknown };
        }

        // ══════════ 文件夹存盘（File System Access API）══════════
        var FS_OK = typeof window.showDirectoryPicker === 'function' && typeof indexedDB !== 'undefined';
        var rootHandle = null;       // 用户选的文件夹
        var rootId = '';             // 文件夹编号：换了文件夹，所有课重新算"未存"
        var writeChain = Promise.resolve();   // 所有写盘排队执行
        var fileErr = {};            // key → 最近一次存盘失败的原因

        function mkErr(name, msg) { var e = new Error(msg || name); e.name = name; return e; }

        function idb() {
            return new Promise(function (res, rej) {
                var r = indexedDB.open('bn_dot_fs', 1);
                r.onupgradeneeded = function () { r.result.createObjectStore('h'); };
                r.onsuccess = function () { res(r.result); };
                r.onerror = function () { rej(r.error); };
            });
        }
        function idbGet(k) {
            return idb().then(function (db) {
                return new Promise(function (res, rej) {
                    var q = db.transaction('h', 'readonly').objectStore('h').get(k);
                    q.onsuccess = function () { res(q.result || null); };
                    q.onerror = function () { rej(q.error); };
                });
            });
        }
        function idbSet(k, v) {
            return idb().then(function (db) {
                return new Promise(function (res, rej) {
                    var tx = db.transaction('h', 'readwrite');
                    tx.objectStore('h').put(v, k);
                    tx.oncomplete = function () { res(); };
                    tx.onerror = function () { rej(tx.error); };
                });
            });
        }

        function hasPerm() {
            if (!rootHandle) return Promise.resolve(false);
            try {
                return rootHandle.queryPermission({ mode: 'readwrite' }).then(function (s) { return s === 'granted'; }, function () { return false; });
            } catch (e) { return Promise.resolve(false); }
        }
        // 选择文件夹（必须在按键/点击里调用）
        function pickFolder() {
            return window.showDirectoryPicker({ id: 'bn-dot', mode: 'readwrite', startIn: 'documents' }).then(function (h) {
                rootHandle = h;
                rootId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                return Promise.all([idbSet('root', h).catch(function () {}), idbSet('rootId', rootId).catch(function () {})]).then(function () { return h; });
            });
        }

        // 是否已存盘：记录上次"整课写成功"时的数据签名 + 文件夹编号
        function sigOf(arr) {
            var h = 5381, s = '';
            for (var i = 0; i < arr.length; i++) s += arr[i].t + '@' + (arr[i].at || 0) + ';';
            for (var c = 0; c < s.length; c++) h = ((h << 5) + h + s.charCodeAt(c)) | 0;
            return arr.length + ':' + (h >>> 0).toString(36);
        }
        function isDirty(key) {
            var r = readPoints(key);
            if (!r.ok) return false;
            if (readTomb(key).length) return true;
            if (!r.arr.length) return false;
            return lsGet(NS + 'sync8_' + key) !== sigOf(r.arr) + '|' + rootId;
        }
        function markSynced(key, arr) { lsSet(NS + 'sync8_' + key, sigOf(arr) + '|' + rootId); }

        async function findLessonFiles(dir, bvid, p) {
            var suffix = '_P' + p + '_' + bvid + '.md', found = [];
            for await (var ent of dir.entries()) {
                if (ent[1].kind === 'file' && ent[0].length >= suffix.length && ent[0].slice(-suffix.length) === suffix) found.push(ent[0]);
            }
            return found;
        }

        // 写某一天的文件：先读旧文件、只改脚本生成的行、写前再核对一次有没有被别处改动
        async function writeDay(root, bvid, p, day, pts, tombSecs) {
            if (!pts.length && !tombSecs.length) return;
            var dir;
            try { dir = await root.getDirectoryHandle(day, { create: pts.length > 0 }); }
            catch (e) { if (!pts.length && e && e.name === 'NotFoundError') return; throw e; }
            var names = await findLessonFiles(dir, bvid, p);
            if (names.length > 1) throw mkErr('AmbiguousFile', '同一天同一课有多个候选文件');
            if (!names.length && !pts.length) return;
            var name = names[0] || fileName(bvid, p);
            var fh = await dir.getFileHandle(name, { create: pts.length > 0 });
            for (var attempt = 0; attempt < 2; attempt++) {
                var file = await fh.getFile(), oldText = await file.text();
                var vm = /^视频：(\S+)/m.exec(oldText);
                if (vm && vm[1].indexOf(bvid) < 0) throw mkErr('AmbiguousFile', '同名文件属于别的视频');
                var newText = mergeFileText(oldText, { title: titleOf(bvid), bvid: bvid, p: p, day: day, pts: pts, tomb: tombSecs });
                if (newText === oldText) return;
                var f2 = await fh.getFile();
                if (f2.lastModified !== file.lastModified) continue;      // 读到写之间被别处改了，重来
                var w = await fh.createWritable();
                await w.write(newText);
                await w.close();
                return;
            }
            throw mkErr('Conflict', '文件正被其他程序改动');
        }

        // 把一节课（一个分P）全部日期的文件写好。排队执行；开工时重读最新数据。
        function syncKey(bvid, p) {
            var key = dataKey(bvid, p);
            var job = writeChain.then(async function () {
                var root = rootHandle;
                if (!root) throw mkErr('NoFolder', '未选择文件夹');
                var r = readPoints(key);
                if (!r.ok) throw mkErr('Corrupt', '点表损坏，已保护原数据');
                var sig0 = sigOf(r.arr), sp = splitDays(r.arr), tombs = readTomb(key), set = {};
                Object.keys(sp.groups).forEach(function (d) { set[d] = 1; });
                tombs.forEach(function (t) { set[t.day] = 1; });
                var days = Object.keys(set).sort();
                for (var i = 0; i < days.length; i++) {
                    var day = days[i];
                    var secs = tombs.filter(function (t) { return t.day === day; }).map(function (t) { return t.s; });
                    await writeDay(root, bvid, p, day, sp.groups[day] || [], secs);
                    var left = readTomb(key).filter(function (t) { return !(t.day === day && secs.indexOf(t.s) >= 0); });
                    writeTomb(key, left);
                }
                var r2 = readPoints(key);
                if (r2.ok && sigOf(r2.arr) === sig0 && readTomb(key).length === 0) markSynced(key, r2.arr);
                delete fileErr[key];
            });
            writeChain = job.catch(function () {});
            job.catch(function (e) { fileErr[key] = (e && e.name) || 'Error'; });
            return job;
        }
        // 静默存盘：只有"已授权"时才写，绝不弹窗（打点时用）
        function quietSync(bvid, p) {
            if (!FS_OK || !rootHandle) { refreshCount(); return; }
            hasPerm().then(function (ok) {
                if (!ok) { refreshCount(); return; }
                return syncKey(bvid, p).then(refreshCount);
            }).catch(function (e) { console.warn('[B站打点] 自动存盘失败（点已保存在浏览器里）', e); refreshCount(); });
        }
        // 所有"本机有改动还没写进文件夹"的别的课
        var LESSON_KEY = /^bn4_(BV[0-9A-Za-z]+|av[0-9]+|ep[0-9]+)_p([0-9]+)$/;
        function dirtyOthers(exceptKey) {
            var out = [];
            try {
                for (var i = 0; i < localStorage.length; i++) {
                    var k = localStorage.key(i), m = k && LESSON_KEY.exec(k);
                    if (m && k !== exceptKey && isDirty(k)) out.push({ bvid: m[1], p: m[2], key: k });
                }
            } catch (e) {}
            return out;
        }
        async function syncList(list) {
            var fail = 0;
            for (var i = 0; i < list.length; i++) {
                try { await syncKey(list[i].bvid, list[i].p); } catch (e) { fail++; }
            }
            return fail;
        }

        // 兜底：浏览器不支持写文件夹、或写失败时，普通下载到"下载"目录
        function downloadFallback(ctx, arr) {
            var text = buildMulti(titleOf(ctx.bvid), ctx.bvid, ctx.p, arr);
            var a = document.createElement('a');
            var url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
            a.href = url;
            a.download = 'bili打点_' + dayOf(Date.now()) + '_' + safeName(titleOf(ctx.bvid)) + '_P' + ctx.p + '.md';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 3000);
        }

        // ══════════ 剪贴板 ══════════
        function copyText(text) {
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
                }
            } catch (e) {}
            return Promise.resolve(legacyCopy(text));
        }
        function legacyCopy(text) {
            var prev = document.activeElement, ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (e) {}
            ta.remove();
            try { if (prev && prev.focus) prev.focus(); } catch (e) {}
            return ok;
        }

        // ══════════ 小图标 + 悬停列表 ══════════
        var root = null, icon = null, cntSpan = null, flashSpan = null, stateSpan = null;
        var listWrap = null, listBox = null, lastListSig = '', listVisible = false;
        var revertTimer = null, lastSafe = null, audioCtx = null;

        function nativeVideoFS() { var fs = document.fullscreenElement; return !!(fs && fs.tagName === 'VIDEO'); }

        function ensureIcon() {
            if (root && document.documentElement.contains(root)) return;
            var old = document.getElementById(ROOT_ID);
            if (old && old.parentNode) old.parentNode.removeChild(old);

            root = document.createElement('div');
            root.id = ROOT_ID;
            root.style.cssText = 'position:fixed;z-index:2147483000;left:0;top:0;';

            icon = document.createElement('div');
            icon.style.cssText = [
                'min-width:44px', 'height:26px', 'padding:0 8px', 'box-sizing:border-box',
                'display:flex', 'align-items:center', 'justify-content:center', 'white-space:nowrap',
                'border-radius:13px', 'background:' + COLOR_IDLE, 'color:#fff',
                'font:12px/1 "Segoe UI","Microsoft YaHei",sans-serif',
                'cursor:grab', 'user-select:none', 'touch-action:none',
                'box-shadow:0 1px 6px rgba(0,0,0,.35)', 'opacity:.6',
                'transition:opacity .15s,background .15s'
            ].join(';');
            icon.title = '打点 v' + VERSION + '\nCtrl+Shift+X / 画面中键 / 单击 = 打点\nCtrl+Shift+Z / Shift+中键 / Shift+单击 = 撤销\nCtrl+Shift+E / Ctrl+单击 = 存盘+复制\n悬停 = 看本课全部时间点，点一条跳转 · 拖动 = 换位置 · 右键 = 重选保存文件夹';
            cntSpan = document.createElement('span'); cntSpan.textContent = '● 0';
            flashSpan = document.createElement('span');
            stateSpan = document.createElement('span');
            icon.appendChild(cntSpan); icon.appendChild(flashSpan); icon.appendChild(stateSpan);
            root.appendChild(icon);

            // 悬停列表：在图标右侧；外层透明留白，鼠标从图标移进列表不会中断悬停
            listWrap = document.createElement('div');
            listWrap.style.cssText = 'position:absolute;left:100%;top:0;padding-left:4px;display:none;';
            listBox = document.createElement('div');
            listBox.style.cssText = 'width:112px;max-height:min(60vh,320px);overflow-y:auto;box-sizing:border-box;background:rgba(20,20,20,0.9);color:#fff;border-radius:8px;padding:4px 0;font:13px/1 "Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.45);';
            listWrap.appendChild(listBox);
            root.appendChild(listWrap);

            (document.body || document.documentElement).appendChild(root);
            lastSafe = loadPos();
            place(lastSafe.rx, lastSafe.ry);
            bindPointer();
            root.addEventListener('mouseenter', showList);
            root.addEventListener('mouseleave', hideList);
            icon.addEventListener('mouseenter', function () { icon.style.opacity = '0.95'; });
            icon.addEventListener('mouseleave', function () { if (!revertTimer) icon.style.opacity = '0.6'; });
            // 右键 = 重新选择保存文件夹
            icon.addEventListener('contextmenu', function (e) {
                e.preventDefault(); e.stopPropagation();
                if (!FS_OK) { showWarn('浏览器不支持'); return; }
                pickFolder().then(function () {
                    var c = lessonCtx();
                    return syncKey(c.bvid, c.p);
                }).then(function () { showOk('✓ 文件夹已设置'); refreshCount(); }, function (err) {
                    if (err && err.name === 'AbortError') return;
                    showWarn('设置失败'); console.warn('[B站打点] pick', err);
                });
            });
            refreshCount();
        }

        function loadPos() {
            try {
                var o = JSON.parse(lsGet(POS_KEY) || 'null');
                if (o && typeof o.rx === 'number' && typeof o.ry === 'number' &&
                    o.rx >= 0 && o.rx <= 1 && o.ry >= 0 && o.ry <= 1) return o;
            } catch (e) {}
            return { rx: DEFAULT_POS.rx, ry: DEFAULT_POS.ry };
        }
        // 显示位置按实际尺寸夹在窗口内（只影响显示，不改已记住的偏好位置）
        function place(rx, ry) {
            if (!root || !icon) return;
            var w = window.innerWidth, h = window.innerHeight;
            var iw = icon.offsetWidth || 46, ih = icon.offsetHeight || 26;
            root.style.left = Math.max(0, Math.min(w - iw - 2, rx * w)) + 'px';
            root.style.top = Math.max(0, Math.min(h - ih - 2, ry * h)) + 'px';
        }

        // 按下后移动 < 5px 视为单击，否则视为拖动。按下时取修饰键，放开才分派动作。
        function bindPointer() {
            var down = false, moved = false, dx = 0, dy = 0, sx = 0, sy = 0, pid = null, mods = null;
            function finish() {
                if (!down) return;
                down = false; pid = null;
                icon.style.cursor = 'grab';
                if (!moved) { dispatchIconClick(mods); return; }
                var r = root.getBoundingClientRect();
                lastSafe = { rx: r.left / window.innerWidth, ry: r.top / window.innerHeight };
                lsSet(POS_KEY, JSON.stringify(lastSafe));
            }
            icon.addEventListener('pointerdown', function (e) {
                if (!e.isPrimary || e.button !== 0) return;
                down = true; moved = false; pid = e.pointerId;
                mods = { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
                var r = root.getBoundingClientRect();
                dx = e.clientX - r.left; dy = e.clientY - r.top; sx = e.clientX; sy = e.clientY;
                icon.style.cursor = 'grabbing';
                try { icon.setPointerCapture(pid); } catch (err) {}
                e.preventDefault(); e.stopPropagation();
            });
            icon.addEventListener('pointermove', function (e) {
                if (!down || e.pointerId !== pid) return;
                if (!moved && (Math.abs(e.clientX - sx) > 5 || Math.abs(e.clientY - sy) > 5)) { moved = true; hideList(); }
                if (!moved) return;
                var w = window.innerWidth, h = window.innerHeight;
                var iw = icon.offsetWidth || 46, ih = icon.offsetHeight || 26;
                root.style.left = Math.max(0, Math.min(w - iw - 2, e.clientX - dx)) + 'px';
                root.style.top = Math.max(0, Math.min(h - ih - 2, e.clientY - dy)) + 'px';
                e.preventDefault(); e.stopPropagation();
            });
            icon.addEventListener('pointerup', function (e) {
                if (e.pointerId !== pid) return;
                try { icon.releasePointerCapture(pid); } catch (err) {}
                e.preventDefault(); e.stopPropagation();
                finish();
            });
            icon.addEventListener('pointercancel', function () { moved = true; finish(); });
            // 单击不往下传，防止触发播放器的"点击暂停"
            icon.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); });
        }
        function dispatchIconClick(m) {
            if (!m || m.alt || m.meta || (m.ctrl && m.shift)) return;   // 混合修饰键：放行不处理
            if (m.ctrl) exportAll();
            else if (m.shift) undo();
            else mark(null);
        }

        function flash(msg, color, ms) {
            if (!icon || !flashSpan) return;
            flashSpan.textContent = ' ' + msg;
            icon.style.background = color;
            icon.style.opacity = '0.95';
            clearTimeout(revertTimer);
            revertTimer = setTimeout(function () {
                revertTimer = null;
                if (!icon) return;
                flashSpan.textContent = '';
                icon.style.background = COLOR_IDLE;
                icon.style.opacity = '0.6';
                refreshCount();
            }, ms || 1500);
        }
        function showOk(msg, ms) { flash(msg, COLOR_OK, ms || 1500); beep(1); }
        function showWarn(msg, ms) { flash(msg, COLOR_WARN, ms || 2200); beep(2); }

        // 原生 <video> 全屏时页面画不出任何东西：用短提示音反馈（成功一声、失败两声）
        function beep(n) {
            try {
                if (!nativeVideoFS()) return;
                var AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return;
                if (!audioCtx) audioCtx = new AC();
                if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume();
                for (var i = 0; i < n; i++) {
                    var o = audioCtx.createOscillator(), g = audioCtx.createGain(), t0 = audioCtx.currentTime + i * 0.18;
                    o.frequency.value = n === 1 ? 880 : 440;
                    g.gain.value = 0.05;
                    o.connect(g); g.connect(audioCtx.destination);
                    o.start(t0); o.stop(t0 + 0.1);
                }
            } catch (e) {}
        }

        // 数字（本课点数）和文件状态始终各占一处，不被"已记录"提示盖掉
        function refreshCount() {
            try {
                if (!cntSpan || !onVideoPage()) return;
                var key = dataKey(), r = readPoints(key);
                if (!r.ok) {
                    cntSpan.textContent = '● ?';
                    stateSpan.textContent = r.why === 'unavail' ? ' 存储不可用' : ' 数据异常';
                    stateSpan.style.color = '#ff9b8a';
                } else {
                    cntSpan.textContent = '● ' + r.arr.length;
                    if (fileErr[key]) { stateSpan.textContent = ' 存盘失败'; stateSpan.style.color = '#ff9b8a'; }
                    else if (isDirty(key)) { stateSpan.textContent = ' 未存'; stateSpan.style.color = '#ffc66d'; }
                    else stateSpan.textContent = '';
                }
                if (listVisible) renderList(false);
            } catch (e) {}
        }

        // 悬停列表：本课全部原始点，按视频时间升序（含 2 秒内的重复点和日期未知的点）
        function renderList(force) {
            if (!listBox) return;
            var key = dataKey(), r = readPoints(key);
            var sorted = r.ok ? r.arr.map(function (q, i) { return { t: q.t, i: i }; }).sort(function (a, b) { return (a.t - b.t) || (a.i - b.i); }) : [];
            var sig = key + '|' + (r.ok ? sorted.map(function (x) { return x.t; }).join(',') : 'bad');
            if (!force && sig === lastListSig) return;
            lastListSig = sig;
            listBox.textContent = '';
            if (!r.ok || !sorted.length) {
                var empty = document.createElement('div');
                empty.textContent = r.ok ? '本课还没有点' : '数据异常';
                empty.style.cssText = 'padding:6px 10px;opacity:.7;';
                listBox.appendChild(empty);
                return;
            }
            sorted.forEach(function (x) {
                var row = document.createElement('div');
                row.textContent = fmt(x.t);
                row.title = '跳到 ' + fmt(x.t);
                row.style.cssText = 'padding:6px 12px;cursor:pointer;';
                row.addEventListener('mouseenter', function () { row.style.background = 'rgba(255,255,255,.18)'; });
                row.addEventListener('mouseleave', function () { row.style.background = ''; });
                row.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
                row.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); seekTo(key, x.t); });
                listBox.appendChild(row);
            });
        }
        function showList() {
            try {
                if (!listWrap || !onVideoPage() || dragging()) return;
                listVisible = true;
                renderList(true);
                listWrap.style.display = 'block';
                // 右侧放不下就放左边；底部放不下就上移，保证整列表在窗口内
                listWrap.style.left = '100%'; listWrap.style.right = 'auto'; listWrap.style.paddingLeft = '4px'; listWrap.style.paddingRight = '0';
                var ir = icon.getBoundingClientRect(), lw = listBox.offsetWidth + 8;
                if (ir.right + lw > window.innerWidth) {
                    listWrap.style.left = 'auto'; listWrap.style.right = '100%'; listWrap.style.paddingLeft = '0'; listWrap.style.paddingRight = '4px';
                }
                listWrap.style.top = '0px';
                var lr = listWrap.getBoundingClientRect();
                var over = lr.bottom - window.innerHeight + 4;
                if (over > 0) listWrap.style.top = (-over) + 'px';
            } catch (e) {}
        }
        function hideList() {
            listVisible = false;
            try { if (listWrap) listWrap.style.display = 'none'; } catch (e) {}
        }
        function dragging() { return !!(icon && icon.style.cursor === 'grabbing'); }

        // 点击列表条目：复核课次和主视频，再 seek；不改变播放/暂停状态
        function seekTo(key, t) {
            try {
                checkRoute();
                if (key !== dataKey()) { showWarn('课次已变，请重新悬停'); return; }
                var v = mainVideo();
                if (!v) { showWarn('未识别主视频'); return; }
                if (!isFinite(t) || t < 0) return;
                var d = v.duration;
                v.currentTime = (isFinite(d) && d > 0) ? Math.min(t, Math.max(0, d - 0.5)) : t;
                showOk('→ ' + fmt(t), 900);
            } catch (e) { showWarn('跳转失败'); console.warn('[B站打点] seek', e); }
        }

        // ══════════ 三个动作 ══════════
        var pendingMarks = [];       // 切课途中按下的打点，等新画面就绪后再记

        function mark(snap) {
            try {
                if (!onVideoPage()) { showWarn('非视频页'); return; }
                checkRoute();
                var ctx = lessonCtx(), at = snap ? snap.at : Date.now();
                var v = mainVideo();
                if (!v && !(snap && snap.t !== null)) {
                    if (switchAt) { queueMark(ctx, at); return; }
                    showWarn('未识别主视频'); return;
                }
                if (switchingNow() || (snap && snap.t === null)) { queueMark(ctx, at); return; }
                var t = (snap && snap.t !== null) ? snap.t : v.currentTime;
                if (!isFinite(t)) { showWarn('无视频'); return; }
                doMark(ctx, { t: t, at: at });
            } catch (e) { showWarn('打点失败'); console.warn('[B站打点] mark', e); }
        }
        function doMark(ctx, pt) {
            var r = readPoints(ctx.key);
            if (!r.ok) { showWarn('数据异常·未记录'); refreshCount(); return; }
            titleOf(ctx.bvid);                                     // 首次打点时记下课程标题
            var arr = r.arr;                                       // 不设数量上限，2 秒内的点也照记
            arr.push({ t: Math.round(pt.t * 10) / 10, at: pt.at });
            if (!writePoints(ctx.key, arr)) { showWarn('本地保存失败'); return; }
            refreshCount();                                        // 数字立即更新
            showOk('✓ 已记录 ' + fmt(pt.t));
            quietSync(ctx.bvid, ctx.p);                            // 已授权就写进当天文件夹；未授权什么也不弹
        }
        function queueMark(ctx, at) {
            var item = { ctx: ctx, at: at, t0: Date.now(), timer: null };
            pendingMarks.push(item);
            flash('正在切换 P' + ctx.p, COLOR_INFO, 1500);
            (function poll() {
                item.timer = setTimeout(function () {
                    try {
                        var idx = pendingMarks.indexOf(item);
                        if (idx < 0) return;                       // 已被撤销取消
                        checkRoute();
                        if (dataKey() !== item.ctx.key) { pendingMarks.splice(idx, 1); showWarn('未记录，请在新画面重试'); return; }
                        var v = mainVideo();
                        if (v && !switchingNow() && isFinite(v.currentTime)) {
                            pendingMarks.splice(idx, 1);
                            doMark(item.ctx, { t: v.currentTime, at: item.at });   // 日期取按下那一刻
                            return;
                        }
                        if (Date.now() - item.t0 >= 1500) { pendingMarks.splice(idx, 1); showWarn('未记录，请重试'); return; }
                        poll();
                    } catch (e) { console.warn('[B站打点] pending', e); }
                }, 100);
            })();
        }

        function undo() {
            try {
                if (!onVideoPage()) return;
                checkRoute();
                var ctx = lessonCtx();
                for (var i = pendingMarks.length - 1; i >= 0; i--) {           // 先取消还在等待的最后一个
                    if (pendingMarks[i].ctx.key === ctx.key) {
                        clearTimeout(pendingMarks[i].timer); pendingMarks.splice(i, 1);
                        showOk('✓ 已取消待记'); return;
                    }
                }
                var r = readPoints(ctx.key);
                if (!r.ok) { showWarn('数据异常·未撤销'); return; }
                if (!r.arr.length) { showWarn('无可撤销'); return; }
                var gone = r.arr.pop();                                        // 撤销"最后录入"的一个
                if (!writePoints(ctx.key, r.arr)) { showWarn('撤销失败'); return; }
                if (validAt(gone.at)) {                                        // 记下：文件里这一行也要去掉
                    var tb = readTomb(ctx.key);
                    tb.push({ day: dayOf(gone.at), s: Math.floor(gone.t) });
                    writeTomb(ctx.key, tb);
                }
                refreshCount();
                showOk('✓ 已撤销 ' + fmt(gone.t));
                quietSync(ctx.bvid, ctx.p);
            } catch (e) { showWarn('撤销失败'); console.warn('[B站打点] undo', e); }
        }

        // Ctrl+Shift+E：先复制，再存盘。第一次会弹"选择文件夹"；之后若权限过期会弹一次"允许编辑"。
        // 目录授权和复制必须在按键/点击的同一个手势里同步发起，所以这里不能先 await 别的。
        function exportAll() {
            try {
                if (!onVideoPage()) return;
                checkRoute();
                var ctx = lessonCtx(), r = readPoints(ctx.key);
                if (!r.ok) { showWarn('数据异常·无法导出'); return; }
                var others = dirtyOthers(ctx.key);
                if (!r.arr.length && !readTomb(ctx.key).length && !others.length) { showWarn('还没打点'); return; }
                var n = r.arr.length, unknown = splitDays(r.arr).unknown.length;
                var text = n ? buildMulti(titleOf(ctx.bvid), ctx.bvid, ctx.p, r.arr) : null;
                var copied = text !== null ? copyText(text) : Promise.resolve(null);   // 同步发起，保证在手势内
                function tail(c, fail, extra) {
                    var s = (extra || '✓ 已存盘') + (c ? '+复制' : '') + (n ? ' ' + n : '');
                    if (fail) s += ' · 另' + fail + '课待存';
                    if (unknown) s += ' · ' + unknown + '点日期未知';
                    return s;
                }

                if (!FS_OK) {
                    if (n) { downloadFallback(ctx, r.arr); }
                    copied.then(function (c) { showOk(n ? (c ? '已发起下载+复制，到Edge下载中查看' : '已发起下载，到Edge下载中查看') : '浏览器不支持写文件夹', 3500); });
                    return;
                }
                var ready = rootHandle
                    ? rootHandle.requestPermission({ mode: 'readwrite' }).then(function (s) {
                        if (s !== 'granted') throw mkErr('NotAllowedError');
                    })
                    : pickFolder();
                ready.then(function () { return syncKey(ctx.bvid, ctx.p); })
                    .then(function () { return syncList(others); })
                    .then(function (fail) {
                        return copied.then(function (c) {
                            if (c === false && text !== null) c = legacyCopy(text);     // 选择器抢走焦点导致复制失败时再试一次
                            refreshCount();
                            showOk(tail(c, fail), fail ? 3500 : 2500);
                        });
                    })
                    .catch(function (err) {
                        var nm = err && err.name;
                        refreshCount();
                        if (nm === 'AbortError') { showWarn('未选文件夹' + (n ? '·已复制' : ''), 2500); return; }
                        if (nm === 'NotAllowedError') { showWarn('未授权' + (n ? '·已复制' : '') + '，请再按一次', 2500); return; }
                        if (nm === 'AmbiguousFile') { showWarn('文件归属不明，已保留原件', 3500); console.warn('[B站打点]', err); return; }
                        if (nm === 'Conflict') { showWarn('文件正被改动，请稍后再按', 3500); return; }
                        if (nm === 'Corrupt') { showWarn('数据异常，已保护原数据', 3500); return; }
                        var notFound = nm === 'NotFoundError';
                        if (notFound) rootHandle = null;                               // 文件夹被删/移走：下次导出时重选
                        console.warn('[B站打点] 存盘失败，改为下载' + (notFound ? '（路径过长或文件夹被移动，请重选或换浅目录）' : ''), err);
                        try {
                            if (n) downloadFallback(ctx, r.arr);
                            showWarn(notFound ? '路径过长或文件夹被移动：请重选/换浅目录；已发起下载' : '存盘失败：已发起下载，到Edge下载中查看', 4500);
                        } catch (e2) { showWarn('存盘失败' + (n ? '·已复制' : '')); }
                    });
            } catch (e) { showWarn('导出失败'); console.warn('[B站打点] export', e); }
        }

        // ══════════ 键盘 ══════════
        var TEXT_INPUT_TYPES = /^(text|search|email|url|tel|password|number)$/i;
        function isTextEntry(n) {
            if (!n || n.nodeType !== 1) return false;
            if (n.isContentEditable) return true;
            if (n.tagName === 'TEXTAREA' || n.tagName === 'SELECT') return true;
            return n.tagName === 'INPUT' && TEXT_INPUT_TYPES.test(n.type || 'text');
        }
        function inEditable(e) {
            var path = (e.composedPath && e.composedPath()) || [];
            for (var i = 0; i < path.length; i++) { if (isTextEntry(path[i])) return true; }
            return isTextEntry(document.activeElement);
        }
        function comboOf(e) {
            if (e.metaKey || e.altKey) return '';
            if (!(e.ctrlKey && e.shiftKey)) return '';
            var code = e.code, key = (e.key || '').toLowerCase();
            if (code === 'KeyX' || key === 'x') return 'mark';
            if (code === 'KeyZ' || key === 'z') return 'undo';
            if (code === 'KeyE' || key === 'e') return 'export';
            return '';
        }

        // ── iframe 里：只把按键转发给顶层，自己什么都不做 ──
        if (window.top !== window) {
            window.addEventListener('keydown', function (e) {
                try {
                    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
                    var act = comboOf(e);
                    if (!act || inEditable(e)) return;
                    e.preventDefault(); e.stopPropagation();
                    if (e.repeat) return;
                    window.top.postMessage({ bnDot: 6, act: act, id: Date.now() + '-' + Math.random() }, '*');
                } catch (err) {}
            }, true);
            return;
        }

        // ── 顶层：执行动作 ──
        var ACTS = { mark: function () { mark(null); }, undo: undo, export: exportAll };
        var seenIds = [], lastKeyAt = 0, watchTimer = null, claimed = (typeof WeakSet === 'function') ? new WeakSet() : null;

        function run(act) {
            clearTimeout(watchTimer); watchTimer = null;
            ACTS[act]();
        }
        // 收到按键后 120ms 内没执行到 → 提示
        function armWatch() {
            clearTimeout(watchTimer);
            watchTimer = setTimeout(function () { watchTimer = null; keyMiss('收到按键但未执行'); }, 120);
        }
        function keyMiss(why) {
            console.warn('[B站打点] 键没生效：' + why);
            flash('⚠ 键没生效', COLOR_WARN, 2000);
        }

        function onKey(e) {
            try {
                if (e.defaultPrevented) return;
                if (e.isComposing || e.keyCode === 229) return;                    // 输入法合成中不触发
                var act = comboOf(e);
                if (!act) return;
                if (inEditable(e)) {
                    if (!e.repeat) showWarn('⚠ 在输入框内，已忽略');
                    return;
                }
                if (claimed) { if (claimed.has(e)) return; claimed.add(e); }       // 同一个事件只认领一次
                e.preventDefault(); e.stopPropagation();
                lastKeyAt = Date.now();
                if (e.repeat) return;                                               // 长按只拦截不重复执行
                armWatch();
                run(act);
            } catch (err) { console.warn('[B站打点] key', err); }
        }
        function onKeyUp(e) {
            try {
                var act = comboOf(e);
                if (!act || inEditable(e)) return;
                e.preventDefault();
                if (Date.now() - lastKeyAt > 1500) keyMiss('只收到松开键');          // 按下被别的扩展/浏览器吃掉了
            } catch (err) {}
        }
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('keyup', onKeyUp, true);

        // iframe 转发来的按键：只认本页面里的子框架、只认 bilibili 域名、同一消息只处理一次
        function fromChildFrame(src) {
            for (var w = src, i = 0; w && i < 10; i++) {
                if (w === window) return src !== window;
                if (w === w.parent) return false;
                w = w.parent;
            }
            return false;
        }
        window.addEventListener('message', function (e) {
            try {
                var d = e.data;
                if (!d || d.bnDot !== 6 || !ACTS[d.act] || typeof d.id !== 'string') return;
                if (!/^https:\/\/([a-z0-9-]+\.)*bilibili\.com$/i.test(e.origin) || !fromChildFrame(e.source)) return;
                if (seenIds.indexOf(d.id) >= 0) return;
                seenIds.push(d.id); if (seenIds.length > 20) seenIds.shift();
                lastKeyAt = Date.now();
                run(d.act);
            } catch (err) {}
        });

        // ══════════ 画面中键 ══════════
        // 只在"视频画面空白处"接管：进度条、控制栏、弹幕开关、链接、输入框等一律放行，保留网页原行为。
        var PROTECTED = 'a,button,[role="button"],input,textarea,select,label,summary,video[controls],' +
            '[contenteditable]:not([contenteditable="false"]),[role="slider"],[role="menu"],[role="menuitem"],' +
            '.bpx-player-control-bottom,.bpx-player-control-top,.bpx-player-progress-wrap,.bpx-player-progress,' +
            '.bpx-player-ctrl-btn,.bpx-player-ctrl-volume,.bpx-player-dm-switch,.bpx-player-sending-area,' +
            '.bpx-player-ctrl-full,.bpx-player-ctrl-web,.bpx-player-ctrl-quality,.bpx-player-ctrl-setting,' +
            '.bpx-player-ctrl-quality-menu,.bpx-player-contextmenu,#' + ROOT_ID;
        var PICTURE = '.bpx-player-video-area,.bpx-player-video-wrap,.bpx-player-dm-wrap,.bpx-player-subtitle-wrap,.bpx-player-state-wrap';
        var gesture = null;

        function pathMatches(e, sel) {
            var path = (e.composedPath && e.composedPath()) || [];
            for (var i = 0; i < path.length; i++) {
                var n = path[i];
                if (n && n.nodeType === 1) { try { if (n.matches(sel)) return true; } catch (x) {} }
            }
            return false;
        }
        function pictureHit(e) {
            var box = document.querySelector('.bpx-player-container'), v = mainVideo(), rect = null;
            if (box) rect = box.getBoundingClientRect(); else if (v) rect = v.getBoundingClientRect();
            if (!rect) return false;
            if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return false;
            if (pathMatches(e, PROTECTED)) return false;
            var tg = e.target;
            return !!(tg && tg.tagName === 'VIDEO') || pathMatches(e, PICTURE);
        }
        function onMouseDown(e) {
            try {
                if (e.button !== 1 || !e.isTrusted) return;
                if (e.ctrlKey || e.altKey || e.metaKey) return;
                if (!onVideoPage() || !pictureHit(e)) return;
                e.preventDefault();                                   // 阻止 Edge 的中键自动滚动
                checkRoute();
                var ctx = lessonCtx(), v = mainVideo();
                var ready = !!v && !switchingNow() && isFinite(v.currentTime);
                gesture = { x: e.clientX, y: e.clientY, moved: 0, cancel: false, shift: e.shiftKey, at: Date.now(),
                            t0: performance.now(), key: ctx.key, t: ready ? v.currentTime : null };   // 按下那一刻的秒数
            } catch (err) { gesture = null; }
        }
        function onMouseMove(e) {
            try {
                if (!gesture) return;
                if (!(e.buttons & 4)) { gesture = null; return; }        // 中键已经松开（在窗口外松的）
                var d = Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y);
                if (d > gesture.moved) gesture.moved = d;
                if (gesture.moved >= 5) gesture.cancel = true;           // 移动超过 5px 算拖动，即使移回起点
            } catch (err) { gesture = null; }
        }
        function onWheel(e) {
            try { if (gesture) { e.preventDefault(); gesture.cancel = true; } } catch (err) {}
        }
        function onMouseUp(e) {
            try {
                if (e.button !== 1 || !gesture) return;
                var g = gesture; gesture = null;
                var d = Math.hypot(e.clientX - g.x, e.clientY - g.y);
                if (g.cancel || g.moved >= 5 || d >= 5) return;
                if (performance.now() - g.t0 >= 600) return;             // 按太久不算点击
                checkRoute();
                if (dataKey() !== g.key) return;                         // 按下到松开之间换了课
                e.preventDefault();
                if (g.shift) undo(); else mark({ t: g.t, at: g.at });
            } catch (err) { console.warn('[B站打点] mouseup', err); }
        }
        document.addEventListener('mousedown', onMouseDown, true);
        document.addEventListener('mousemove', onMouseMove, true);
        document.addEventListener('mouseup', onMouseUp, true);
        document.addEventListener('wheel', onWheel, { capture: true, passive: false });
        window.addEventListener('blur', function () { gesture = null; });
        document.addEventListener('visibilitychange', function () { gesture = null; });

        // ══════════ 全屏 / 切换视频 / 窗口变化 ══════════
        // B站全屏是把播放器容器全屏，body 里的元素会被盖住 → 把图标搬进全屏元素
        function syncVisibility() {
            if (!root) return;
            var fs = document.fullscreenElement;
            var visible = onVideoPage() && !nativeVideoFS();      // <video> 自身全屏时无法显示任何插入元素
            root.style.display = visible ? 'block' : 'none';
            if (!visible) return;
            var host = (fs && fs.tagName !== 'IFRAME') ? fs : (document.body || document.documentElement);
            if (root.parentNode !== host) {
                try { host.appendChild(root); } catch (e) { return; }
                if (lastSafe) place(lastSafe.rx, lastSafe.ry);
            }
        }
        document.addEventListener('fullscreenchange', function () {
            try { gesture = null; hideList(); syncVisibility(); if (lastSafe) place(lastSafe.rx, lastSafe.ry); } catch (e) {}
        });
        window.addEventListener('resize', function () { try { if (lastSafe) place(lastSafe.rx, lastSafe.ry); } catch (e) {} });
        window.addEventListener('popstate', function () { try { checkRoute(); } catch (e) {} });
        window.addEventListener('hashchange', function () { try { checkRoute(); } catch (e) {} });
        try {
            if (window.navigation && window.navigation.addEventListener) {
                window.navigation.addEventListener('currententrychange', function () { try { checkRoute(); } catch (e) {} });
            }
        } catch (e) {}

        function tick() {
            try {
                ensureIcon();
                checkRoute();
                syncVisibility();
                if (!revertTimer) refreshCount();
            } catch (e) {}
        }

        // ══════════ 启动 ══════════
        function boot() {
            try {
                ensureIcon();
                checkRoute();
                syncVisibility();
                setInterval(tick, 1500);
                if (FS_OK) {
                    Promise.all([idbGet('root'), idbGet('rootId')]).then(function (a) {
                        if (a[0] && typeof a[0].getDirectoryHandle === 'function') { rootHandle = a[0]; rootId = a[1] || 'r0'; }
                        refreshCount();
                        return hasPerm();
                    }).then(function (ok) {
                        if (!ok || !onVideoPage()) return;
                        // 重开浏览器后若权限还在：把本机有改动没写进文件夹的课补写一遍
                        var c = lessonCtx(), list = dirtyOthers(c.key);
                        if (isDirty(c.key)) list.unshift({ bvid: c.bvid, p: c.p, key: c.key });
                        return syncList(list).then(refreshCount);
                    }).catch(function (e) { console.warn('[B站打点] 启动读回文件夹失败', e); refreshCount(); });
                }
            } catch (e) { console.warn('[B站打点] boot', e); }
        }
        if (document.body) boot();
        else document.addEventListener('DOMContentLoaded', boot);
    }
})();
