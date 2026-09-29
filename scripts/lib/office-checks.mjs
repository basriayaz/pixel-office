// Checks that run the real Office class (web/office.js in a vm with stub canvases): changing the layout while people walk, sit,
// meet and celebrate must never leave anybody on furniture, off the map, at a spot that is gone, or without a way to their desk.
import assert from "node:assert/strict";
import { randomEdit } from "./layout-checks.mjs";

function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const J = (v) => JSON.parse(JSON.stringify(v));

export function runOffice(h, P, seeds = 12) {
  const mk = (n, status = "idle") => Array.from({ length: n }, (_, i) => ({ id: "e" + i, name: "Emp " + i, role: "dev", color: "#61afef", status }));
  let clock = 1e6;
  const frames = (o, n) => { for (let i = 0; i < n; i++) { clock += 50; o.update(0.05, clock); } };
  const fresh = (n, doc = null) => {
    const o = h.makeOffice();
    o.setTheme("default");
    o.setLayoutDoc(doc);
    o.setEmployees(mk(n));
    return o;
  };
  // idle people wander off now and then: give them time to be seen sitting
  const sits = (o, e, max = 1500) => { for (let i = 0; i < max; i++) { if (o.atSeat(e)) return true; frames(o, 1); } return false; };
  const doc = (o, edit) => P.toDoc(edit(J(o.scene.items)));
  // a way from where they are to their chair over free floor (other people come and go, so they do not count)
  const walk = (o, from, goal, self) => {
    const shut = new Set([...o.blocked, ...o.freeSeats, ...o.emps.filter((x) => x !== self).map((x) => x.seat.tx + "," + x.seat.ty)]);
    const seen = new Set([from.join(",")]), q = [from];
    for (let i = 0; i < q.length; i++) {
      const [x, y] = q[i];
      if (x + "," + y === goal) return true;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, k = nx + "," + ny;
        if (nx < 0 || ny < 0 || nx >= P.COLS || ny >= P.ROWS || seen.has(k) || (shut.has(k) && k !== goal)) continue;
        seen.add(k); q.push([nx, ny]);
      }
    }
    return false;
  };
  const walkable = (o, e) => walk(o, [e.tx, e.ty], e.seat.tx + "," + e.seat.ty, e);
  // everybody is somewhere valid, and can still walk to their desk
  const sound = (o, label) => {
    const R = o.scene.build.reach;
    for (const e of o.emps) {
      assert.ok(e.tx >= 0 && e.ty >= 0 && e.tx < P.COLS && e.ty < P.ROWS, `${label}: ${e.id} on the map`);
      const k = e.tx + "," + e.ty;
      const onSpot = e.spot && e.spot.tx === e.tx && e.spot.ty === e.ty;
      assert.ok(!o.blocked.has(k) || onSpot || e.path.length, `${label}: ${e.id} is on furniture at ${k}`); // (stepping off the sofa is fine)
      if (e.spot && !e.spot.evt) assert.ok(o.spots.includes(e.spot) || o.meetingSpots.includes(e.spot), `${label}: ${e.id} is at a spot that no longer exists (${e.spot.key})`);
      if (e.seat.desk) assert.ok(o.scene.build.desks.some((d) => d.id === e.seat.desk && d.tx === e.seat.tx && d.ty === e.seat.ty), `${label}: ${e.id} seat matches a desk`);
      assert.ok(walkable(o, e), `${label}: ${e.id} can walk to the desk`);
    }
    if (R.size > 40) for (const s of o.spots) if (!s.soft) assert.ok(walk(o, [P.ENTRANCE.tx, P.ENTRANCE.ty], (s.via || [s.tx, s.ty]).join(","), null), `${label}: spot ${s.key} reachable from the entrance`);
    // nobody shares a tile at rest, nobody sits on somebody else's desk
    const at = new Map();
    for (const e of o.emps) if (!e.path.length) {
      const k = e.tx + "," + e.ty;
      if (at.has(k) && !e.entering && !(e.act && e.act.kind === "chat") && !(o.emps.find((x) => x.id === at.get(k)).act?.kind === "chat")) assert.fail(`${label}: ${e.id} and ${at.get(k)} share ${k}: ` + JSON.stringify([e, o.emps.find((x) => x.id === at.get(k))].map((x) => ({ id: x.id, st: x.status, seat: x.seat, spot: x.spot && x.spot.key, act: x.act && x.act.kind, meet: x.meet, blocked: o.blocked.has(k), free: o.freeSeats.has(k) }))));
      at.set(k, e.id);
    }
  };

  // --- a desk is moved: the colleague walks to the new chair and sits down there
  {
    const o = fresh(4);
    frames(o, 20);
    const d0 = o.scene.build.desks.find((d) => d.id === o.emps[0].seat.desk);
    const target = P.findPlace(o.scene.items.filter((i) => i.id !== d0.id), { id: d0.id, type: "desk", emp: "e0" }, [16, 13]);
    assert.ok(target && (target.tx !== d0.tx || target.ty !== d0.ty));
    o.applyLayout(doc(o, (items) => items.map((i) => (i.id === d0.id ? { ...i, tx: target.tx, ty: target.ty } : i))));
    sound(o, "desk moved");
    assert.equal(o.emps[0].seat.tx, target.tx);
    assert.equal(o.emps[0].seat.ty, target.ty);
    assert.ok(sits(o, o.emps[0]), "the colleague ends up sitting at the moved desk");
    sound(o, "desk moved, later");
  }
  // --- the fridge is deleted: nobody goes there any more; whoever stood there is let go
  {
    const o = fresh(3);
    const fridge = o.spots.find((s) => s.key === "fridge");
    const e = o.emps[0];
    e.spot = fridge; e.tx = fridge.tx; e.ty = fridge.ty; e.x = fridge.tx * 32; e.y = fridge.ty * 32; e.path = [];
    o.applyLayout(doc(o, (items) => items.filter((i) => i.id !== "fridge")));
    assert.equal(e.spot, null, "the person at the deleted fridge is let go");
    assert.ok(!o.spots.some((s) => s.key === "fridge"), "the fridge spot is gone");
    for (let i = 0; i < 300; i++) assert.notEqual(o.freeSpot(o.emps[1])?.key, "fridge");
    frames(o, 200);
    sound(o, "fridge deleted");
  }
  // --- the sofa moves: its spots move with it; sitting people are re-seated or released
  {
    const o = fresh(3);
    const sofaL = o.spots.find((s) => s.key === "sofaL");
    const e = o.emps[1];
    e.spot = sofaL; e.tx = sofaL.tx; e.ty = sofaL.ty; e.x = sofaL.tx * 32; e.y = sofaL.ty * 32; e.path = [];
    const items = J(o.scene.items);
    const sofa = items.find((i) => i.id === "sofa");
    const spot = P.findPlace(items.filter((i) => i.id !== "sofa"), sofa, [12, 12], { tiles: P.floorTiles(["office"]) });
    assert.ok(spot, "a place for the sofa in the open office");
    o.applyLayout(P.toDoc(items.map((i) => (i.id === "sofa" ? spot : i))));
    const now = o.spots.find((s) => s.key === "sofaL");
    assert.deepEqual([now.tx, now.ty], [spot.tx, spot.ty], "the sofa spot moved with the sofa");
    assert.notEqual(e.spot, sofaL, "the person sitting on the old sofa is let go");
    frames(o, 300);
    sound(o, "sofa moved");
  }
  // --- a meeting is running while the table and chairs move / vanish: nobody is lost
  {
    const o = fresh(6);
    o.setMeeting(o.emps.map((e) => e.id));
    frames(o, 600);
    assert.ok(o.emps.every((e) => e.spot && e.spot.meet), "everybody has a meeting place");
    o.applyLayout(doc(o, (items) => items.filter((i) => i.type !== "meetingChair" && i.id !== "meet")));
    assert.equal(o.meetingSpots.length, 0, "no chairs and no table: no meeting places");
    sound(o, "meeting furniture removed");
    frames(o, 200);
    sound(o, "meeting furniture removed, later");
    const fixed = J(o.scene.items);
    const meet = { id: "meet", type: "meetingTable", tx: 13, ty: 8 };
    o.applyLayout(P.toDoc([...fixed, meet, { id: "ch1", type: "meetingChair", tx: 14, ty: 7, dir: "down" }, { id: "ch2", type: "meetingChair", tx: 14, ty: 10, dir: "up" }]));
    assert.ok(o.meetingSpots.length >= 2, "new furniture, new meeting places");
    frames(o, 900);
    sound(o, "meeting furniture back");
    assert.ok(o.emps.filter((e) => e.spot && e.spot.meet).length >= 2, "and people take them");
    o.setMeeting(null);
    frames(o, 600);
    sound(o, "meeting over");
  }
  // --- an office event and its table / printer
  {
    const o = fresh(4);
    assert.ok(o.startEvent("pizza"), "pizza starts at the round table");
    assert.ok(o.emps.some((e) => e.spot && e.spot.evt), "people gather");
    o.applyLayout(doc(o, (items) => items.filter((i) => i.type !== "roundTable")));
    assert.equal(o.evt, null, "the event ends when its table goes");
    assert.ok(!o.emps.some((e) => e.spot && e.spot.evt), "and nobody is left waiting at it");
    assert.equal(o.startEvent("pizza"), false, "no table: no pizza");
    assert.equal(o.startEvent("cake"), false, "no table: no cake");
    o.applyLayout(doc(o, (items) => items.filter((i) => i.type !== "printer")));
    assert.equal(o.startEvent("printer"), false, "no printer: no jam");
    assert.ok(o.startEvent("blackout"), "a blackout needs no furniture");
    frames(o, 200);
    sound(o, "events without furniture");
    // a table elsewhere and a printer somewhere else: the event follows the furniture
    const o2 = fresh(4);
    const items = J(o2.scene.items);
    const table = P.findPlace(items.filter((i) => i.id !== "table"), items.find((i) => i.id === "table"), [16, 9], { tiles: P.floorTiles(["office"]) });
    o2.applyLayout(P.toDoc(items.map((i) => (i.id === "table" ? table : i))));
    assert.ok(o2.startEvent("cake"));
    assert.ok(o2.emps.filter((e) => e.spot && e.spot.evt).every((e) => Math.abs(e.spot.tx - table.tx) <= 4 && Math.abs(e.spot.ty - table.ty) <= 2), "people gather around the moved table");
  }
  // --- a sick colleague rests on the sofa; the sofa goes
  {
    const o = fresh(3);
    o.setStatus("e0", "sick");
    frames(o, 400);
    assert.ok(o.emps[0].spot && o.emps[0].spot.group === "sofa", "sick colleague on the sofa");
    o.applyLayout(doc(o, (items) => items.filter((i) => i.type !== "sofa")));
    frames(o, 400);
    sound(o, "sofa deleted while somebody is sick");
    assert.ok(!o.emps[0].spot || o.emps[0].spot.anim === "sitfree", "no dangling spot");
  }
  // --- a working colleague keeps heading for a desk that keeps moving
  {
    const o = fresh(3);
    o.setStatus("e2", "working");
    frames(o, 100);
    const d = o.scene.build.desks.find((x) => x.id === o.emps[2].seat.desk);
    for (const [tx, ty] of [[10, 12], [18, 3], [12, 7]]) {
      const items = J(o.scene.items).filter((i) => i.id !== d.id);
      const spot = P.findPlace(items, { id: d.id, type: "desk", emp: "e2" }, [tx, ty]);
      o.applyLayout(P.toDoc([...items, spot]));
      frames(o, 30);
      sound(o, `working colleague, desk to ${tx},${ty}`);
    }
    frames(o, 900);
    assert.ok(o.atSeat(o.emps[2]), "the working colleague ends at the (moved) desk");
  }
  // --- somebody stands where a piece is dropped: set down on a free tile
  {
    const o = fresh(3);
    const e = o.emps[0];
    const tx = 10, ty = 9;
    Object.assign(e, { tx, ty, x: tx * 32, y: ty * 32, path: [], spot: null });
    o.applyLayout(doc(o, (items) => [...items, { id: "bin2", type: "bin", tx, ty }]));
    sound(o, "piece dropped on a person");
    assert.ok(o.blocked.has(tx + "," + ty) && !(e.tx === tx && e.ty === ty), "moved off the new bin");
  }
  // --- random valid edits while people live their lives
  let edits = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const rnd = mulberry(seed * 7919);
    const n = 1 + Math.floor(rnd() * 8);
    const o = fresh(n);
    const ids = o.emps.map((e) => e.id);
    for (const e of o.emps) if (rnd() < 0.3) o.setStatus(e.id, rnd() < 0.5 ? "working" : "sick");
    if (rnd() < 0.3) o.setMeeting(ids.slice(0, Math.max(2, n >> 1)));
    if (rnd() < 0.4) o.startEvent(["pizza", "cake", "printer"][Math.floor(rnd() * 3)]);
    frames(o, 60);
    let items = P.repair(J(o.scene.items), n);
    assert.ok(items, `seed ${seed}: repairable`);
    o.applyLayout(P.toDoc(items));
    for (let step = 0; step < 60; step++) {
      const next = randomEdit(P, items, ids, rnd);
      if (!next) continue;
      items = next; edits++;
      o.applyLayout(P.toDoc(items));
      frames(o, 1 + Math.floor(rnd() * 40));
      sound(o, `fuzz seed ${seed} step ${step}`);
    }
    frames(o, 600);
    sound(o, `fuzz seed ${seed} settled`);
    // everybody who is meant to be at the desk gets there
    for (const e of o.emps) if (e.status === "working" && !e.meet && !o.atSeat(e)) assert.fail(`fuzz seed ${seed}: working ${e.id} not at the desk: ` + JSON.stringify({ tx: e.tx, ty: e.ty, seat: e.seat, path: e.path, spot: e.spot && e.spot.key, act: e.act && e.act.kind, x: e.x, y: e.y, walk: walk(o, [e.tx, e.ty], e.seat.tx + "," + e.seat.ty, e), evt: !!o.evt }));
  }
  console.log(`office safety net ok: layouts changed under walking, sitting, meeting, sick and working colleagues (${edits} random edits)`);
}
