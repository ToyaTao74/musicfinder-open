#!/usr/bin/env python3
"""Check if Kugou web player shows 在听."""
from playwright.sync_api import sync_playwright
import re

url = 'https://www.kugou.com/mixsong/1rk90da.html?fromsearch=%E6%99%B4%E5%A4%A9#hash=B3A52A7A958BF0AED0EBFBA2E9A818B7&album_id=966846&album_audio_id=32100650'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel='chrome')
    context = browser.new_context(user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
    page = context.new_page()
    page.goto(url, wait_until='domcontentloaded', timeout=30000)
    page.wait_for_timeout(5000)
    html = page.content()
    browser.close()

# Search for 在听 or related text
for pat in [r'在听', r'正在听', r'人在听', r'一起听', r'听这首歌', r'OwnerCount']:
    if re.search(pat, html):
        print('found', pat)
        m = re.search(pat + r'[^<]{0,30}', html)
        if m:
            print('context:', m.group(0))
print('done')
