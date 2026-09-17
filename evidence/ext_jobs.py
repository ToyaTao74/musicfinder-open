#!/usr/bin/env python3
"""浏览器扩展辅助抓取的任务队列（v4.30.34）

设计：Windows 设备装 MusicFinder 扩展后，扩展后台轮询云端领任务，在用户
真实浏览器里打开抖音搜索页（真实指纹 + 家庭 IP + 滑块真人过），拦截签名
接口的响应原文回传云端，云端复用 douyin._parse_aweme_bodies 解析入库。

队列是进程内存态（单实例部署，够用）：
  _jobs[task_id] = {bodies:[str], worker, assigned_at, last_seen, done, error, event}
  _workers[worker] = last_seen  （心跳，90s 内算在线）

无扩展在线 / 领单后超时 / 扩展报错 → 引擎回退到服务端 Xvfb 抓取，互为兜底。
"""

import json
import threading
import time
from datetime import datetime

# 扩展心跳有效期（秒）
WORKER_TTL = 90
# 领单后等待回传的超时（秒），超时回退服务端抓取
EXT_TIMEOUT = 300

_lock = threading.Lock()
_jobs = {}      # task_id -> dict
_workers = {}   # worker_name -> last_seen ts


def _now():
    return time.time()


def worker_online():
    """是否有扩展在线（90 秒内有过心跳/领单）。"""
    with _lock:
        cut = _now() - WORKER_TTL
        return any(ts > cut for ts in _workers.values())


def touch_worker(worker):
    with _lock:
        _workers[worker] = _now()


def assign(task_id, song_name, artist, target_count):
    """引擎派单：登记任务等待扩展来取。"""
    info = {
        'task_id': task_id,
        'song_name': song_name,
        'artist': artist or '',
        'target_count': int(target_count or 300),
        'search_url': 'https://www.douyin.com/search/' + _q(f'{song_name} {artist}'.strip()),
    }
    with _lock:
        _jobs[task_id] = {
            'bodies': [], 'worker': '',
            'assigned_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'delivered': False,
            'done': False, 'error': '', 'event': threading.Event(),
            **{k: info[k] for k in ('song_name', 'artist', 'target_count', 'search_url')},
        }
    return info


def pick(worker):
    """扩展轮询取件：返回最早一个未投递的任务；取走后标记 delivered。"""
    with _lock:
        cut = _now() - WORKER_TTL
        _workers[worker] = _now()
        for tid, j in _jobs.items():
            if not j['delivered'] and not j['done']:
                j['delivered'] = True
                j['worker'] = worker
                return {
                    'task_id': tid,
                    'song_name': j['song_name'],
                    'artist': j['artist'],
                    'target_count': j['target_count'],
                    'search_url': j['search_url'],
                    'worker': worker,
                }
    return None


def _q(s):
    import urllib.parse
    return urllib.parse.quote(s)


def report(task_id, bodies=None, done=False, error=''):
    """扩展回传： bodies 增量追加响应原文；done/error 置终态并唤醒等待线程。"""
    with _lock:
        j = _jobs.get(task_id)
        if not j:
            return False
        if bodies:
            for b in bodies:
                # 总量护栏 50MB，防异常扩展撑爆内存
                if sum(len(x) for x in j['bodies']) < 50 * 1024 * 1024:
                    j['bodies'].append(b)
        if error:
            j['error'] = str(error)[:300]
            j['done'] = True
            j['event'].set()
        elif done:
            j['done'] = True
            j['event'].set()
        else:
            j['last_seen'] = _now()
    return True


def wait_result(task_id, timeout=EXT_TIMEOUT):
    """引擎线程等待扩展回传。返回 ('ok', bodies) / ('error', msg) / ('timeout', '')。"""
    j = _jobs.get(task_id)
    if not j:
        return ('error', '任务未派给扩展')
    if not j['event'].wait(timeout):
        return ('timeout', '')
    if j['error']:
        return ('error', j['error'])
    if not j['bodies']:
        return ('error', '扩展未回传任何接口数据')
    return ('ok', list(j['bodies']))


def release(task_id):
    """任务结束（无论成败）清理队列占位。"""
    with _lock:
        j = _jobs.pop(task_id, None)
        if j:
            j['done'] = True
            j['event'].set()


def status():
    with _lock:
        cut = _now() - WORKER_TTL
        return {
            'workers_online': [w for w, ts in _workers.items() if ts > cut],
            'pending_tasks': [
                {'task_id': tid, 'worker': j['worker'], 'bodies': len(j['bodies']),
                 'done': j['done'], 'assigned_at': j['assigned_at']}
                for tid, j in _jobs.items()
            ],
        }
