#!/usr/bin/env python3
"""渲染 download.html 模板为最终静态页面（CI 与本地共用）。

环境变量：
  VERSION / UPDATED           版本号与更新时间文本
  WIN_SIZE / MAC_SIZE         文件字节数（'0' 表示未知，占位符会被清掉）
  BASE_URL                    可选。下载按钮的基地址（如 COS 域名）；
                              为空时按钮用相对路径（页面与文件同域部署时）；
                              页面与文件不同域时（如 GitHub Pages）必须传 COS 域名。
输出：写 OUT 指定的文件；未传 OUT 时打印到 stdout。
"""
import os
import re

here = os.path.dirname(os.path.abspath(__file__))
html = open(os.path.join(here, '..', 'download.html'), encoding='utf-8').read()


def mb(v):
    return f'{int(v) / 1048576:.1f} MB' if v != '0' else ''


html = (html.replace('__VERSION__', os.environ.get('VERSION', ''))
            .replace('__UPDATED__', os.environ.get('UPDATED', ''))
            .replace('__WIN_SIZE__', mb(os.environ.get('WIN_SIZE', '0')))
            .replace('__MAC_SIZE__', mb(os.environ.get('MAC_SIZE', '0'))))
html = re.sub(r'·\s*·', '·', html)        # 大小缺失时清理多余分隔点
html = re.sub(r'__[A-Z_]+__', '', html)   # 兜底：未替换的占位符清空

# 页面与安装包不同域时（GitHub Pages 托管页面、COS 放文件），按钮改绝对链接
base = os.environ.get('BASE_URL', '').rstrip('/')
if base:
    html = html.replace('href="MusicFinder-latest-Windows-Setup.exe"',
                        f'href="{base}/MusicFinder-latest-Windows-Setup.exe"')
    html = html.replace('href="MusicFinder-latest-Mac.zip"',
                        f'href="{base}/MusicFinder-latest-Mac.zip"')

out = os.environ.get('OUT')
if out:
    open(out, 'w', encoding='utf-8').write(html)
    print(f'渲染完成 -> {out}')
else:
    print(html)
