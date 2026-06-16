import test from "node:test";
import assert from "node:assert/strict";
import { SentenceChunker } from "./sentence-chunker";

test("splits two sentences pushed as one token", () => {
  const c = new SentenceChunker();
  assert.deepEqual(c.push("Hola. ¿Qué tal? "), ["Hola.", "¿Qué tal?"]);
  assert.equal(c.flush(), null);
});

test("buffers a partial until the boundary arrives", () => {
  const c = new SentenceChunker();
  assert.deepEqual(c.push("Me llamo"), []);
  assert.deepEqual(c.push(" María. "), ["Me llamo María."]);
});

test("flush returns the trailing partial exactly once", () => {
  const c = new SentenceChunker();
  c.push("Sin punto final");
  assert.equal(c.flush(), "Sin punto final");
  assert.equal(c.flush(), null);
});

test("keeps a closing quote after terminal punctuation", () => {
  const c = new SentenceChunker();
  assert.deepEqual(c.push('Dijo "vale." Y se fue. '), ['Dijo "vale."', "Y se fue."]);
});
