import sqlite3
import json
import os
import shutil

src_db = r"C:\ProgramData\Cloudflare\warp.db"
copy_db = os.path.join(os.path.dirname(__file__), "warp_copy.db")

# Copy first
shutil.copy2(src_db, copy_db)
print(f"Copied to: {copy_db}")

conn = sqlite3.connect(copy_db)
c = conn.cursor()

c.execute("SELECT name, sql FROM sqlite_master WHERE type='table'")
tables = c.fetchall()
print("=== Tables ===")
for name, sql in tables:
    print(f"\nTable: {name}")
    print(f"Schema: {sql}")
    c.execute(f"PRAGMA table_info('{name}')")
    cols = c.fetchall()
    print(f"Columns: {[col[1] for col in cols]}")
    c.execute(f"SELECT * FROM '{name}' LIMIT 10")
    rows = c.fetchall()
    for row in rows:
        display_row = []
        for val in row:
            if isinstance(val, str) and len(val) > 200:
                display_row.append(val[:200] + "...[truncated]")
            elif isinstance(val, bytes) and len(val) > 200:
                display_row.append(str(val[:200]) + "...[truncated]")
            else:
                display_row.append(val)
        print(f"  Row: {display_row}")

all_tables = [t[0] for t in tables]
print(f"\n=== All table names: {all_tables}")

for table_name in all_tables:
    c.execute(f"PRAGMA table_info('{table_name}')")
    cols = c.fetchall()
    col_names = [col[1] for col in cols]
    for col_name in col_names:
        if any(kw in col_name.lower() for kw in ['key', 'private', 'secret', 'token', 'wire', 'config', 'reg']):
            print(f"\n*** Found interesting column: {table_name}.{col_name} ***")
            c.execute(f"SELECT {col_name} FROM '{table_name}' LIMIT 5")
            for row in c.fetchall():
                val = row[0]
                if isinstance(val, str) and len(val) > 300:
                    print(f"  {col_name}: {val[:300]}...[truncated, len={len(val)}]")
                else:
                    print(f"  {col_name}: {val}")

conn.close()
print("\n=== Done ===")
