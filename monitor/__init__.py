"""MusicFinder 平台表现日监控模块

子模块：
    db          SQLite 数据层（monitor.db 建表 / 连接 / 通用读写）
    matcher     Excel 导入 + 三平台精准匹配建档
    daily       每日指标抓取（收藏 / 在听 / 评论）
    chart       三平台榜单抓取与上榜对撞
    derivative  衍生版本（翻唱/改编）每周扫描
    report      日/周/月/季/年多维度聚合报告
    routes      Flask 蓝图（数据监控 / 运营报告 页签接口）
"""

__all__ = ['db', 'daily', 'chart', 'report']
