import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('frontend calls the exact Netlify Function path directly', () => {
  const frontend = fs.readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
  assert.match(frontend, /const ENDPOINT = '\/\.netlify\/functions\/game'/);
  assert.doesNotMatch(frontend, /socket\.io|config\.path|\/api\/game/);
});

test('Netlify function is at the required path and uses strongly consistent Blobs', () => {
  const functionSource = fs.readFileSync(new URL('../netlify/functions/game.ts', import.meta.url), 'utf8');
  const config = fs.readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  assert.match(functionSource, /getStore\(\{\s*name: 'quiz-battle-state', consistency: 'strong'\s*\}\)/);
  assert.match(functionSource, /createGameHandler/);
  assert.match(config, /functions = "netlify\/functions"/);
  assert.doesNotMatch(config, /config\.path|\/api\/game/);
  assert.ok(fs.existsSync(new URL('../src/server/game-core.js', import.meta.url)), 'shared helper must remain outside netlify/functions');
});
