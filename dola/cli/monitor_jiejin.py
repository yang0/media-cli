import sqlite3, time, sys, datetime

DB = r"E:\projectHome\media-cli\dola\cli\.dola\jobs.sqlite3"
WATCH = {f"jiejin-v2-shot{n:02d}-001" for n in list(range(1,5))+list(range(6,19))}
WATCH.add("jiejin-v2-shot05-003")
TERMINAL = {"succeeded", "failed", "needs_review", "cancelled"}

def snap():
    con = sqlite3.connect(DB, timeout=10)
    cur = con.cursor()
    cur.execute("SELECT request_id, state, account_id, output_file, substr(COALESCE(error,''),1,60) FROM jobs WHERE request_id IN (%s)" % ",".join("?"*len(WATCH)))
    rows = {r[0]: r for r in cur.fetchall()}
    con.close()
    return rows

last = {}
start = time.time()
while True:
    try:
        rows = snap()
        done = {k for k,v in rows.items() if v[1] in TERMINAL}
        ok = {k for k,v in rows.items() if v[1] == "succeeded"}
        live = {k for k,v in rows.items() if v[1] not in TERMINAL}
        ts = datetime.datetime.now().strftime("%H:%M:%S")
        line = f"[{ts}] done={len(done)}/18 succeeded={len(ok)} live={sorted(live)}"
        if line != last.get("line"):
            print(line, flush=True)
            last["line"] = line
        for k in sorted(ok - last.get("ok", set())):
            v = rows[k]
            print(f"  OK {k} account={v[2]} file={v[3]}", flush=True)
        for k in sorted(done - last.get("done", set()) - ok):
            v = rows[k]
            print(f"  FAIL {k} account={v[2]} err={v[4][:60]}", flush=True)
        last["done"] = done
        last["ok"] = ok
        if len(done) >= len(WATCH):
            print(f"ALL DONE in {int((time.time()-start)/60)}min  succeeded={len(ok)} failed={len(WATCH)-len(ok)}", flush=True)
            sys.exit(0)
    except Exception as e:
        print("monitor err:", e, flush=True)
    time.sleep(60)
