# Checkpoint.sg sheet append (no Mac)

Google Apps Script that reads the Cloudflare Worker and appends one hourly row to the Checkpoint.sg tab.

One-time setup in the script editor:

1. Open https://script.google.com/d/1Im6t2YefTVdxtkdxVnugJkpmBXy_72b5KcOyfdJ1xcy-IssTUBU2vDNS/edit
2. Project Settings → Script properties → add `MONITOR_API_KEY`
3. Run `setMonitorKey` only if you prefer the function over the property UI
4. Run `installHourlyTrigger`, then run `hourlyAppend` once to authorize and backfill

After that, Google’s hourly trigger keeps the tab current while the laptop is off.
