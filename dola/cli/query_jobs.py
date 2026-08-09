import sqlite3
con = sqlite3.connect(r"E:\projectHome\media-cli\dola\cli\.dola\jobs.sqlite3")
cur = con.cursor()
cur.execute("SELECT job_id, request_id, state, account_id, substr(COALESCE(error,''),1,70), created_at, worker_id FROM jobs WHERE created_at > '2026-08-04T12:00' ORDER BY created_at DESC LIMIT 8")
for r in cur.fetchall():
    print(r)
con.close()
