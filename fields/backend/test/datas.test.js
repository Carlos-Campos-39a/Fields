import { test } from "node:test";
import assert from "node:assert/strict";
import { agoraLocal, hojeISO, somarDias } from "../src/lib/datas.js";

test("hojeISO: 01:30 UTC ainda é o dia anterior em Brasília", () => {
  assert.equal(hojeISO(new Date("2026-10-04T01:30:00Z")), "2026-10-03");
});

test("hojeISO: meio da tarde UTC é o mesmo dia", () => {
  assert.equal(hojeISO(new Date("2026-10-03T14:00:00Z")), "2026-10-03");
});

test("hojeISO: virada exata — 03:00 UTC já é o dia seguinte", () => {
  assert.equal(hojeISO(new Date("2026-10-04T02:59:59Z")), "2026-10-03");
  assert.equal(hojeISO(new Date("2026-10-04T03:00:00Z")), "2026-10-04");
});

test("hojeISO não depende do TZ do processo", () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = "Asia/Tokyo";
    assert.equal(hojeISO(new Date("2026-10-04T01:30:00Z")), "2026-10-03");
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
});

test("agoraLocal devolve data e hora de parede em Brasília (h23)", () => {
  assert.deepEqual(agoraLocal(new Date("2026-10-04T03:05:09Z")), { data: "2026-10-04", hora: "00:05", segundos: "09" });
  assert.deepEqual(agoraLocal(new Date("2026-10-03T14:00:00Z")), { data: "2026-10-03", hora: "11:00", segundos: "00" });
});

test("somarDias atravessa fim de mês, de ano e o 29 de fevereiro", () => {
  assert.equal(somarDias("2026-10-31", 1), "2026-11-01");
  assert.equal(somarDias("2026-10-03", 7), "2026-10-10");
  assert.equal(somarDias("2026-12-31", 1), "2027-01-01");
  assert.equal(somarDias("2028-02-28", 1), "2028-02-29");
  assert.equal(somarDias("2026-03-01", -1), "2026-02-28");
  assert.equal(somarDias("2026-10-03", 0), "2026-10-03");
});

test("somarDias recusa entrada que não é data de calendário", () => {
  assert.throws(() => somarDias("03/10/2026", 1), TypeError);
  assert.throws(() => somarDias("2026-10-03", 1.5), TypeError);
});
