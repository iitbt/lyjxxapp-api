# 把旧 SQLite 库导出为 D1 可执行的 INSERT 脚本, 只依赖 Python 标准库
# 用法: python export_sqlite.py fastapi/data/lyjx.db out/seed.sql
# 之后: wrangler d1 execute <DB_NAME> --file=out/seed.sql --remote
# 控制台手工导入(整份 84KB 一次粘不下): 再用 split_sql.py 拆块
#   python split_sql.py out/seed out/seed.sql
import os
import sqlite3
import sys

# 与 verify_counts.py 保持一致: 管理后台表 + 自愈台账 + 遗留表
SKIP_TABLES = ('admin_users', 'schema_migrations', 'app_api_routes')


def literal(value):
    # None → NULL; bytes → 十六进制字面量; 其余按类型原样, 字符串里的单引号加倍
    if value is None:
        return 'NULL'
    if isinstance(value, bytes):
        return "X'" + value.hex() + "'"
    if isinstance(value, bool):
        return '1' if value else '0'
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value).replace("'", "''")
    # 换行不转义: SQLite/D1 的字符串字面量允许真实换行, 转了反而会把数据写成字面的 \n 两个字符
    return "'" + text + "'"


def dump(db_path, out_path):
    conn = sqlite3.connect(db_path)
    conn.text_factory = str
    tables = [row[0] for row in conn.execute(
        "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name"
    )]
    lines = [
        '-- 由 export_sqlite.py 从旧 SQLite 库导出, 配合 schema/0001_schema.sql 使用',
        '-- 用 INSERT OR REPLACE: 同一份脚本可以反复执行(切换前重跑一次补新数据也不会撞主键)',
    ]
    total = 0
    for table in tables:
        if table in SKIP_TABLES:
            lines.append(f'-- 跳过 {table}')
            continue
        cursor = conn.execute(f'select * from "{table}"')
        columns = [item[0] for item in cursor.description]
        column_sql = ', '.join(f'"{name}"' for name in columns)
        count = 0
        for row in cursor:
            values = ', '.join(literal(value) for value in row)
            lines.append(f'INSERT OR REPLACE INTO "{table}" ({column_sql}) VALUES ({values});')
            count += 1
        total += count
        lines.append(f'-- {table}: {count} 行')
    conn.close()
    # 输出目录可能还不存在(如 out/), 先建出来, 否则直接写文件会报错
    parent = os.path.dirname(os.path.abspath(out_path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(out_path, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write('\n'.join(lines) + '\n')
    print(f'已导出 {total} 行 → {out_path}')


if __name__ == '__main__':
    source = sys.argv[1] if len(sys.argv) > 1 else 'fastapi/data/lyjx.db'
    target = sys.argv[2] if len(sys.argv) > 2 else 'app/api-cf/out/seed.sql'
    dump(source, target)
