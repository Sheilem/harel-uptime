"""Uptime watchdog for the Harel servers, run by GitHub Actions every 5 minutes.

Independent of the VPS and of Vercel on purpose: if either goes down, this still runs.
Alerts go to the Telegram group "הראל - התראות", topic "מערכת ושרתים".
State (who is down since when, what was already alerted) lives in the ERP's
app_settings row `uptime_state`, so the ERP can show it too.

Everything sensitive comes from repository secrets:
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_TOPIC_ID, SUPABASE_URL, SUPABASE_ANON_KEY,
  TARGETS  JSON list: [{"id","name","group","kind":"http"|"tcp","url"|"host"+"port"}]
  GROUPS   JSON map: {"vps": {"title": "...", "buttons": [["text","url"], ...]}, ...}
"""
import json
import os
import socket
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    IL = ZoneInfo('Asia/Jerusalem')
except Exception:  # no tz database (plain Windows Python): Israel summer time is close enough for a local test
    IL = timezone(timedelta(hours=3))
FAILS_BEFORE_ALERT = 2          # two failed checks in a row (about 10 minutes) before alerting
REMIND_EVERY_MIN = 180          # while still down, remind every 3 hours
RLM = '‏'

TOKEN = os.environ['TELEGRAM_BOT_TOKEN']
CHAT = int(os.environ['TELEGRAM_CHAT_ID'])
TOPIC = int(os.environ['TELEGRAM_TOPIC_ID'])
SB_URL = os.environ['SUPABASE_URL'].rstrip('/')
SB_KEY = os.environ['SUPABASE_ANON_KEY']
TARGETS = json.loads(os.environ['TARGETS'])
GROUPS = json.loads(os.environ.get('GROUPS') or '{}')
DRY = os.environ.get('DRY') == '1'


def now_utc():
    return datetime.now(timezone.utc)


def fmt_time(iso):
    return datetime.fromisoformat(iso).astimezone(IL).strftime('%d.%m %H:%M')


def fmt_duration(minutes):
    minutes = int(minutes)
    if minutes < 60:
        return f'{minutes} דק\''
    h, m = divmod(minutes, 60)
    if h < 24:
        return f'{h}:{m:02d} שעות'
    d, h = divmod(h, 24)
    return f'{d} ימים ו-{h} שעות'


def check(t):
    """True if the target answers. HTTP: any status below 500 except Cloudflare's 530 counts as up."""
    try:
        if t['kind'] == 'tcp':
            with socket.create_connection((t['host'], int(t['port'])), timeout=8):
                return True, 'port open'
        req = urllib.request.Request(t['url'], headers={'User-Agent': 'harel-uptime/1.0'})
        try:
            code = urllib.request.urlopen(req, timeout=15).status
        except urllib.error.HTTPError as e:
            code = e.code
        return (code < 500), f'HTTP {code}'
    except Exception as e:  # timeouts, refused, DNS
        return False, type(e).__name__


def sb(method, path, body=None, prefer=None):
    headers = {'apikey': SB_KEY, 'Authorization': f'Bearer {SB_KEY}', 'Content-Type': 'application/json'}
    if prefer:
        headers['Prefer'] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f'{SB_URL}/rest/v1/{path}', data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=15) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def load_state():
    rows = sb('GET', 'app_settings?key=eq.uptime_state&select=value')
    if not rows:
        return None
    v = rows[0]['value']
    return json.loads(v) if isinstance(v, str) else v


def save_state(state, existed):
    body = {'key': 'uptime_state', 'value': state}
    if DRY:
        return
    if existed:
        sb('PATCH', 'app_settings?key=eq.uptime_state', body, prefer='return=minimal')
    else:
        sb('POST', 'app_settings', body, prefer='return=minimal')


def telegram(text, buttons=None, silent=False):
    lines = '\n'.join((RLM + l) if l.strip() else l for l in text.split('\n'))
    payload = {'chat_id': CHAT, 'message_thread_id': TOPIC, 'text': lines, 'parse_mode': 'HTML',
               'disable_notification': silent, 'link_preview_options': {'is_disabled': True}}
    if buttons:
        payload['reply_markup'] = {'inline_keyboard': [[{'text': b[0], 'url': b[1]}] for b in buttons]}
    if DRY:
        print('--- would send ---\n' + lines)
        return
    req = urllib.request.Request(f'https://api.telegram.org/bot{TOKEN}/sendMessage',
                                 data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
                                 headers={'Content-Type': 'application/json; charset=utf-8'})
    urllib.request.urlopen(req, timeout=15).read()


def main():
    t0 = now_utc()
    state = load_state()
    existed = state is not None
    state = state or {}
    targets_state = state.setdefault('targets', {})
    groups_state = state.setdefault('groups', {})

    results = {}
    for t in TARGETS:
        ok, detail = check(t)
        results[t['id']] = ok
        s = targets_state.setdefault(t['id'], {'fails': 0, 'down_since': None})
        s['name'], s['group'], s['detail'], s['checked_at'] = t['name'], t['group'], detail, t0.isoformat()
        if ok:
            s['fails'], s['down_since'] = 0, None
        else:
            s['fails'] += 1
            s['down_since'] = s['down_since'] or t0.isoformat()
        print(f"{t['id']:<14} {'UP  ' if ok else 'DOWN'} {detail}")

    for gid, g in GROUPS.items():
        members = [t for t in TARGETS if t['group'] == gid]
        down = [t for t in members if targets_state[t['id']]['fails'] >= FAILS_BEFORE_ALERT]
        gs = groups_state.setdefault(gid, {'alerted_at': None, 'last_remind': None, 'since': None})
        title = g.get('title', gid)
        buttons = g.get('buttons')
        if down:
            since = min(targets_state[t['id']]['down_since'] for t in down)
            minutes = (t0 - datetime.fromisoformat(since)).total_seconds() / 60
            names = ' · '.join(t['name'] for t in down)
            if not gs['alerted_at']:
                telegram(f'<b>לא עונה · {title}</b>\nמאז {fmt_time(since)} ({fmt_duration(minutes)}).\n{names}', buttons)
                gs.update(alerted_at=t0.isoformat(), last_remind=t0.isoformat(), since=since)
            elif (t0 - datetime.fromisoformat(gs['last_remind'])).total_seconds() / 60 >= REMIND_EVERY_MIN:
                telegram(f'<b>עדיין לא עונה · {title}</b>\nלמטה {fmt_duration(minutes)}, מאז {fmt_time(since)}.\n{names}', buttons)
                gs['last_remind'] = t0.isoformat()
        elif gs.get('alerted_at'):
            minutes = (t0 - datetime.fromisoformat(gs['since'])).total_seconds() / 60
            telegram(f'<b>חזר לפעול · {title}</b>\nהיה למטה {fmt_duration(minutes)} (מ-{fmt_time(gs["since"])}).', silent=True)
            gs.update(alerted_at=None, last_remind=None, since=None)

    state['last_run'] = t0.isoformat()
    save_state(state, existed)
    return 0


if __name__ == '__main__':
    sys.exit(main())
