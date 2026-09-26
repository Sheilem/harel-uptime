/**
 * Harel uptime watchdog on Cloudflare Workers (cron every 5 minutes).
 * Same logic and state as ../check.py (which stays as a manual GitHub Actions fallback):
 * - two failed checks in a row -> one alert in the Telegram topic "מערכת ושרתים"
 * - still down -> reminder every 3 hours, back up -> a silent message with the downtime
 * - state lives in the ERP (app_settings.uptime_state), so the ERP watches this watcher too
 * - every 15 minutes it also runs the ERP alerts engine (/api/cron/alerts), and at 09:00 Israel time the morning digest
 * Secrets: TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID TELEGRAM_TOPIC_ID SUPABASE_URL SUPABASE_ANON_KEY
 *          TARGETS GROUPS CRON_SECRET ERP_URL
 */
import { connect } from 'cloudflare:sockets';

const FAILS_BEFORE_ALERT = 2;
const REMIND_EVERY_MIN = 180;
const RLM = '‏';

const fmtTime = iso => new Date(iso).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '');
function fmtDuration(min) {
  min = Math.round(min);
  if (min < 60) return `${min} דק'`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return `${h}:${String(m).padStart(2, '0')} שעות`;
  return `${Math.floor(h / 24)} ימים ו-${h % 24} שעות`;
}

async function check(t) {
  try {
    if (t.kind === 'tcp') {
      const socket = connect({ hostname: t.host, port: Number(t.port) });
      await Promise.race([socket.opened, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
      await socket.close();
      return [true, 'port open'];
    }
    const res = await fetch(t.url, { headers: { 'User-Agent': 'harel-uptime/1.0' }, signal: AbortSignal.timeout(15000), redirect: 'manual' });
    return [res.status < 500, `HTTP ${res.status}`];
  } catch (e) {
    return [false, e?.name === 'TimeoutError' || e?.message === 'timeout' ? 'TimeoutError' : String(e?.message || e).slice(0, 60)];
  }
}

function sbHeaders(env, extra = {}) {
  return { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', ...extra };
}

async function loadState(env) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/app_settings?key=eq.uptime_state&select=value`, { headers: sbHeaders(env) });
  const rows = await r.json();
  if (!rows.length) return null;
  const v = rows[0].value;
  return typeof v === 'string' ? JSON.parse(v) : v;
}

async function saveState(env, state, existed) {
  const body = JSON.stringify({ key: 'uptime_state', value: state });
  const url = existed ? `${env.SUPABASE_URL}/rest/v1/app_settings?key=eq.uptime_state` : `${env.SUPABASE_URL}/rest/v1/app_settings`;
  await fetch(url, { method: existed ? 'PATCH' : 'POST', headers: sbHeaders(env, { Prefer: 'return=minimal' }), body });
}

async function telegram(env, text, buttons, silent = false, dry = false) {
  const lines = text.split('\n').map(l => (l.trim() ? RLM + l : l)).join('\n');
  if (dry) return lines;
  const payload = {
    chat_id: Number(env.TELEGRAM_CHAT_ID), message_thread_id: Number(env.TELEGRAM_TOPIC_ID), text: lines, parse_mode: 'HTML',
    disable_notification: silent, link_preview_options: { is_disabled: true },
    ...(buttons ? { reply_markup: { inline_keyboard: buttons.map(b => [{ text: b[0], url: b[1] }]) } } : {}),
  };
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload) });
  return lines;
}

async function runUptime(env, nowMs, dry) {
  const targets = JSON.parse(env.TARGETS);
  const groups = JSON.parse(env.GROUPS || '{}');
  const t0 = new Date(nowMs);
  const nowIso = t0.toISOString();
  let state = await loadState(env);
  const existed = state !== null;
  state = state || {};
  const ts = (state.targets ||= {});
  const gsAll = (state.groups ||= {});
  const log = [];

  const results = await Promise.all(targets.map(t => check(t)));
  targets.forEach((t, i) => {
    const [ok, detail] = results[i];
    const s = (ts[t.id] ||= { fails: 0, down_since: null });
    Object.assign(s, { name: t.name, group: t.group, detail, checked_at: nowIso });
    if (ok) { s.fails = 0; s.down_since = null; } else { s.fails += 1; s.down_since = s.down_since || nowIso; }
    log.push(`${t.id} ${ok ? 'UP' : 'DOWN'} ${detail}`);
  });

  for (const [gid, g] of Object.entries(groups)) {
    const members = targets.filter(t => t.group === gid);
    const down = members.filter(t => ts[t.id].fails >= FAILS_BEFORE_ALERT);
    const gs = (gsAll[gid] ||= { alerted_at: null, last_remind: null, since: null });
    const title = g.title || gid;
    if (down.length) {
      const since = down.map(t => ts[t.id].down_since).sort()[0];
      const minutes = (t0 - new Date(since)) / 60000;
      const names = down.map(t => t.name).join(' · ');
      if (!gs.alerted_at) {
        log.push(await telegram(env, `<b>לא עונה · ${title}</b>\nמאז ${fmtTime(since)} (${fmtDuration(minutes)}).\n${names}`, g.buttons, false, dry));
        Object.assign(gs, { alerted_at: nowIso, last_remind: nowIso, since });
      } else if ((t0 - new Date(gs.last_remind)) / 60000 >= REMIND_EVERY_MIN) {
        log.push(await telegram(env, `<b>עדיין לא עונה · ${title}</b>\nלמטה ${fmtDuration(minutes)}, מאז ${fmtTime(since)}.\n${names}`, g.buttons, false, dry));
        gs.last_remind = nowIso;
      }
    } else if (gs.alerted_at) {
      const minutes = (t0 - new Date(gs.since)) / 60000;
      log.push(await telegram(env, `<b>חזר לפעול · ${title}</b>\nהיה למטה ${fmtDuration(minutes)} (מ-${fmtTime(gs.since)}).`, null, true, dry));
      Object.assign(gs, { alerted_at: null, last_remind: null, since: null });
    }
  }
  state.last_run = nowIso;
  state.runner = 'cloudflare-worker';
  if (!dry) await saveState(env, state, existed);
  return log;
}

async function runAlertsEngine(env, digest = false) {
  const res = await fetch(`${env.ERP_URL}/api/cron/alerts${digest ? '?digest=1' : ''}`, { headers: { Authorization: `Bearer ${env.CRON_SECRET}` }, signal: AbortSignal.timeout(90000) });
  return `alerts engine${digest ? ' + morning digest' : ''} HTTP ${res.status}`;
}

// The morning message goes out at 09:00 Israel time (Gal, 26.09.2026). Computed in Asia/Jerusalem,
// so summer and winter time need no change. The ERP dedupes the digest per day.
const DIGEST_HOUR = 9;
function israelClock(ts) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ts));
  const get = t => Number(parts.find(p => p.type === t)?.value);
  return { hour: get('hour'), minute: get('minute') };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await runUptime(env, event.scheduledTime, false);
      const minute = new Date(event.scheduledTime).getUTCMinutes();
      const il = israelClock(event.scheduledTime);
      if (il.hour === DIGEST_HOUR && il.minute < 5) await runAlertsEngine(env, true); // 09:00 Israel
      else if (minute % 15 === 5) await runAlertsEngine(env); // :05 :20 :35 :50
    })());
  },
  // manual run: https://<worker>/?key=<CRON_SECRET>&dry=1
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.CRON_SECRET || url.searchParams.get('key') !== env.CRON_SECRET) return new Response('Not found', { status: 404 });
    const dry = url.searchParams.get('dry') === '1';
    const log = await runUptime(env, Date.now(), dry);
    if (url.searchParams.get('alerts') === '1') log.push(await runAlertsEngine(env));
    return new Response(JSON.stringify({ dry, log }, null, 1), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  },
};
