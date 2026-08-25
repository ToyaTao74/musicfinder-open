"""MusicFinder 音乐证据监测模块（侵权取证）

独立子包 evidence/，绝不往 app.py 堆业务。
给定一份"授权曲库"，去 网易云 / 汽水音乐 / 抖音 搜"谁在没授权用了这些歌"，
按阈值筛出合格证据，存 SQLite，供人工复核盗版/授权版，可导出 Excel。

子模块：
    db          SQLite 数据层（evidence.db 建表 / 连接 / 通用读写）
    importer    授权曲库 Excel 导入
    detect      官方证据阈值判定
    classify    盗版默认待复核 + 授权艺人提示
    platforms   各平台抓取器（netease / qishui / douyin）
    routes      Flask 蓝图（/api/evidence/*）
"""

__all__ = ['db']
