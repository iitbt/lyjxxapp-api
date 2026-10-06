# 把大 SQL 拆成 D1 控制台能一次粘完的小块, 只依赖 Python 标准库
# 用法: python split_sql.py <输出目录> <SQL 文件...> [--max-bytes 6000]
#   python split_sql.py out/schema schema/0001_schema.sql schema/0002_rate_limit.sql schema/0003_wechat_token.sql
#   python split_sql.py out/seed out/seed.sql
# 为什么: D1 的导入只有 wrangler 命令与控制台 Console 粘贴两条路(官方无"上传 SQL 文件"入口),
# 而建表 11KB / 数据 84KB 一次性粘贴会被截断, 所以先拆块再逐块粘
# 产物: 输出目录下 两位序号_原文件名.sql, 按文件名排序就是执行顺序; 只在语句边界切, 不会切碎单条语句
import os
import re
import sqlite3
import sys

# 只清理符合本脚本命名规则的旧产物, 避免误删同目录的 seed.sql 等真实文件
_SPLIT_NAME = re.compile(r'^\d{2}_[A-Za-z0-9_]+(\.part\d+)?\.sql$')
DEFAULT_MAX_BYTES = 6000
_TABLE_PATTERNS = (
    re.compile(r'INSERT(?: OR REPLACE)? INTO "([^"]+)"'),
    re.compile(r'CREATE TABLE "([^"]+)"'),
)


def split_statements(text):
    """按完整语句切分: 交给 sqlite3.complete_statement 判定, 引号里的分号不会被误切。"""
    statements = []
    buffer = []
    for line in text.splitlines():
        buffer.append(line)
        if sqlite3.complete_statement('\n'.join(buffer)):
            statement = '\n'.join(buffer).strip()
            if statement:
                statements.append(statement)
            buffer = []
    tail = '\n'.join(buffer).strip()
    if tail:
        statements.append(tail)
    return statements


def pack(statements, max_bytes):
    """按顺序把语句装进若干个块, 每块不超过 max_bytes(单条语句自身超限时独占一块)。"""
    blocks = []
    current = []
    size = 0
    for statement in statements:
        extra = len(statement) + 1
        if current and size + extra > max_bytes:
            blocks.append(current)
            current = []
            size = 0
        current.append(statement)
        size += extra
    if current:
        blocks.append(current)
    return blocks


def summarize(block):
    """块头注释用: 本块涉及哪些表、含几条建表语句。"""
    tables = []
    for statement in block:
        for pattern in _TABLE_PATTERNS:
            for name in pattern.findall(statement):
                if name not in tables:
                    tables.append(name)
    creates = sum(1 for item in block if re.match(r'\s*CREATE ', item, re.I))
    return tables, creates


def clear_output(out_dir):
    """只删符合本脚本命名规则的旧产物, 防止换了块大小后旧的块还混在目录里。"""
    try:
        names = os.listdir(out_dir)
    except OSError:
        return
    for name in names:
        if _SPLIT_NAME.match(name):
            try:
                os.remove(os.path.join(out_dir, name))
            except OSError:
                pass


def main(paths, out_dir, max_bytes):
    os.makedirs(out_dir, exist_ok=True)
    clear_output(out_dir)
    blocks = []
    for path in paths:
        with open(path, encoding='utf-8') as handle:
            statements = split_statements(handle.read())
        stem = os.path.splitext(os.path.basename(path))[0]
        for block in pack(statements, max_bytes):
            blocks.append((stem, block))
    if not blocks:
        print('没有可拆分的语句')
        return
    for index, (stem, block) in enumerate(blocks, start=1):
        tables, creates = summarize(block)
        head = [f'-- 第 {index} 块(共 {len(blocks)} 块) | 来自 {stem}.sql | 本块 {len(block)} 条语句'
                + (f' | 建表 {creates} 条' if creates else '')]
        if tables:
            head.append('-- 涉及: ' + ', '.join(tables))
        head.append('-- 粘进 D1 控制台 Console 执行: 数据块可重复执行, 建表块只在第一次执行')
        path = os.path.join(out_dir, f'{index:02d}_{stem}.sql')
        with open(path, 'w', encoding='utf-8', newline='\n') as handle:
            handle.write('\n'.join(head + block) + '\n')
        print(f'{os.path.basename(path)}: {len(block)} 条语句, {os.path.getsize(path)} 字节')
    print(f'共 {len(blocks)} 块 → {out_dir}')


if __name__ == '__main__':
    args = sys.argv[1:]
    max_bytes = DEFAULT_MAX_BYTES
    if '--max-bytes' in args:
        position = args.index('--max-bytes')
        max_bytes = int(args[position + 1])
        del args[position:position + 2]
    if len(args) < 2:
        print('用法: python split_sql.py <输出目录> <SQL 文件...> [--max-bytes 6000]')
        sys.exit(1)
    main(args[1:], args[0], max_bytes)
