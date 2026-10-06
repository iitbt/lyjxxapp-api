# 旧库与 D1 的逐表行数对比, 只依赖 Python 标准库
# 用法一(只统计旧库): python verify_counts.py fastapi/data/lyjx.db
# 用法二(顺便查 D1): 先设 CLOUDFLARE_ACCOUNT_ID / D1_DATABASE_ID / CLOUDFLARE_API_TOKEN 再跑
import json
import os
import sqlite3
import sys
import urllib.request

# 不参与对外 API 的表: 管理后台专用 + 旧库自愈台账 + 遗留表(代码已无引用)
SKIP_TABLES = ('admin_users', 'schema_migrations', 'app_api_routes')


def sqlite_counts(path):
    conn = sqlite3.connect(path)
    rows = conn.execute(
        "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name"
    ).fetchall()
    counts = {}
    for (name,) in rows:
        if name in SKIP_TABLES:
            continue
        counts[name] = conn.execute(f'select count(*) from "{name}"').fetchone()[0]
    conn.close()
    return counts


def d1_query(account_id, database_id, token, sql):
    url = f'https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query'
    body = json.dumps({'sql': sql}).encode('utf-8')
    request = urllib.request.Request(url, data=body, method='POST')
    request.add_header('Authorization', f'Bearer {token}')
    request.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode('utf-8'))
    if not payload.get('success'):
        raise RuntimeError(json.dumps(payload.get('errors'), ensure_ascii=False))
    return payload['result'][0]['results']


def main():
    old_db = sys.argv[1] if len(sys.argv) > 1 else 'fastapi/data/lyjx.db'
    counts = sqlite_counts(old_db)
    print(json.dumps(counts, ensure_ascii=False, indent=2))

    account_id = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')
    database_id = os.environ.get('D1_DATABASE_ID', '')
    token = os.environ.get('CLOUDFLARE_API_TOKEN', '')
    if not (account_id and database_id and token):
        print('未配置 D1 凭据, 仅输出旧库行数; 对比时请在 D1 控制台执行:')
        for table in counts:
            print(f'  select count(*) from {table};')
        return 0

    bad = 0
    for table, expected in counts.items():
        rows = d1_query(account_id, database_id, token, f'select count(*) as c from {table}')
        actual = rows[0]['c'] if rows else None
        flag = 'OK  ' if actual == expected else 'DIFF'
        if actual != expected:
            bad += 1
        print(f'{flag} {table:<24} 旧库 {expected:>7}  D1 {actual}')
    print(f'===== 差异表数 {bad} =====')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
