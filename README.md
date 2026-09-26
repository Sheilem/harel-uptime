# harel-uptime

בדיקת זמינות לשרתים של הראל, רצה ב-GitHub Actions כל 5 דקות, בלי תלות ב-VPS או ב-Vercel.

- נפילה (שתי בדיקות כושלות ברצף) = הודעה בקבוצת הטלגרם "הראל - התראות", נושא "מערכת ושרתים".
- כל עוד לא חזר: תזכורת כל 3 שעות. חזר = הודעה שקטה עם משך הנפילה.
- המצב נשמר ב-ERP (`app_settings`, מפתח `uptime_state`).
- כל הכתובות, המזהים והמפתחות נמצאים ב-Secrets של הריפו בלבד.
- `keepalive` עושה commit קטן פעם בחודש, כי GitHub מכבה תזמון בריפו בלי פעילות 60 יום.

הרצה ידנית: Actions → uptime → Run workflow (אפשר dry).

## Cloudflare Worker (הרץ הראשי מ-26.09.2026)

`worker/` = אותה לוגיקה על Cloudflare Workers עם cron כל 5 דקות, כי התזמון של GitHub לא התחיל לרוץ
בזמן. ה-workflows של GitHub מושבתים ונשארו לגיבוי ידני בלבד.

```
cd worker
npx wrangler deploy                 # CLOUDFLARE_API_TOKEN במשתני הסביבה של המשתמש
npx wrangler secret bulk secrets.json
```

בדיקה ידנית: `https://harel-uptime.sheilem.workers.dev/?key=<CRON_SECRET>&dry=1`
