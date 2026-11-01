import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Scheduler } from '../app.mjs';
import { normalize, nextTime, localInstant, timeText } from '../schedule.mjs';
const input = { title: 'Review', targetId: 'a', message: 'Review {{scheduled_date}}', timezone: 'Asia/Shanghai', cadence: 'daily', time: '09:00', missed: 'skip', graceMinutes: 30 };
const at = v => Date.parse(v);
test('daily, weekdays, weekly and anchored interval calculate actual local time', () => {
    const now = at('2026-10-30T02:00:00Z');
    assert.equal(timeText(nextTime(normalize(input, now), now), input.timezone), '2026-10-31 09:00');
    assert.equal(timeText(nextTime(normalize({ ...input, cadence: 'weekdays' }, now), now), input.timezone), '2026-11-02 09:00');
    assert.equal(timeText(nextTime(normalize({ ...input, cadence: 'weekly', weekday: 1 }, now), now), input.timezone), '2026-11-02 09:00');
    const s = normalize({ ...input, cadence: 'interval', intervalMinutes: 5 }, now);
    assert.equal(nextTime(s, now + 12 * 60000), now + 15 * 60000);
});
test('DST missing local time is skipped, repeated hour executes only once', () => {
    const s = { ...input, timezone: 'America/New_York', time: '02:30', cadence: 'weekly', weekday: 0 };
    const now = at('2026-03-02T15:00:00Z');
    assert.equal(timeText(nextTime(s, now), s.timezone), '2026-03-15 02:30');
    assert.throws(() => localInstant('2026-03-08 02:30', s.timezone), /不存在/);
    const first = localInstant('2026-11-01 01:30', s.timezone);
    assert.equal(first, at('2026-11-01T05:30:00Z'));
    assert.equal(timeText(nextTime({ ...s, cadence: 'daily', time: '01:30' }, first), s.timezone), '2026-11-02 01:30');
});
test('invalid schedule and unsupported variables reject before approval', () => {
    const now = at('2026-11-01T00:00:00Z');
    for (const patch of [{ time: '25:00' }, { timezone: 'Fake/Zone' }, { message: '{{unknown}}' }, { graceMinutes: 0 }, { cadence: 'interval', intervalMinutes: 1 }, { cadence: 'once', onceAt: '2026-02-30 09:00' }, { until: '2026-11-01 09:00' }])
        assert.throws(() => normalize({ ...input, ...patch }, now));
});
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-scheduler-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let now = at('2026-11-01T00:59:00Z'), available = true;
    const calls = [], receipts = new Map(), revoked = [];
    const services = { host: { snapshot: () => ({ sessions: available ? [{ instanceId: 'a', title: 'Review', kind: 'agent' }] : [] }) }, messages: { submit(v) { calls.push(v); const r = { id: v.key, state: 'queued' }; receipts.set(v.key, r); return r; }, lookup: key => receipts.get(key), status: id => receipts.get(id), revoke: id => revoked.push(id) } };
    const file = path.join(dir, 'tasks.json'), s = new Scheduler(services, { file, now: () => now });
    const create = (patch = {}) => { const p = s.prepare('save', { ...input, ...patch }); assert(p.authorization); assert.equal(s.state.jobs.length, 0); p.execute('approved'); return s.state.jobs[0]; };
    return { s, create, calls, receipts, revoked, services, file, time: v => now = v, available: v => available = v, now: () => now };
}
test('prepare is inert, approved schedule submits once, active run blocks overlapping rounds', t => {
    const f = fixture(t), j = f.create();
    f.time(at('2026-11-01T01:00:00Z'));
    f.s.tick();
    f.s.tick();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].values.scheduled_date, '2026-11-01');
    f.time(at('2026-11-02T01:00:00Z'));
    f.s.tick();
    assert.equal(f.calls.length, 1);
    assert.equal(j.runs[0].state, 'skipped');
    f.receipts.get(f.calls[0].key).state = 'completed';
    f.time(at('2026-11-03T01:00:00Z'));
    f.s.tick();
    assert.equal(f.calls.length, 2);
});
test('restart catchup is opt-in, bounded, and at most one missed round', t => {
    const f = fixture(t), j = f.create({ missed: 'catchup' });
    f.time(at('2026-11-01T01:10:00Z'));
    f.s.tick(true);
    assert.equal(f.calls.length, 1);
    assert.equal(j.nextAt, at('2026-11-02T01:00:00Z'));
    const loaded = new Scheduler(f.services, { file: f.file, now: f.now });
    loaded.tick(true);
    assert.equal(f.calls.length, 1);
    f.time(at('2026-11-03T12:00:00Z'));
    f.receipts.get(f.calls[0].key).state = 'completed';
    loaded.tick(true);
    assert.equal(f.calls.length, 1);
    assert.equal(loaded.state.jobs[0].runs[0].state, 'missed');
});
test('skip policy never auto-catches a restart and missing target pauses task', t => {
    const f = fixture(t), j = f.create();
    f.time(at('2026-11-01T01:01:00Z'));
    f.s.tick(true);
    assert.equal(f.calls.length, 0);
    assert.equal(j.runs[0].state, 'missed');
    f.available(false);
    f.time(at('2026-11-02T01:00:00Z'));
    f.s.tick();
    assert.equal(j.enabled, false);
    assert.equal(f.calls.length, 0);
});
test('pause cancels grants; stale confirmation cannot recreate or mutate a task', t => {
    const f = fixture(t), j = f.create();
    const old = { id: j.id, revision: j.revision };
    const stale = f.s.prepare('save', { ...input, ...old, title: 'Changed' });
    f.s.prepare('pause', old).execute();
    assert.equal(j.enabled, false);
    assert.deepEqual(f.revoked, ['approved']);
    assert.throws(() => stale.execute('new'), /变化/);
    assert.equal(f.s.state.jobs[0].config.title, 'Review');
});
test('expired confirmation cannot revoke a still-valid previous schedule', t => {
    const f = fixture(t), j = f.create();
    const p = f.s.prepare('save', { ...input, id: j.id, revision: j.revision });
    f.time(at('2026-11-01T01:01:00Z'));
    assert.throws(() => p.execute('new'), /过去/);
    assert.deepEqual(f.revoked, []);
});
test('manual run is separately approved, leaves schedule intact and rejects overlap', t => {
    const f = fixture(t), j = f.create(), next = j.nextAt;
    const p = f.s.prepare('run', { id: j.id, revision: j.revision });
    assert.equal(p.authorization.maxRuns, 1);
    assert.equal(f.calls.length, 0);
    p.execute('manual');
    assert.equal(f.calls.length, 1);
    assert.equal(j.nextAt, next);
    assert.throws(() => f.s.prepare('run', { id: j.id, revision: j.revision }), /等待或执行中/);
});
test('catchup close to the next slot skips the rate-limited slot without disabling the schedule', t => {
    const f = fixture(t), j = f.create({ missed: 'catchup', graceMinutes: 1440 });
    f.time(at('2026-11-02T00:59:50Z'));
    f.s.tick(true);
    assert.equal(f.calls.length, 1);
    f.receipts.get(f.calls[0].key).state = 'completed';
    f.time(at('2026-11-02T01:00:00Z'));
    f.s.tick();
    assert.equal(f.calls.length, 1);
    assert.equal(j.enabled, true);
    assert.equal(j.runs[0].state, 'throttled');
});
test('crash between durable intent and receipt recording reconciles by stable delivery key', t => {
    const f = fixture(t), j = f.create();
    const key = 'recover';
    j.runs = [{ key, at: f.now(), targetId: 'a', grantId: j.grantId, state: 'submitting' }];
    f.s.save();
    f.receipts.set(key, { id: key, state: 'running' });
    const loaded = new Scheduler(f.services, { file: f.file, now: f.now });
    loaded.tick(true);
    assert.equal(loaded.state.jobs[0].runs[0].receiptId, key);
    assert.equal(loaded.state.jobs[0].runs[0].state, 'running');
    assert.equal(f.calls.length, 0);
});

test('multi-day recovery catches only the latest eligible daily slot', t => {
    const f = fixture(t), j = f.create({ missed: 'catchup' });
    f.time(at('2026-11-03T01:10:00Z'));
    f.s.tick(true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].values.scheduled_date, '2026-11-03');
    assert.equal(j.nextAt, at('2026-11-04T01:00:00Z'));
    f.s.tick(true);
    assert.equal(f.calls.length, 1);
});
test('interval recovery uses the latest anchored slot rather than the oldest overdue slot', t => {
    const f = fixture(t), j = f.create({ missed: 'catchup', cadence: 'interval', intervalMinutes: 5, graceMinutes: 2 });
    f.time(at('2026-11-03T01:10:00Z'));
    f.s.tick(true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].values.scheduled_time, '2026-11-03 09:09');
    assert.equal(j.nextAt, at('2026-11-03T01:14:00Z'));
});

test('catchup across the repeated DST hour keeps the original single occurrence', t => {
    const f = fixture(t), j = f.create({ missed: 'catchup', timezone: 'America/New_York', time: '01:30', graceMinutes: 90 });
    f.time(at('2026-11-01T06:40:00Z'));
    f.s.tick(true);
    assert.equal(f.calls.length, 1);
    assert.equal(j.runs[0].at, at('2026-11-01T05:30:00Z'));
    assert.equal(j.nextAt, at('2026-11-02T06:30:00Z'));
    f.time(at('2026-11-01T06:50:00Z'));
    f.s.tick();
    assert.equal(f.calls.length, 1);
});
