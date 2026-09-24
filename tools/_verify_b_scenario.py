import requests, sys

URL = "https://musicfinder-292238-8-1463776169.sh.run.tcloudbase.com/api/search"
PAY = {"song_name": "拜托", "performer": "麦手", "limit": 30}
N = int(sys.argv[1]) if len(sys.argv) > 1 else 12

def parse(r):
    items = (r.get("grouped_results") or []) + (r.get("filtered_irrelevant") or [])
    qq_entries, baituo = [], None
    for it in items:
        pd = it.get("platform_data") or {}
        qq = pd.get("qq")
        if isinstance(qq, dict):
            qq_entries.append(qq)
            if it.get("song_name") == "拜托" and it.get("performer") == "麦手":
                baituo = qq
    dosearch = sum(1 for q in qq_entries if q.get("_from_dosearch"))
    return qq_entries, baituo, len(qq_entries), dosearch

ok = 0
fails = []
for n in range(1, N + 1):
    try:
        r = requests.post(URL, json=PAY, timeout=60).json()
    except Exception as e:
        print(f"run {n}: ❌ 异常 {e}")
        fails.append(n)
        continue
    qq_entries, baituo, total_qq, dosearch = parse(r)
    ndirty = [q for q in qq_entries if not (q.get("song_name") and (q.get("_songmid") or q.get("mid")))]
    if baituo and not ndirty:
        ok += 1
        print(f"run {n}: ✅ 麦手命中 | from_dosearch={baituo.get('_from_dosearch')} avail={baituo.get('availability')} | QQ={total_qq}(dosearch={dosearch}) None脏={len(ndirty)}")
    else:
        why = "麦手未命中" if not baituo else f"{len(ndirty)}脏结果"
        print(f"run {n}: ⚠️ {why} | QQ={total_qq}(dosearch={dosearch})")
        fails.append(n)

print(f"\n汇总: {ok}/{N} 次稳定命中 | 失败runs={fails}")
sys.exit(0 if ok == N else 1)
